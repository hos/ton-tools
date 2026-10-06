import { Consumer } from "./consumer/consumer";
import type { ProcessOptions, TxHandler } from "./consumer/types";
import { toRawAddress } from "./core/address";
import { type AddressState, completeUpTo } from "./core/types";
import { Indexer } from "./indexer/indexer";
import type { IndexerOptions } from "./indexer/options";
import type { AddressStatus } from "./indexer/status";
import { Metrics } from "./metrics/metrics";
import type { TxSource } from "./source/source";
import type { Store } from "./stores/store";
import { consoleLogger, type Logger } from "./util/logger";

export interface TonWatchOptions extends Omit<IndexerOptions, "store" | "source"> {
  store: Store;
  source: TxSource;
  /** Run migrations on start. Default true. */
  migrate?: boolean;
}

export interface AddAddressOptions {
  /**
   * What history to index:
   * - `"now"` (default): only transactions after this moment.
   * - `"genesis"`: the account's full history.
   * - an lt: transactions with a greater lt.
   */
  from?: "now" | "genesis" | bigint;
}

/** Service health, as served on `/health`. */
export interface Health {
  /** `down`: not running or not ticking; `degraded`: running with problems (see `reasons`). */
  status: "ok" | "degraded" | "down";
  running: boolean;
  tip: { seqno: number; utime: number; ageSeconds: number } | null;
  addresses: number;
  maxLagSeconds: number | null;
  gapsOpen: number;
  stuckRanges: number;
  txWrittenPerSecond: number;
  reasons: string[];
}

/** Lag beyond which `health()` reports `degraded`, by default. */
const DEFAULT_MAX_LAG_SECONDS = 120;
/** No successful tick for this long means the service is `down`. */
const STALE_TICK_SECONDS = 60;

/** Normalizes any address form to raw `<workchain>:<hex>`. */
export const toRaw = toRawAddress;

/**
 * Indexes the transactions of a set of addresses and hands them to consumers in
 * chain order. Fetching runs in any order and in parallel; ordering is enforced
 * only when reading.
 */
export class TonWatch {
  readonly store: Store;
  readonly source: TxSource;
  readonly indexer: Indexer;
  readonly metrics: Metrics;
  private readonly logger: Logger;
  private readonly consumers = new Set<Consumer>();
  private readonly shouldMigrate: boolean;
  private started = false;
  private migrated = false;

  constructor(options: TonWatchOptions) {
    this.store = options.store;
    this.source = options.source;
    this.metrics = options.metrics ?? options.source.metrics ?? new Metrics();
    this.logger = options.logger ?? consoleLogger("info");
    this.shouldMigrate = options.migrate ?? true;
    this.indexer = new Indexer({ ...options, metrics: this.metrics, logger: this.logger });
  }

  /** Runs migrations (never drops anything). Called by `start()`. */
  async init(): Promise<void> {
    if (this.migrated || !this.shouldMigrate) return;
    await this.store.migrate();
    this.migrated = true;
  }

  /** Starts indexing and every consumer registered with `process()`. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.init();
    this.started = true;
    this.indexer.start();
    for (const consumer of this.consumers) consumer.start();
  }

  /** Graceful stop: consumers finish their current transaction, in-flight fetches complete. */
  async stop({ closeSource = true, closeStore = true } = {}): Promise<void> {
    this.started = false;
    await Promise.all([...this.consumers].map((consumer) => consumer.stop()));
    await this.indexer.stop();
    if (closeSource) await this.source.close?.();
    if (closeStore) await this.store.close();
  }

  /** Starts tracking an address (any form). Resolves to its raw form. */
  async addAddress(address: string, options: AddAddressOptions = {}): Promise<string> {
    await this.init();
    const rawAddress = toRawAddress(address);
    const from = options.from ?? "now";
    if (from === "genesis") {
      await this.store.addAddress(rawAddress, { startLt: 0n });
    } else if (typeof from === "bigint") {
      await this.store.addAddress(rawAddress, { startLt: from });
    } else {
      const tip = await this.source.getTip();
      const lastTx = await this.source.getLastTx(rawAddress, tip);
      await this.store.addAddress(rawAddress, {
        startLt: lastTx?.lt ?? 0n,
        syncedLt: tip.syncLt,
        syncedUtime: tip.utime,
      });
    }
    return rawAddress;
  }

  /** Stops tracking an address; with `purge`, also deletes its transactions and cursors. */
  async removeAddress(address: string, options?: { purge?: boolean }): Promise<void> {
    await this.store.removeAddress(toRawAddress(address), options);
  }

  addresses(): Promise<AddressState[]> {
    return this.store.listAddresses();
  }

  /**
   * Delivers transactions to `handler` in chain order. `name` identifies the
   * consumer's stored position: reuse it to resume, change it to start over.
   * Run each consumer name in one process at a time.
   */
  process(name: string, handler: TxHandler, options: ProcessOptions = {}): Consumer {
    const consumer = new Consumer(
      name,
      this.store,
      handler,
      { ...options, addresses: options.addresses?.map(toRawAddress) },
      { events: this.indexer, logger: this.logger, metrics: this.metrics },
    );
    this.consumers.add(consumer);
    if (this.started) consumer.start();
    return consumer;
  }

  /**
   * The lowest complete-up-to lt across `addresses` (default: all): every
   * transaction of these addresses with a lower or equal lt is stored.
   */
  async watermark(addresses?: string[]): Promise<bigint | null> {
    const only = addresses ? new Set(addresses.map(toRawAddress)) : null;
    const states = (await this.store.listAddresses()).filter(
      (state) => !only || only.has(state.address),
    );
    if (states.length === 0) return null;
    return states.map(completeUpTo).reduce((min, lt) => (lt < min ? lt : min));
  }

  status(): AddressStatus[] {
    return this.indexer.status();
  }

  health(maxLagSeconds = DEFAULT_MAX_LAG_SECONDS): Health {
    const tip = this.indexer.chainTip;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const statuses = this.indexer.status();
    const lags = statuses
      .map((status) => status.lagSeconds)
      .filter((lag): lag is number => lag != null);
    const maxLag = lags.length > 0 ? Math.max(...lags) : null;
    const stuck = statuses.reduce((sum, status) => sum + status.stuck, 0);
    const secondsSinceTick = this.indexer.lastTickAt
      ? (Date.now() - this.indexer.lastTickAt) / 1000
      : Number.POSITIVE_INFINITY;

    const reasons: string[] = [];
    if (!this.started) reasons.push("not running");
    if (secondsSinceTick > STALE_TICK_SECONDS) {
      reasons.push(`no successful tick for ${Math.round(secondsSinceTick)}s`);
    }
    if (maxLag != null && maxLag > maxLagSeconds) reasons.push(`max lag ${maxLag}s`);
    if (stuck > 0) reasons.push(`${stuck} range(s) not served by any liteserver`);
    const down = !this.started || secondsSinceTick > STALE_TICK_SECONDS;

    return {
      status: down ? "down" : reasons.length > 0 ? "degraded" : "ok",
      running: this.started,
      tip: tip ? { seqno: tip.seqno, utime: tip.utime, ageSeconds: nowSeconds - tip.utime } : null,
      addresses: statuses.length,
      maxLagSeconds: maxLag,
      gapsOpen: statuses.reduce((sum, status) => sum + status.gapsOpen, 0),
      stuckRanges: stuck,
      txWrittenPerSecond: this.metrics.writeRate(),
      reasons,
    };
  }
}
