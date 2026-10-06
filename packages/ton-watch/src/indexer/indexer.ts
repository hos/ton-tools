import { EventEmitter } from "node:events";

import { classifyError, errorMessage } from "../core/errors";
import { Metrics } from "../metrics/metrics";
import type { ChainTip, TxSource } from "../source/source";
import type { Store } from "../stores/store";
import { type Logger, silentLogger } from "../util/logger";
import { ChangeDetector } from "./change-detector";
import type { IndexerEventMap } from "./events";
import { Maintenance } from "./maintenance";
import {
  type IndexerOptions,
  type IndexerSettings,
  resolveHistory,
  resolveSettings,
  resolveSplit,
} from "./options";
import { PageFetcher } from "./page-fetcher";
import { type AddressStatus, addressStatus, recordGauges } from "./status";
import { AddressTable } from "./tracked-address";
import { isParked } from "./walk";
import { WalkRunner } from "./walk-runner";
import { WalkScheduler } from "./walk-scheduler";
import { WalkSplitter } from "./walk-splitter";

/** How often `drain()` re-checks for remaining work while pages are in flight. */
const DRAIN_POLL_MS = 50;
const DEFAULT_SYNC_ROUNDS = 1000;

/**
 * Indexes every transaction of the addresses in the store. Each tick it reads the
 * chain tip, detects addresses with new transactions, schedules *walks* over
 * missing ranges (new heads, and gaps found in the store), and advances frontiers.
 * Pages of all walks share one concurrency limit and are written in any order;
 * completeness is derived from the prev links in the store.
 *
 * Emits `tick`, `frontier`, `synced` and `fetchError` (see `IndexerEventMap`).
 *
 * Most applications use `TonWatch`, which wraps one. Exported from
 * `@ton/watch/advanced` for custom setups.
 * @experimental
 */
export class Indexer extends EventEmitter<IndexerEventMap> {
  readonly store: Store;
  readonly source: TxSource;
  readonly metrics: Metrics;
  /** Time (ms) of the last successful tick; 0 before the first. */
  lastTickAt: number = 0;

  private readonly logger: Logger;
  private readonly settings: IndexerSettings;
  private readonly addresses = new AddressTable();
  private readonly scheduler: WalkScheduler;
  private readonly runner: WalkRunner;
  private readonly detector: ChangeDetector;
  private readonly maintenance: Maintenance;
  private readonly splitter: WalkSplitter | null;
  private tip: ChainTip | null = null;
  private running = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private currentTick: Promise<void> | null = null;
  /** Incremented by every `start()`, so a loop outlived by a stop/start ends itself. */
  private loopGeneration = 0;
  /** Incremented by every `stop()`, so a `syncOnce()` it interrupts returns. */
  private stopGeneration = 0;

  constructor(options: IndexerOptions) {
    super();
    this.store = options.store;
    this.source = options.source;
    this.metrics = options.metrics ?? options.source.metrics ?? new Metrics();
    this.logger = options.logger ?? silentLogger;
    this.settings = resolveSettings(options);

    this.scheduler = new WalkScheduler(
      this.settings.concurrency,
      (walk) => this.runner.runPage(walk),
      this.metrics,
    );
    this.maintenance = new Maintenance({
      store: this.store,
      addresses: this.addresses,
      scheduler: this.scheduler,
      settings: this.settings,
      events: this,
      metrics: this.metrics,
      logger: this.logger,
    });
    this.detector = new ChangeDetector(
      this.source,
      this.addresses,
      this.settings,
      this.metrics,
      this.logger,
    );
    const split = resolveSplit(options);
    this.splitter = split
      ? new WalkSplitter(split, this.source, this.scheduler, this.metrics, this.logger)
      : null;
    this.runner = new WalkRunner({
      store: this.store,
      fetcher: new PageFetcher(this.source, resolveHistory(options), this.metrics),
      scheduler: this.scheduler,
      splitter: this.splitter,
      settings: this.settings,
      events: this,
      metrics: this.metrics,
      logger: this.logger,
      onWalkFinished: (address) => this.maintenance.onWalkFinished(address),
    });
  }

  /** The chain tip seen by the last tick. */
  get chainTip(): ChainTip | null {
    return this.tip;
  }

  /** Ticks every `tickMs` until `stop()`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduler.resume();
    const generation = ++this.loopGeneration;
    const isCurrent = () => this.running && this.loopGeneration === generation;
    const loop = async () => {
      // A tick of a loop stopped just before this start() may still be running.
      if (this.currentTick) await this.currentTick;
      if (!isCurrent()) return;
      const tick = this.tick().catch((error) => {
        this.metrics.error(classifyError(error), "tick");
        this.logger.warn("tick failed:", errorMessage(error));
      });
      this.currentTick = tick;
      await tick;
      if (this.currentTick === tick) this.currentTick = null;
      if (isCurrent()) this.tickTimer = setTimeout(loop, this.settings.tickMs);
    };
    void loop();
  }

  /**
   * Stops ticking and starting pages, then waits for the tick, the pages in
   * flight and the store updates they started (frontier moves, walk splits) to
   * finish. Remaining work stays scheduled for the next `start()` or `syncOnce()`;
   * a `syncOnce()` in progress returns.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stopGeneration++;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.scheduler.stop();
    await this.currentTick;
    await this.pause();
  }

  /** One detection + maintenance round. Exposed for tests and one-shot tools. */
  async tick(): Promise<void> {
    const tip = await this.source.getTip();
    this.tip = tip;
    this.lastTickAt = Date.now();
    this.metrics.set("ton_watch_tip_seqno", tip.seqno);
    this.metrics.set("ton_watch_tip_utime", tip.utime);

    await this.refreshAddresses();
    await this.detector.detect(tip);
    this.scheduleHeadWalks();
    await this.maintenance.scanGaps();
    await this.maintenance.markSynced();
    this.updateGauges();
    this.scheduler.pump();
    this.emit("tick", tip);
  }

  /**
   * Resolves once no range fetch is queued or in flight (parked archive misses
   * and walks that keep failing excluded). Never starts work itself: after
   * `stop()` no page starts, so it resolves once the pages in flight are done,
   * leaving the queued walks for the next `start()` or `syncOnce()`.
   */
  async drain(): Promise<void> {
    while (this.scheduler.hasPendingWork()) {
      if (this.scheduler.isStopped && this.scheduler.pagesInFlight === 0) return;
      await this.scheduler.whenIdle(DRAIN_POLL_MS);
    }
  }

  /**
   * Ticks and drains until every address is complete up to the tip (or
   * `maxRounds`). Works on a stopped indexer, which it leaves stopped; returns
   * early if `stop()` is called meanwhile.
   */
  async syncOnce(maxRounds: number = DEFAULT_SYNC_ROUNDS): Promise<void> {
    const wasStopped = this.scheduler.isStopped;
    const generation = this.stopGeneration;
    const interrupted = () => this.stopGeneration !== generation;
    this.scheduler.resume();
    try {
      for (let round = 0; round < maxRounds && !interrupted(); round++) {
        try {
          await this.tick();
        } catch (error) {
          this.metrics.error(classifyError(error), "tick");
          continue;
        }
        await this.drain();
        if (interrupted()) return;
        await this.maintenance.scanGaps(true);
        await this.refreshAddresses();
        await this.maintenance.markSynced();
        if (this.addresses.anyUnobserved()) continue;
        if (this.scheduler.all().every(isParked)) return;
      }
    } finally {
      // Back to stopped unless start() was called meanwhile.
      if (wasStopped && !this.running) await this.pause();
    }
  }

  /** Stops starting pages and waits for the ones in flight and their background work. */
  private async pause(): Promise<void> {
    this.scheduler.stop();
    while (this.scheduler.pagesInFlight > 0) await this.scheduler.whenIdle();
    await Promise.all([this.maintenance.settled(), this.splitter?.settled()]);
  }

  status(): AddressStatus[] {
    return this.addresses
      .all()
      .map((tracked) =>
        addressStatus(tracked, this.scheduler.forAddress(tracked.state.address), this.tip),
      );
  }

  private async refreshAddresses(): Promise<void> {
    const dropped = this.addresses.sync(await this.store.listAddresses());
    for (const address of dropped) this.scheduler.dropAddress(address);
  }

  /** Schedules a head walk for every address whose on-chain last tx is above anything claimed. */
  private scheduleHeadWalks(): void {
    for (const tracked of this.addresses.all()) {
      const lastTx = tracked.observed?.lastTx;
      if (!lastTx) continue;
      const { address, head, startLt } = tracked.state;
      const storedTop = head && head.lt > startLt ? head.lt : startLt;
      const claimedTop = this.scheduler.highestTopLt(address, storedTop);
      if (lastTx.lt <= claimedTop) continue;
      this.scheduler.add({
        address,
        kind: "head",
        cursor: lastTx,
        floorLt: claimedTop,
        topLt: lastTx.lt,
      });
    }
  }

  private updateGauges(): void {
    recordGauges(this.metrics, this.status(), this.scheduler.all(), this.settings.addressMetrics);
  }
}
