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
 */
export class Indexer extends EventEmitter<IndexerEventMap> {
  readonly store: Store;
  readonly source: TxSource;
  readonly metrics: Metrics;
  /** Time (ms) of the last successful tick; 0 before the first. */
  lastTickAt = 0;

  private readonly logger: Logger;
  private readonly settings: IndexerSettings;
  private readonly addresses = new AddressTable();
  private readonly scheduler: WalkScheduler;
  private readonly runner: WalkRunner;
  private readonly detector: ChangeDetector;
  private readonly maintenance: Maintenance;
  private tip: ChainTip | null = null;
  private running = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private currentTick: Promise<void> | null = null;

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
    this.runner = new WalkRunner({
      store: this.store,
      fetcher: new PageFetcher(this.source, resolveHistory(options), this.metrics),
      scheduler: this.scheduler,
      splitter: split
        ? new WalkSplitter(split, this.source, this.scheduler, this.metrics, this.logger)
        : null,
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
    const loop = async () => {
      if (!this.running) return;
      this.currentTick = this.tick().catch((error) => {
        this.metrics.error(classifyError(error), "tick");
        this.logger.warn("tick failed:", errorMessage(error));
      });
      await this.currentTick;
      this.currentTick = null;
      if (this.running) this.tickTimer = setTimeout(loop, this.settings.tickMs);
    };
    void loop();
  }

  /** Stops ticking and waits for pages in flight to finish. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.scheduler.stop();
    await this.currentTick;
    while (this.scheduler.pagesInFlight > 0) await this.scheduler.whenIdle();
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

  /** Resolves once no range fetch is queued or in flight (parked archive misses excluded). */
  async drain(): Promise<void> {
    while (this.scheduler.hasPendingWork()) {
      await this.scheduler.whenIdle(DRAIN_POLL_MS);
    }
  }

  /** Ticks and drains until every address is complete up to the tip (or `maxRounds`). */
  async syncOnce(maxRounds = DEFAULT_SYNC_ROUNDS): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      try {
        await this.tick();
      } catch (error) {
        this.metrics.error(classifyError(error), "tick");
        continue;
      }
      await this.drain();
      await this.maintenance.scanGaps(true);
      await this.refreshAddresses();
      await this.maintenance.markSynced();
      if (this.addresses.anyUnobserved()) continue;
      if (this.scheduler.all().every(isParked)) return;
    }
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
    for (const address of dropped) {
      this.scheduler.dropIdle(address);
      if (this.settings.addressMetrics) this.metrics.clearGauges("ton_watch_address_");
    }
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
