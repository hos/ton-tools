import { EventEmitter } from "node:events";

import { validatePage } from "./chain";
import { classifyError, type ErrorKind } from "./errors";
import { silentLogger, type Logger } from "./logger";
import { Metrics } from "./metrics";
import type { ChainTip, TxSource } from "./source/source";
import type { Store } from "./stores/store";
import { toFriendlyAddress } from "./ton";
import { txIdEquals, type AddressState, type TxId } from "./types";

export type DetectMode = "poll" | "blocks" | "auto";

export interface IndexerOptions {
  store: Store;
  source: TxSource;
  /** Pages fetched in parallel across all addresses and ranges. Default 16. */
  concurrency?: number;
  /** How often to look at the chain tip. Default 1000ms. */
  tickMs?: number;
  /**
   * How to find addresses with new transactions:
   * - `poll`: one account-state call per address, idle addresses polled less often.
   * - `blocks`: list the transactions of every new shard block once and match
   *   watched addresses; cost does not grow with the number of addresses.
   * - `auto` (default): `blocks` from `autoBlocksThreshold` addresses on.
   */
  detect?: DetectMode;
  autoBlocksThreshold?: number;
  /** Poll mode: an address that keeps not changing is polled at most this rarely. Default 30s. */
  maxIdlePollMs?: number;
  /** Every address is rescanned for gaps this often (changed ones every tick). Default 60s. */
  gapScanMs?: number;
  /** Retry delay bounds for a failing range fetch. */
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Retry delay for history no server can serve (archive miss). Default 10 min. */
  archiveRetryMs?: number;
  /**
   * Cut long missing ranges into parallel pieces (needs `source.findTxNear`).
   * A range estimated at `minTxs` or more is split into parts of about
   * `targetTxs`, at most `maxParts`. `false` disables it.
   */
  split?: { minTxs?: number; targetTxs?: number; maxParts?: number } | false;
  /** Export per-address gauges (lag, gaps). Default true. */
  addressMetrics?: boolean;
  metrics?: Metrics;
  logger?: Logger;
}

interface Walk {
  id: number;
  address: string;
  kind: "head" | "gap";
  /** Next transaction to fetch (newest first). */
  cursor: TxId;
  /** Stop once the chain reaches this lt (it is stored or out of scope). */
  floorLt: bigint;
  /** Where the walk started; everything in (floorLt, topLt] is this walk's job. */
  topLt: bigint;
  pages: number;
  /** Transactions received so far (density estimate for splitting). */
  fetched: number;
  /** Already split, or a piece of a split. */
  split: boolean;
  failures: number;
  lastError?: ErrorKind;
  notBefore: number;
  running: boolean;
}

/** Repeatedly asked for history that no server (including archival ones) has. */
const isParked = (w: Walk) => w.lastError === "archive_unavailable" && w.failures > 3;

interface Known {
  /** On-chain last transaction as of a tip. */
  last: TxId | null;
  syncLt: bigint;
  utime: number;
}

interface Runtime {
  state: AddressState;
  known?: Known;
  nextPollAt: number;
  idleStreak: number;
  dirty: boolean;
  gapsOpen: number;
}

export interface AddressStatus {
  address: string;
  head: bigint | null;
  frontier: bigint | null;
  syncedLt: bigint;
  /** Seconds between the chain tip and the last time the address was known complete. */
  lagSeconds: number | null;
  gapsOpen: number;
  walks: number;
  /** Walks waiting on history no server could serve. */
  stuck: number;
}

export class Indexer extends EventEmitter {
  readonly store: Store;
  readonly source: TxSource;
  readonly metrics: Metrics;
  private readonly logger: Logger;
  private readonly o: Required<
    Omit<IndexerOptions, "store" | "source" | "metrics" | "logger" | "split">
  >;
  private readonly split: { minTxs: number; targetTxs: number; maxParts: number } | null;

  private runtimes = new Map<string, Runtime>();
  private walks = new Map<number, Walk>();
  private walkSeq = 0;
  private inFlight = 0;
  private tip: ChainTip | null = null;
  private lastDetectTip: ChainTip | null = null;
  private lastFullGapScan = 0;
  private running = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private tickPromise: Promise<void> | null = null;
  private idleWaiters: (() => void)[] = [];
  private blocksVerified = false;
  lastTickAt = 0;

  constructor(options: IndexerOptions) {
    super();
    this.store = options.store;
    this.source = options.source;
    this.metrics = options.metrics ?? options.source.metrics ?? new Metrics();
    this.logger = options.logger ?? silentLogger;
    this.o = {
      concurrency: options.concurrency ?? 16,
      tickMs: options.tickMs ?? 1000,
      detect: options.detect ?? "auto",
      autoBlocksThreshold: options.autoBlocksThreshold ?? 50,
      maxIdlePollMs: options.maxIdlePollMs ?? 30_000,
      gapScanMs: options.gapScanMs ?? 60_000,
      retryMinMs: options.retryMinMs ?? 1_000,
      retryMaxMs: options.retryMaxMs ?? 60_000,
      archiveRetryMs: options.archiveRetryMs ?? 600_000,
      addressMetrics: options.addressMetrics ?? true,
    };
    this.split =
      options.split === false || !options.source.findTxNear
        ? null
        : {
            minTxs: options.split?.minTxs ?? 1_000,
            targetTxs: options.split?.targetTxs ?? 400,
            maxParts: options.split?.maxParts ?? 32,
          };
  }

  get chainTip() {
    return this.tip;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      this.tickPromise = this.tick().catch((e) => {
        this.metrics.error(classifyError(e), "tick");
        this.logger.warn("tick failed:", (e as Error)?.message ?? e);
      });
      await this.tickPromise;
      this.tickPromise = null;
      if (this.running) this.tickTimer = setTimeout(loop, this.o.tickMs);
    };
    void loop();
  }

  /** Stops ticking and waits for pages in flight to finish. */
  async stop() {
    this.running = false;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    await this.tickPromise;
    while (this.inFlight > 0) await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  /** One detection + maintenance round. Exposed for tests and one-shot tools. */
  async tick() {
    const tip = await this.source.getTip();
    this.tip = tip;
    this.lastTickAt = Date.now();
    this.metrics.set("ton_watch_tip_seqno", tip.seqno);
    this.metrics.set("ton_watch_tip_utime", tip.utime);

    await this.refreshAddresses();
    if (!this.lastDetectTip || tip.seqno !== this.lastDetectTip.seqno) {
      await this.detect(tip);
      this.lastDetectTip = tip;
    } else {
      // Same block: only addresses without a verified starting point (new, or failed).
      await this.pollAddresses(
        [...this.runtimes.values()].filter((rt) => !rt.known),
        tip
      );
    }
    this.scheduleHeads();
    await this.maintain();
    await this.markSynced();
    this.updateGauges();
    this.pump();
    this.emit("tick", tip);
  }

  /** Resolves once no range fetch is queued or in flight (parked archive misses excluded). */
  async drain(): Promise<void> {
    for (;;) {
      const pending = [...this.walks.values()].filter(
        (w) => w.running || (!isParked(w) && w.failures < 5)
      );
      if (pending.length === 0 && this.inFlight === 0) return;
      await new Promise<void>((r) => {
        this.idleWaiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  /** Ticks and drains until every address is complete up to the tip (or `maxRounds`). */
  async syncOnce(maxRounds = 1000) {
    for (let i = 0; i < maxRounds; i++) {
      try {
        await this.tick();
      } catch (e) {
        this.metrics.error(classifyError(e), "tick");
        continue;
      }
      await this.drain();
      await this.maintain(true);
      await this.refreshAddresses();
      await this.markSynced();
      if ([...this.runtimes.values()].some((rt) => !rt.known)) continue;
      if ([...this.walks.values()].every(isParked)) return;
    }
  }

  status(): AddressStatus[] {
    return [...this.runtimes.values()].map((rt) => this.addressStatus(rt));
  }

  private addressStatus(rt: Runtime): AddressStatus {
    const walks = [...this.walks.values()].filter((w) => w.address === rt.state.address);
    return {
      address: rt.state.address,
      head: rt.state.head?.lt ?? null,
      frontier: rt.state.frontier?.lt ?? null,
      syncedLt: rt.state.syncedLt,
      lagSeconds:
        this.tip && rt.state.syncedUtime != null
          ? Math.max(0, this.tip.utime - rt.state.syncedUtime)
          : null,
      gapsOpen: rt.gapsOpen,
      walks: walks.length,
      stuck: walks.filter(isParked).length,
    };
  }

  // --- address set -------------------------------------------------------

  private async refreshAddresses() {
    const states = await this.store.listAddresses();
    const seen = new Set<string>();
    for (const state of states) {
      seen.add(state.address);
      const rt = this.runtimes.get(state.address);
      if (rt) rt.state = state;
      else {
        this.runtimes.set(state.address, {
          state,
          nextPollAt: 0,
          idleStreak: 0,
          dirty: true,
          gapsOpen: 0,
        });
      }
    }
    for (const address of [...this.runtimes.keys()]) {
      if (seen.has(address)) continue;
      this.runtimes.delete(address);
      for (const [id, w] of this.walks) if (w.address === address && !w.running) this.walks.delete(id);
      if (this.o.addressMetrics) this.metrics.clearGauges(`ton_watch_address_`);
    }
  }

  // --- change detection --------------------------------------------------

  private useBlocks(): boolean {
    if (!this.source.getTouchedAccounts) return false;
    if (this.o.detect === "blocks") return true;
    if (this.o.detect === "poll") return false;
    return this.runtimes.size >= this.o.autoBlocksThreshold;
  }

  private async detect(tip: ChainTip) {
    const now = Date.now();
    let toPoll: Runtime[];

    if (this.useBlocks() && this.lastDetectTip && this.blocksVerified) {
      const workchains = new Set(
        [...this.runtimes.keys()].map((a) => Number(a.split(":")[0]))
      );
      let touched: Map<string, TxId> | null = null;
      try {
        touched = await this.source.getTouchedAccounts!(this.lastDetectTip, tip, workchains);
      } catch (e) {
        this.metrics.error(classifyError(e), "getTouchedAccounts");
        this.logger.warn("block listing failed, polling instead:", (e as Error)?.message);
      }
      if (touched) {
        toPoll = [];
        for (const rt of this.runtimes.values()) {
          if (!rt.known) {
            toPoll.push(rt);
            continue;
          }
          const hit = touched.get(rt.state.address);
          if (hit && (!rt.known.last || hit.lt > rt.known.last.lt)) rt.known.last = hit;
          rt.known.syncLt = tip.syncLt;
          rt.known.utime = tip.utime;
        }
      } else {
        this.metrics.inc("ton_watch_detect_fallbacks_total");
        toPoll = [...this.runtimes.values()];
      }
    } else {
      const blocks = this.useBlocks();
      toPoll = [...this.runtimes.values()].filter(
        (rt) => blocks || !rt.known || rt.nextPollAt <= now
      );
    }

    const ok = await this.pollAddresses(toPoll, tip);
    // Block listing is only trusted once every address has a verified starting point.
    if (this.useBlocks()) this.blocksVerified = ok;
  }

  private async pollAddresses(runtimes: Runtime[], tip: ChainTip): Promise<boolean> {
    const now = Date.now();
    const results = await this.mapLimit(runtimes, async (rt) => {
      try {
        const last = await this.source.getLastTx(rt.state.address, tip);
        const changed = !rt.known || !txIdEquals(rt.known.last, last);
        rt.known = { last, syncLt: tip.syncLt, utime: tip.utime };
        rt.idleStreak = changed ? 0 : rt.idleStreak + 1;
        rt.nextPollAt =
          now + Math.min(this.o.maxIdlePollMs, this.o.tickMs * (2 ** rt.idleStreak - 1));
        return true;
      } catch (e) {
        this.metrics.error(classifyError(e), "getLastTx");
        return false;
      }
    });
    return results.every(Boolean);
  }

  private scheduleHeads() {
    for (const rt of this.runtimes.values()) {
      const last = rt.known?.last;
      if (!last) continue;
      const top = this.claimedTop(rt);
      if (last.lt <= top) continue;
      this.addWalk({
        address: rt.state.address,
        kind: "head",
        cursor: last,
        floorLt: top,
        topLt: last.lt,
      });
    }
  }

  /** Highest lt that is stored or being fetched for this address. */
  private claimedTop(rt: Runtime): bigint {
    let top = rt.state.head?.lt ?? rt.state.startLt;
    if (top < rt.state.startLt) top = rt.state.startLt;
    for (const w of this.walks.values()) {
      if (w.address === rt.state.address && w.topLt > top) top = w.topLt;
    }
    return top;
  }

  // --- gaps & frontier ---------------------------------------------------

  private async maintain(all = false) {
    const now = Date.now();
    const full = all || now - this.lastFullGapScan >= this.o.gapScanMs;
    if (full) this.lastFullGapScan = now;
    const targets = [...this.runtimes.values()].filter((rt) => full || rt.dirty);
    await this.mapLimit(targets, async (rt) => {
      rt.dirty = false;
      const address = rt.state.address;
      try {
        const before = rt.state.frontier?.lt;
        const frontier = await this.store.advanceFrontier(address);
        rt.state.frontier = frontier;
        if (frontier && frontier.lt !== before) this.emit("frontier", address, frontier.lt);
        const gaps = await this.store.findGaps(address, 50);
        rt.gapsOpen = gaps.length;
        for (const gap of gaps) {
          const covered = [...this.walks.values()].some(
            (w) => w.address === address && w.floorLt < gap.prevLt && gap.prevLt <= w.topLt
          );
          if (covered) continue;
          this.addWalk({
            address,
            kind: "gap",
            cursor: { lt: gap.prevLt, hash: gap.prevHash },
            floorLt: gap.floorLt,
            topLt: gap.prevLt,
          });
        }
      } catch (e) {
        rt.dirty = true;
        this.metrics.error(classifyError(e), "maintain");
        this.logger.warn(`[${toFriendlyAddress(address)}] maintenance failed:`, (e as Error)?.message);
      }
    });
  }

  private async markSynced() {
    const groups = new Map<string, { syncLt: bigint; utime: number; addresses: string[] }>();
    for (const rt of this.runtimes.values()) {
      const k = rt.known;
      if (!k) continue;
      const address = rt.state.address;
      if ([...this.walks.values()].some((w) => w.address === address)) continue;
      const head = rt.state.head;
      const lastInScope = k.last && k.last.lt > rt.state.startLt ? k.last : null;
      // Everything up to the on-chain last tx is stored and linked.
      const complete = lastInScope
        ? txIdEquals(head, lastInScope) && txIdEquals(rt.state.frontier, head)
        : txIdEquals(rt.state.frontier, head);
      if (!complete || k.syncLt <= rt.state.syncedLt) continue;
      const key = `${k.syncLt}:${k.utime}`;
      const g = groups.get(key) ?? { syncLt: k.syncLt, utime: k.utime, addresses: [] };
      g.addresses.push(address);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      await this.store.markSynced(g.addresses, g.syncLt, g.utime);
      for (const a of g.addresses) {
        const rt = this.runtimes.get(a);
        if (rt && g.syncLt > rt.state.syncedLt) {
          rt.state.syncedLt = g.syncLt;
          rt.state.syncedUtime = g.utime;
        }
        this.emit("synced", a, g.syncLt);
      }
    }
  }

  // --- range fetching ----------------------------------------------------

  private addWalk(
    w: Omit<Walk, "id" | "pages" | "fetched" | "split" | "failures" | "notBefore" | "running">,
    split = false
  ) {
    const walk: Walk = {
      ...w,
      id: ++this.walkSeq,
      pages: 0,
      fetched: 0,
      split,
      failures: 0,
      notBefore: 0,
      running: false,
    };
    this.walks.set(walk.id, walk);
    this.metrics.inc("ton_watch_walks_started_total", { kind: w.kind });
    this.pump();
  }

  private nextWalk(): Walk | null {
    const now = Date.now();
    let best: Walk | null = null;
    for (const w of this.walks.values()) {
      if (w.running || w.notBefore > now) continue;
      // Head walks first (fresh data), then whichever waited longest.
      if (
        !best ||
        (w.kind === "head" && best.kind !== "head") ||
        (w.kind === best.kind && w.notBefore < best.notBefore)
      ) {
        best = w;
      }
    }
    return best;
  }

  private pump() {
    while (this.inFlight < this.o.concurrency) {
      const walk = this.nextWalk();
      if (!walk) break;
      walk.running = true;
      this.inFlight++;
      void this.fetchPage(walk).finally(() => {
        walk.running = false;
        this.inFlight--;
        this.pump();
        if (this.inFlight === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const r of waiters) r();
        }
      });
    }
    this.schedulePumpTimer();
  }

  private schedulePumpTimer() {
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    let soonest = Infinity;
    for (const w of this.walks.values()) {
      if (!w.running && w.notBefore > Date.now()) soonest = Math.min(soonest, w.notBefore);
    }
    if (soonest !== Infinity) {
      this.pumpTimer = setTimeout(() => this.pump(), Math.max(1, soonest - Date.now()));
      this.pumpTimer.unref?.();
    }
  }

  private async fetchPage(walk: Walk) {
    const { address } = walk;
    try {
      const page = await this.source.getTransactions(address, walk.cursor, this.source.maxPageSize);
      validatePage(walk.cursor, page);
      walk.pages++;
      walk.fetched += page.length;
      walk.failures = 0;
      walk.lastError = undefined;

      const inScope = page.filter((t) => t.lt > walk.floorLt);
      const written = inScope.length ? await this.store.write(address, inScope) : 0;
      this.metrics.txWritten(written);
      this.metrics.inc("ton_watch_pages_total", { kind: walk.kind });

      const oldest = page.at(-1)!;
      const reachedFloor = oldest.prevLt <= walk.floorLt || inScope.length < page.length;
      // Everything already stored: another walk got here first; gap scans pick up the rest.
      const overlapped = written === 0 && inScope.length > 0 && walk.pages > 1;
      if (reachedFloor || overlapped) {
        this.finishWalk(walk);
        return;
      }
      walk.cursor = { lt: oldest.prevLt, hash: oldest.prevHash };
      this.maybeSplit(walk);
    } catch (e) {
      const kind = classifyError(e);
      walk.failures++;
      walk.lastError = kind;
      this.metrics.error(kind, "walk");
      // "Not found" can also mean "not seen yet" on every server we asked, so only
      // a repeated miss is treated as history nobody serves.
      const delay =
        isParked(walk)
          ? this.o.archiveRetryMs
          : Math.min(this.o.retryMaxMs, this.o.retryMinMs * 2 ** (walk.failures - 1));
      walk.notBefore = Date.now() + delay;
      const msg = `[${toFriendlyAddress(address)}] fetch at lt ${walk.cursor.lt} failed (${kind}), retry in ${Math.round(delay / 1000)}s: ${(e as Error)?.message ?? e}`;
      if (walk.failures === 1 || isParked(walk)) this.logger.warn(msg);
      else this.logger.debug(msg);
      this.emit("fetchError", address, kind, e);
    }
  }

  /**
   * A single missing range is a sequential walk: each page needs the previous one's
   * prev link. When the range is long, find real transactions inside it (block
   * listings, not account state, so it works as far back as blocks are kept) and
   * walk the pieces in parallel.
   */
  private maybeSplit(walk: Walk) {
    const cfg = this.split;
    if (!cfg || walk.split || walk.pages < 3 || walk.fetched === 0) return;
    const ltPerTx = Number(walk.topLt - walk.cursor.lt) / walk.fetched;
    const remaining = Number(walk.cursor.lt - walk.floorLt) / ltPerTx;
    if (!(remaining >= cfg.minTxs)) return;
    walk.split = true;
    const parts = Math.min(cfg.maxParts, Math.floor(remaining / cfg.targetTxs));
    if (parts < 2) return;

    const floor = walk.floorLt;
    const span = walk.cursor.lt - floor;
    const targets = Array.from(
      { length: parts - 1 },
      (_, i) => floor + (span * BigInt(i + 1)) / BigInt(parts)
    );
    this.metrics.inc("ton_watch_splits_total");
    void Promise.all(
      targets.map((lt) =>
        this.source.findTxNear!(walk.address, lt, { ltPerTx }).catch((e) => {
          this.metrics.error(classifyError(e), "findTxNear");
          return null;
        })
      )
    ).then((found) => {
      if (!this.walks.has(walk.id)) return;
      // Only points strictly inside what is still left of the walk.
      const seen = new Set<bigint>();
      const points = found
        .filter((p): p is TxId => !!p && p.lt > walk.floorLt && p.lt < walk.cursor.lt)
        .filter((p) => !seen.has(p.lt) && (seen.add(p.lt), true))
        .sort((a, b) => (a.lt < b.lt ? -1 : 1));
      if (points.length === 0) return;
      this.metrics.inc("ton_watch_split_points_total", undefined, points.length);
      let below = walk.floorLt;
      for (const p of points) {
        this.addWalk(
          { address: walk.address, kind: walk.kind, cursor: p, floorLt: below, topLt: p.lt },
          true
        );
        below = p.lt;
      }
      walk.floorLt = below;
      this.logger.debug(
        `[${toFriendlyAddress(walk.address)}] split ~${Math.round(remaining)} txs into ${points.length + 1} parts`
      );
    });
  }

  private finishWalk(walk: Walk) {
    this.walks.delete(walk.id);
    const rt = this.runtimes.get(walk.address);
    if (!rt) return;
    rt.dirty = true;
    void this.store
      .advanceFrontier(walk.address)
      .then((frontier) => {
        if (frontier && frontier.lt !== rt.state.frontier?.lt) {
          rt.state.frontier = frontier;
          this.emit("frontier", walk.address, frontier.lt);
        }
      })
      .catch((e) => this.metrics.error(classifyError(e), "advanceFrontier"));
  }

  // --- metrics -----------------------------------------------------------

  private updateGauges() {
    const all = [...this.walks.values()];
    this.metrics.set("ton_watch_addresses", this.runtimes.size);
    this.metrics.set("ton_watch_walks", all.length);
    this.metrics.set(
      "ton_watch_walks_stuck",
      all.filter(isParked).length
    );
    let gaps = 0;
    let maxLag = 0;
    for (const rt of this.runtimes.values()) {
      const s = this.addressStatus(rt);
      gaps += s.gapsOpen;
      if (s.lagSeconds != null) maxLag = Math.max(maxLag, s.lagSeconds);
      if (this.o.addressMetrics) {
        const labels = { address: s.address };
        this.metrics.set("ton_watch_address_lag_seconds", s.lagSeconds ?? -1, labels);
        this.metrics.set("ton_watch_address_gaps_open", s.gapsOpen, labels);
      }
    }
    this.metrics.set("ton_watch_gaps_open", gaps);
    this.metrics.set("ton_watch_max_lag_seconds", maxLag);
  }

  private async mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    const worker = async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.o.concurrency, items.length) }, worker));
    return out;
  }
}
