import type { EventEmitter } from "node:events";

import { silentLogger, type Logger } from "./logger";
import { Metrics } from "./metrics";
import type { Store } from "./stores/store";
import { toFriendlyAddress } from "./ton";
import { completeUpTo, toIndexedTx, type AddressState, type IndexedTx, type TxRecord } from "./types";

export interface HandlerContext {
  consumer: string;
  address: string;
  /**
   * With a transactional store (`PgStore`), the database transaction the cursor is
   * committed in. Write your own effects through it and they commit exactly once
   * together with the delivery position.
   */
  db?: unknown;
}

export type TxHandler = (tx: IndexedTx, ctx: HandlerContext) => Promise<void> | void;

export interface ProcessOptions {
  /**
   * Where to begin for an address this consumer has not seen before:
   * `"start"` (default) everything since the address's startLt, `"now"` only what is
   * indexed after this point, or an lt (exclusive). Ignored once a position is stored.
   */
  from?: "start" | "now" | bigint;
  /** Raw or friendly addresses; default every tracked address, including ones added later. */
  addresses?: string[];
  /**
   * `"address"` (default): each address in lt order, addresses independent of each
   * other. `"global"`: one stream in (lt, address) order, released up to the
   * watermark — the lowest complete-up-to point among the addresses.
   */
  order?: "address" | "global";
  batchSize?: number;
  /** Addresses processed in parallel in `"address"` order. Default 8. */
  concurrency?: number;
  /** How often to look for new data when no indexer event arrives. Default 1000ms. */
  pollMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Commit handler effects and cursor atomically when the store supports it. Default true. */
  transactional?: boolean;
}

interface Lane {
  address: string;
  cursor: bigint | null;
  failures: number;
  notBefore: number;
  lastError?: unknown;
}

export interface ConsumerStatus {
  name: string;
  running: boolean;
  delivered: number;
  addresses: {
    address: string;
    cursor: bigint | null;
    /** Waiting to retry a failed handler. */
    halted: boolean;
    failures: number;
    lastError?: string;
  }[];
}

/**
 * Hands indexed transactions to a handler strictly in chain order, never past a
 * gap, and persists the position after each one so restarts resume where they
 * stopped. A failing handler stops its address (or, in global order, the whole
 * stream) and is retried with backoff; nothing is ever skipped.
 */
export class Consumer {
  readonly name: string;
  private readonly store: Store;
  private readonly handler: TxHandler;
  private readonly o: Required<Omit<ProcessOptions, "addresses" | "from">> & {
    from: "start" | "now" | bigint;
  };
  private readonly only: Set<string> | null;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private lanes = new Map<string, Lane>();
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private pending = false;
  private delivered = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    name: string,
    store: Store,
    handler: TxHandler,
    options: ProcessOptions & { addresses?: string[] } = {},
    deps: { events?: EventEmitter; logger?: Logger; metrics?: Metrics } = {}
  ) {
    this.name = name;
    this.store = store;
    this.handler = handler;
    this.only = options.addresses ? new Set(options.addresses) : null;
    this.o = {
      from: options.from ?? "start",
      order: options.order ?? "address",
      batchSize: options.batchSize ?? 100,
      concurrency: options.concurrency ?? 8,
      pollMs: options.pollMs ?? 1000,
      retryMinMs: options.retryMinMs ?? 1000,
      retryMaxMs: options.retryMaxMs ?? 60_000,
      transactional: options.transactional ?? true,
    };
    this.logger = deps.logger ?? silentLogger;
    this.metrics = deps.metrics ?? new Metrics();
    if (deps.events) {
      const wake = () => this.wake();
      deps.events.on("frontier", wake);
      deps.events.on("synced", wake);
      this.unsubscribe = () => {
        deps.events!.off("frontier", wake);
        deps.events!.off("synced", wake);
      };
    }
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.loopPromise = this.loop();
    return this;
  }

  /** Stops after the transaction being handled (if any) is committed. */
  async stop() {
    this.running = false;
    this.unsubscribe?.();
    this.wake();
    await this.loopPromise;
  }

  wake() {
    this.pending = true;
    this.wakeUp?.();
  }

  status(): ConsumerStatus {
    const now = Date.now();
    return {
      name: this.name,
      running: this.running,
      delivered: this.delivered,
      addresses: [...this.lanes.values()].map((l) => ({
        address: l.address,
        cursor: l.cursor,
        halted: l.notBefore > now,
        failures: l.failures,
        lastError: l.lastError ? String((l.lastError as Error)?.message ?? l.lastError) : undefined,
      })),
    };
  }

  /** Runs one delivery round. Resolves to the number of transactions delivered. */
  async runOnce(): Promise<number> {
    const states = (await this.store.listAddresses()).filter(
      (s) => !this.only || this.only.has(s.address)
    );
    for (const s of states) {
      if (!this.lanes.has(s.address)) {
        this.lanes.set(s.address, { address: s.address, cursor: null, failures: 0, notBefore: 0 });
      }
    }
    return this.o.order === "global" ? this.roundGlobal(states) : this.roundPerAddress(states);
  }

  private async loop() {
    while (this.running) {
      this.pending = false;
      let delivered = 0;
      try {
        delivered = await this.runOnce();
      } catch (e) {
        this.logger.warn(`consumer ${this.name}: round failed:`, (e as Error)?.message ?? e);
      }
      if (!this.running) break;
      if (delivered > 0 || this.pending) continue;
      const halted = [...this.lanes.values()].filter((l) => l.notBefore > Date.now());
      const nextRetry = halted.length ? Math.min(...halted.map((l) => l.notBefore)) - Date.now() : Infinity;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, Math.min(this.o.pollMs, nextRetry)));
        this.wakeUp = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeUp = null;
    }
  }

  private async cursorFor(lane: Lane, state: AddressState): Promise<bigint> {
    if (lane.cursor !== null) return lane.cursor;
    let cursor = await this.store.getCursor(this.name, state.address);
    if (cursor === null) {
      const from = this.o.from;
      cursor =
        from === "start"
          ? state.startLt
          : from === "now"
            ? (state.frontier?.lt ?? state.startLt)
            : from;
      // Persist so a restart does not re-resolve "now" to a later point.
      await this.store.setCursor(this.name, state.address, cursor);
    }
    lane.cursor = cursor;
    return cursor;
  }

  private async deliver(lane: Lane, record: TxRecord): Promise<boolean> {
    const tx = toIndexedTx(record);
    try {
      if (this.o.transactional && this.store.transaction) {
        await this.store.transaction(async ({ store, db }) => {
          await this.handler(tx, { consumer: this.name, address: lane.address, db });
          await store.setCursor(this.name, lane.address, record.lt);
        });
      } else {
        await this.handler(tx, { consumer: this.name, address: lane.address });
        await this.store.setCursor(this.name, lane.address, record.lt);
      }
    } catch (e) {
      lane.failures++;
      lane.lastError = e;
      const delay = Math.min(this.o.retryMaxMs, this.o.retryMinMs * 2 ** (lane.failures - 1));
      lane.notBefore = Date.now() + delay;
      this.metrics.inc("ton_watch_consumer_errors_total", { consumer: this.name });
      this.logger.warn(
        `consumer ${this.name} [${toFriendlyAddress(lane.address)}] failed at lt ${record.lt}, retry in ${Math.round(delay / 1000)}s:`,
        (e as Error)?.message ?? e
      );
      return false;
    }
    lane.cursor = record.lt;
    lane.failures = 0;
    lane.lastError = undefined;
    this.delivered++;
    this.metrics.inc("ton_watch_consumer_delivered_total", { consumer: this.name });
    return true;
  }

  private async roundPerAddress(states: AddressState[]): Promise<number> {
    const now = Date.now();
    const ready = states.filter((s) => s.frontier && this.lanes.get(s.address)!.notBefore <= now);
    let total = 0;
    let i = 0;
    const worker = async () => {
      while (this.running || this.loopPromise === null) {
        const state = ready[i++];
        if (!state) return;
        const lane = this.lanes.get(state.address)!;
        const cursor = await this.cursorFor(lane, state);
        const upto = state.frontier!.lt;
        if (cursor >= upto) continue;
        const batch = await this.store.read(state.address, cursor, upto, this.o.batchSize);
        for (const record of batch) {
          if (this.loopPromise !== null && !this.running) return;
          if (!(await this.deliver(lane, record))) break;
          total++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.o.concurrency, ready.length) }, worker));
    return total;
  }

  private async roundGlobal(states: AddressState[]): Promise<number> {
    if (states.length === 0) return 0;
    const now = Date.now();
    if ([...this.lanes.values()].some((l) => l.notBefore > now)) return 0;
    const watermark = states.reduce((min, s) => {
      const c = completeUpTo(s);
      return c < min ? c : min;
    }, completeUpTo(states[0]!));
    this.metrics.set("ton_watch_consumer_watermark_lt", Number(watermark), { consumer: this.name });

    const buffers = new Map<string, { items: TxRecord[]; done: boolean }>();
    const fill = async (state: AddressState) => {
      const lane = this.lanes.get(state.address)!;
      const cursor = await this.cursorFor(lane, state);
      const items = cursor < watermark
        ? await this.store.read(state.address, cursor, watermark, this.o.batchSize)
        : [];
      buffers.set(state.address, { items, done: items.length < this.o.batchSize });
    };
    await Promise.all(states.map(fill));

    let total = 0;
    while (this.running || this.loopPromise === null) {
      let pick: TxRecord | null = null;
      for (const s of states) {
        const head = buffers.get(s.address)!.items[0];
        if (head && (!pick || head.lt < pick.lt || (head.lt === pick.lt && head.address < pick.address))) {
          pick = head;
        }
      }
      if (!pick) break;
      const lane = this.lanes.get(pick.address)!;
      if (!(await this.deliver(lane, pick))) break;
      total++;
      const buf = buffers.get(pick.address)!;
      buf.items.shift();
      if (buf.items.length === 0 && !buf.done) await fill(states.find((s) => s.address === pick!.address)!);
    }
    return total;
  }
}
