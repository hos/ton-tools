import { abbreviateAddress } from "../core/address";
import { errorMessage } from "../core/errors";
import { type AddressState, completeUpTo, type TxRecord, toIndexedTx } from "../core/types";
import { Metrics } from "../metrics/metrics";
import type { Store } from "../stores/store";
import { exponentialBackoff } from "../util/backoff";
import { type Logger, silentLogger } from "../util/logger";
import type { ConsumerStatus, ConsumerWakeEvents, ProcessOptions, TxHandler } from "./types";

type ConsumerSettings = Required<Omit<ProcessOptions, "addresses">>;

const DEFAULT_SETTINGS: ConsumerSettings = {
  from: "start",
  order: "address",
  batchSize: 100,
  concurrency: 8,
  pollMs: 1_000,
  retryMinMs: 1_000,
  retryMaxMs: 60_000,
  transactional: true,
};

/** Delivery state of one address for this consumer. */
interface Lane {
  address: string;
  /** Lt of the last delivered transaction; null until read from the store. */
  cursor: bigint | null;
  failures: number;
  /** Halted until this time (ms) after a handler failure. */
  notBefore: number;
  lastError?: unknown;
}

/** Read-ahead of one address in global order. */
interface ReadBuffer {
  state: AddressState;
  items: TxRecord[];
  /** The store had nothing more below the watermark. */
  exhausted: boolean;
}

export interface ConsumerDeps {
  /** Wake up on these instead of waiting for the next poll. */
  events?: ConsumerWakeEvents;
  logger?: Logger;
  metrics?: Metrics;
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
  private readonly settings: ConsumerSettings;
  /** Raw addresses to deliver; null for all. */
  private readonly onlyAddresses: Set<string> | null;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly lanes = new Map<string, Lane>();
  private running = false;
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  /** Something changed while a round was running: start another right away. */
  private wakePending = false;
  private delivered = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    name: string,
    store: Store,
    handler: TxHandler,
    options: ProcessOptions = {},
    deps: ConsumerDeps = {},
  ) {
    this.name = name;
    this.store = store;
    this.handler = handler;
    this.onlyAddresses = options.addresses ? new Set(options.addresses) : null;
    this.settings = {
      from: options.from ?? DEFAULT_SETTINGS.from,
      order: options.order ?? DEFAULT_SETTINGS.order,
      batchSize: options.batchSize ?? DEFAULT_SETTINGS.batchSize,
      concurrency: options.concurrency ?? DEFAULT_SETTINGS.concurrency,
      pollMs: options.pollMs ?? DEFAULT_SETTINGS.pollMs,
      retryMinMs: options.retryMinMs ?? DEFAULT_SETTINGS.retryMinMs,
      retryMaxMs: options.retryMaxMs ?? DEFAULT_SETTINGS.retryMaxMs,
      transactional: options.transactional ?? DEFAULT_SETTINGS.transactional,
    };
    this.logger = deps.logger ?? silentLogger;
    this.metrics = deps.metrics ?? new Metrics();
    const events = deps.events;
    if (events) {
      const wake = () => this.wake();
      events.on("frontier", wake);
      events.on("synced", wake);
      this.unsubscribe = () => {
        events.off("frontier", wake);
        events.off("synced", wake);
      };
    }
  }

  /** Starts delivering in the background. */
  start(): this {
    if (this.running) return this;
    this.running = true;
    this.loop = this.runLoop();
    return this;
  }

  /** Stops after the transaction being handled (if any) is committed. */
  async stop(): Promise<void> {
    this.running = false;
    this.unsubscribe?.();
    this.wake();
    await this.loop;
  }

  /** Looks for new transactions now instead of at the next poll. */
  wake(): void {
    this.wakePending = true;
    this.wakeUp?.();
  }

  status(): ConsumerStatus {
    const now = Date.now();
    return {
      name: this.name,
      running: this.running,
      delivered: this.delivered,
      addresses: [...this.lanes.values()].map((lane) => ({
        address: lane.address,
        cursor: lane.cursor,
        halted: lane.notBefore > now,
        failures: lane.failures,
        lastError: lane.lastError ? errorMessage(lane.lastError) : undefined,
      })),
    };
  }

  /** Runs one delivery round. Resolves to the number of transactions delivered. */
  async runOnce(): Promise<number> {
    const states = (await this.store.listAddresses()).filter(
      (state) => !this.onlyAddresses || this.onlyAddresses.has(state.address),
    );
    for (const { address } of states) {
      if (!this.lanes.has(address)) {
        this.lanes.set(address, { address, cursor: null, failures: 0, notBefore: 0 });
      }
    }
    return this.settings.order === "global"
      ? this.deliverGlobal(states)
      : this.deliverPerAddress(states);
  }

  /**
   * A round keeps delivering while the consumer runs. A `runOnce()` call outside
   * `start()` always completes its round; once started, `stop()` ends it early.
   */
  private shouldContinue(): boolean {
    return this.running || this.loop === null;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      this.wakePending = false;
      let delivered = 0;
      try {
        delivered = await this.runOnce();
      } catch (error) {
        this.logger.warn(`consumer ${this.name}: round failed:`, errorMessage(error));
      }
      if (!this.running) break;
      if (delivered > 0 || this.wakePending) continue;
      await this.sleepUntilWoken(Math.min(this.settings.pollMs, this.msUntilNextRetry()));
    }
  }

  /** Time until the earliest halted lane may retry; Infinity if none is halted. */
  private msUntilNextRetry(): number {
    const now = Date.now();
    const halted = [...this.lanes.values()].filter((lane) => lane.notBefore > now);
    if (halted.length === 0) return Number.POSITIVE_INFINITY;
    return Math.min(...halted.map((lane) => lane.notBefore)) - Date.now();
  }

  private async sleepUntilWoken(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(1, ms));
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wakeUp = null;
  }

  /** The lane's position, loading or initializing (and persisting) it on first use. */
  private async cursorFor(lane: Lane, state: AddressState): Promise<bigint> {
    if (lane.cursor !== null) return lane.cursor;
    let cursor = await this.store.getCursor(this.name, state.address);
    if (cursor === null) {
      cursor = this.initialCursor(state);
      // Persist so a restart does not re-resolve "now" to a later point.
      await this.store.setCursor(this.name, state.address, cursor);
    }
    lane.cursor = cursor;
    return cursor;
  }

  private initialCursor(state: AddressState): bigint {
    const { from } = this.settings;
    if (from === "start") return state.startLt;
    if (from === "now") return state.frontier?.lt ?? state.startLt;
    return from;
  }

  /** Hands one transaction to the handler and commits the cursor. False if the handler failed. */
  private async deliver(lane: Lane, record: TxRecord): Promise<boolean> {
    const tx = toIndexedTx(record);
    try {
      if (this.settings.transactional && this.store.transaction) {
        await this.store.transaction(async ({ store, db }) => {
          await this.handler(tx, { consumer: this.name, address: lane.address, db });
          await store.setCursor(this.name, lane.address, record.lt);
        });
      } else {
        await this.handler(tx, { consumer: this.name, address: lane.address });
        await this.store.setCursor(this.name, lane.address, record.lt);
      }
    } catch (error) {
      this.halt(lane, record, error);
      return false;
    }
    lane.cursor = record.lt;
    lane.failures = 0;
    lane.lastError = undefined;
    this.delivered++;
    this.metrics.inc("ton_watch_consumer_delivered_total", { consumer: this.name });
    return true;
  }

  private halt(lane: Lane, record: TxRecord, error: unknown): void {
    lane.failures++;
    lane.lastError = error;
    const delay = exponentialBackoff(
      lane.failures,
      this.settings.retryMinMs,
      this.settings.retryMaxMs,
    );
    lane.notBefore = Date.now() + delay;
    this.metrics.inc("ton_watch_consumer_errors_total", { consumer: this.name });
    this.logger.warn(
      `consumer ${this.name} [${abbreviateAddress(lane.address)}] failed at lt ${record.lt}, retry in ${Math.round(delay / 1000)}s:`,
      errorMessage(error),
    );
  }

  /** Each address up to its own frontier, `concurrency` addresses at a time. */
  private async deliverPerAddress(states: AddressState[]): Promise<number> {
    const now = Date.now();
    const ready = states.filter(
      (state) => state.frontier && this.lanes.get(state.address)!.notBefore <= now,
    );
    let total = 0;
    let next = 0;
    const worker = async () => {
      while (this.shouldContinue()) {
        const state = ready[next++];
        if (!state) return;
        const lane = this.lanes.get(state.address)!;
        const cursor = await this.cursorFor(lane, state);
        const uptoLt = state.frontier!.lt;
        if (cursor >= uptoLt) continue;
        const batch = await this.store.read(state.address, cursor, uptoLt, this.settings.batchSize);
        for (const record of batch) {
          if (!this.shouldContinue()) return;
          if (!(await this.deliver(lane, record))) break;
          total++;
        }
      }
    };
    const workers = Math.min(this.settings.concurrency, ready.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return total;
  }

  /**
   * All addresses merged by (lt, address), up to the watermark: the lowest point
   * up to which every address is known complete. Any halted address halts all.
   */
  private async deliverGlobal(states: AddressState[]): Promise<number> {
    if (states.length === 0) return 0;
    const now = Date.now();
    if ([...this.lanes.values()].some((lane) => lane.notBefore > now)) return 0;
    const watermark = states.map(completeUpTo).reduce((min, lt) => (lt < min ? lt : min));
    this.metrics.set("ton_watch_consumer_watermark_lt", Number(watermark), {
      consumer: this.name,
    });

    const buffers = new Map<string, ReadBuffer>();
    const fill = async (state: AddressState) => {
      const lane = this.lanes.get(state.address)!;
      const cursor = await this.cursorFor(lane, state);
      const items =
        cursor < watermark
          ? await this.store.read(state.address, cursor, watermark, this.settings.batchSize)
          : [];
      buffers.set(state.address, {
        state,
        items,
        exhausted: items.length < this.settings.batchSize,
      });
    };
    await Promise.all(states.map(fill));

    let total = 0;
    while (this.shouldContinue()) {
      const buffer = earliestBuffered(states, buffers);
      if (!buffer) break;
      const record = buffer.items[0]!;
      if (!(await this.deliver(this.lanes.get(record.address)!, record))) break;
      total++;
      buffer.items.shift();
      if (buffer.items.length === 0 && !buffer.exhausted) await fill(buffer.state);
    }
    return total;
  }
}

/** The buffer whose next transaction comes first in (lt, address) order. */
function earliestBuffered(
  states: AddressState[],
  buffers: Map<string, ReadBuffer>,
): ReadBuffer | null {
  let best: ReadBuffer | null = null;
  for (const { address } of states) {
    const buffer = buffers.get(address)!;
    const head = buffer.items[0];
    if (!head) continue;
    const bestHead = best?.items[0];
    if (
      !bestHead ||
      head.lt < bestHead.lt ||
      (head.lt === bestHead.lt && head.address < bestHead.address)
    ) {
      best = buffer;
    }
  }
  return best;
}
