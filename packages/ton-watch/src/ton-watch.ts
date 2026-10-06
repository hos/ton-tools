import { Consumer } from "./consumer/consumer";
import { rewindCursors } from "./consumer/cursors";
import { measureLag } from "./consumer/lag";
import { withConsumerLock } from "./consumer/lock";
import type {
  ConsumerLag,
  ProcessOptions,
  RewindOptions,
  RewindTarget,
  TxHandler,
} from "./consumer/types";
import { toRawAddress } from "./core/address";
import { type AddressState, watermarkOf } from "./core/types";
import { Indexer } from "./indexer/indexer";
import type { IndexerOptions } from "./indexer/options";
import type { AddressStatus } from "./indexer/status";
import { Metrics } from "./metrics/metrics";
import type { TxSource } from "./source/source";
import type { ConsumerRecord, DeadLetter, DeadLetterFilter } from "./stores/consumer-state";
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
  private readonly registered = new Set<Consumer>();
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

  /**
   * Starts every consumer registered with `process()`, then indexing. Rejects with
   * `ConsumerLockedError` (and starts nothing) if a consumer runs elsewhere.
   */
  async start(): Promise<void> {
    if (this.started) return;
    await this.init();
    const consumers = [...this.registered];
    try {
      await Promise.all(consumers.map((consumer) => consumer.start().ready()));
    } catch (error) {
      await Promise.all(consumers.map((consumer) => consumer.stop()));
      throw error;
    }
    this.started = true;
    this.indexer.start();
  }

  /** Graceful stop: consumers finish their current transaction, in-flight fetches complete. */
  async stop({ closeSource = true, closeStore = true } = {}): Promise<void> {
    this.started = false;
    await Promise.all([...this.registered].map((consumer) => consumer.stop()));
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
   * One instance per name delivers at a time (see `ProcessOptions.lock`); when
   * registered after `start()`, await `consumer.ready()` to learn if it got the lock.
   */
  process(name: string, handler: TxHandler, options: ProcessOptions = {}): Consumer {
    if (this.consumerNamed(name)) throw new Error(`consumer ${name} is already registered`);
    const consumer = new Consumer(
      name,
      this.store,
      handler,
      { ...options, addresses: options.addresses?.map(toRawAddress) },
      { events: this.indexer, logger: this.logger, metrics: this.metrics },
    );
    this.registered.add(consumer);
    if (this.started) consumer.start();
    return consumer;
  }

  private consumerNamed(name: string): Consumer | undefined {
    return [...this.registered].find((consumer) => consumer.name === name);
  }

  /** Every consumer the store knows (also ones run by other processes), with its cursors. */
  consumers(): Promise<ConsumerRecord[]> {
    return this.store.listConsumers();
  }

  /** How far a consumer is behind (see `ConsumerLag`); it need not run in this process. */
  async consumerLag(name: string): Promise<ConsumerLag> {
    const local = this.consumerNamed(name);
    if (local) return local.lag();
    const record = (await this.store.listConsumers()).find((consumer) => consumer.name === name);
    if (!record) throw new Error(`unknown consumer ${name}`);
    return measureLag(this.store, name, record.order ?? "address");
  }

  /**
   * Moves a consumer's cursors to `to`: `"start"` (redeliver everything), `"now"`
   * (skip to each frontier) or an lt (deliver what comes after it). A consumer
   * registered here applies it between rounds; one running in another process
   * makes this reject with `ConsumerLockedError`.
   */
  async rewindConsumer(name: string, to: RewindTarget, options: RewindOptions = {}): Promise<void> {
    const addresses = options.addresses?.map(toRawAddress);
    const local = this.consumerNamed(name);
    if (local) return local.rewind(to, { addresses });
    await withConsumerLock(this.store, name, () => rewindCursors(this.store, name, to, addresses));
  }

  /**
   * Deletes a consumer's record, cursors and dead letters; it starts over under the
   * same name. Rejects with `ConsumerLockedError` while it runs anywhere, and if it
   * is registered in this process.
   */
  async deleteConsumer(name: string): Promise<void> {
    if (this.consumerNamed(name)) {
      throw new Error(`consumer ${name} is registered in this process; delete it from another`);
    }
    await withConsumerLock(this.store, name, () => this.store.deleteConsumer(name));
  }

  /** Dead letters of every consumer, or as filtered; oldest first. */
  deadLetters(filter: DeadLetterFilter = {}): Promise<DeadLetter[]> {
    const address = filter.address === undefined ? undefined : toRawAddress(filter.address);
    return this.store.listDeadLetters({ ...filter, address });
  }

  /** Deletes a dead letter without redelivering it. False if there was none. */
  resolveDeadLetter(consumer: string, address: string, lt: bigint): Promise<boolean> {
    return this.store.deleteDeadLetter(consumer, toRawAddress(address), lt);
  }

  /** Redelivers a dead letter through a consumer registered here (see `Consumer.replayDeadLetter`). */
  replayDeadLetter(consumer: string, address: string, lt: bigint): Promise<void> {
    const local = this.consumerNamed(consumer);
    if (!local) throw new Error(`consumer ${consumer} is not registered in this process`);
    return local.replayDeadLetter(toRawAddress(address), lt);
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
    return watermarkOf(states);
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
