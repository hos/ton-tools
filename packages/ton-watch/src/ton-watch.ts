import { EventEmitter } from "node:events";

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
import { type AddressInput, toRawAddress } from "./core/address";
import { TonWatchError } from "./core/errors";
import { type AddressState, watermarkOf } from "./core/types";
import type { IndexerEventMap } from "./indexer/events";
import { Indexer } from "./indexer/indexer";
import type { IndexingOptions } from "./indexer/options";
import type { AddressStatus } from "./indexer/status";
import { Metrics } from "./metrics/metrics";
import type { TxSource } from "./source/source";
import type { ConsumerRecord, DeadLetter, DeadLetterFilter } from "./stores/consumer-state";
import type { Store } from "./stores/store";
import { consoleLogger, type Logger } from "./util/logger";

export interface TonWatchOptions<Db = unknown> extends IndexingOptions {
  /**
   * Where transactions, addresses and consumer positions live. `TonWatch` takes
   * ownership: `close()` closes it. Its type decides `HandlerContext.db`
   * (`PgQueryable` with `PgStore`).
   */
  store: Store<Db>;
  /** Where transactions come from. `TonWatch` takes ownership: `close()` closes it. */
  source: TxSource;
  /** Run migrations on start. Default true. */
  migrate?: boolean;
  /** Default: the source's metrics, or a new registry. */
  metrics?: Metrics;
  /** Default: a console logger at level `info`. */
  logger?: Logger;
}

export interface AddAddressOptions {
  /**
   * What history to index:
   * - `"now"` (default): only transactions after this moment.
   * - `"earliest"`: the account's full history.
   * - an lt: transactions with a greater lt.
   */
  from?: "now" | "earliest" | bigint;
}

export interface RemoveAddressOptions {
  /** Also delete the address's transactions and every consumer's cursor on it. */
  purge?: boolean;
}

export interface HealthOptions {
  /** Lag beyond which an address makes the health `degraded`. Default 120. */
  maxLagSeconds?: number;
}

/** Events emitted by `TonWatch`, with their listener arguments (forwarded from indexing). */
export type TonWatchEventMap = IndexerEventMap;

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

/**
 * Indexes the transactions of a set of addresses and hands them to consumers in
 * chain order. Fetching runs in any order and in parallel; ordering is enforced
 * only when reading.
 *
 * Owns its `store` and `source`: `stop()` pauses and can be followed by
 * `start()`, `close()` stops for good and closes both. Both return promptly (see
 * `stop()`), so they fit a container's shutdown grace period.
 *
 * Emits `tick`, `frontier`, `synced` and `fetchError` (see `TonWatchEventMap`).
 */
export class TonWatch<Db = unknown> extends EventEmitter<TonWatchEventMap> {
  readonly store: Store<Db>;
  readonly source: TxSource;
  readonly metrics: Metrics;
  private readonly indexer: Indexer;
  private readonly logger: Logger;
  private readonly registered = new Set<Consumer<Db>>();
  private readonly shouldMigrate: boolean;
  private started = false;
  private migrated = false;
  private closed: Promise<void> | null = null;

  constructor(options: TonWatchOptions<Db>) {
    super();
    this.store = options.store;
    this.source = options.source;
    this.metrics = options.metrics ?? options.source.metrics ?? new Metrics();
    this.logger = options.logger ?? consoleLogger("info");
    this.shouldMigrate = options.migrate ?? true;
    this.indexer = new Indexer({ ...options, metrics: this.metrics, logger: this.logger });
    this.indexer.on("tick", (tip) => this.emit("tick", tip));
    this.indexer.on("frontier", (address, lt) => this.emit("frontier", address, lt));
    this.indexer.on("synced", (address, lt) => this.emit("synced", address, lt));
    this.indexer.on("fetchError", (address, kind, error) =>
      this.emit("fetchError", address, kind, error),
    );
  }

  /** Runs migrations (never drops anything). Called by `start()`. */
  async init(): Promise<void> {
    this.assertOpen();
    if (this.migrated || !this.shouldMigrate) return;
    await this.store.migrate();
    this.migrated = true;
  }

  /**
   * Starts every consumer registered with `process()`, then indexing. Rejects with
   * `ConsumerLockedError` (and starts nothing) if a consumer runs elsewhere.
   */
  async start(): Promise<void> {
    this.assertOpen();
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

  /**
   * Prompt, graceful stop; store and source stay open and `start()` resumes.
   *
   * - Indexing starts nothing new and retries nothing from the moment it is
   *   called. Fetches already in flight get `stopTimeoutMs` (default 5s) to
   *   finish and have their pages stored; then they are abandoned (source calls
   *   aborted). Abandoned ranges are refetched after the next start, so nothing
   *   is lost and nothing half-done is ever delivered.
   * - Consumers are never interrupted mid-transaction: a handler call in progress
   *   runs to the end and its cursor is committed. There is no deadline on that
   *   call — it is your code; give it its own timeouts.
   *
   * Both run in parallel. Always resolves, after about `stopTimeoutMs` at most,
   * or the current handler call if that takes longer.
   */
  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([
      ...[...this.registered].map((consumer) => consumer.stop()),
      this.indexer.stop(),
    ]);
  }

  /**
   * `stop()`, then closes the source (rejecting its pending requests) and the
   * store. Final: afterwards `start()`, `init()` and `addAddress()` reject with
   * code `CLOSED`. Calling it again returns the same promise.
   *
   * Takes as long as `stop()` plus closing the store. The source and the store
   * are closed even if one of them fails to close; the promise then rejects with
   * that error, after both were attempted. Use it on SIGTERM (the CLI does).
   */
  close(): Promise<void> {
    this.closed ??= (async () => {
      await this.stop();
      const results = await Promise.allSettled([
        (async () => this.source.close?.())(),
        (async () => this.store.close())(),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    })();
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw new TonWatchError("CLOSED", "this TonWatch was closed");
  }

  /**
   * Starts tracking an address (friendly or raw, or an `Address`). Resolves to its
   * raw form, the one every output uses.
   */
  async addAddress(address: AddressInput, options: AddAddressOptions = {}): Promise<string> {
    await this.init();
    const rawAddress = toRawAddress(address);
    const from = options.from ?? "now";
    if (from === "earliest") {
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
  async removeAddress(address: AddressInput, options: RemoveAddressOptions = {}): Promise<void> {
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
   * Throws code `CONSUMER_REGISTERED` if `name` is already registered here.
   */
  process(name: string, handler: TxHandler<Db>, options: ProcessOptions = {}): Consumer<Db> {
    if (this.consumerNamed(name)) {
      throw new TonWatchError("CONSUMER_REGISTERED", `consumer ${name} is already registered`);
    }
    const consumer = new Consumer(name, this.store, handler, options, {
      events: this.indexer,
      logger: this.logger,
      metrics: this.metrics,
    });
    this.registered.add(consumer);
    if (this.started) consumer.start();
    return consumer;
  }

  private consumerNamed(name: string): Consumer<Db> | undefined {
    return [...this.registered].find((consumer) => consumer.name === name);
  }

  /** Every consumer the store knows (also ones run by other processes), with its cursors. */
  consumers(): Promise<ConsumerRecord[]> {
    return this.store.listConsumers();
  }

  /**
   * How far a consumer is behind (see `ConsumerLag`); it need not run in this
   * process. Rejects with code `UNKNOWN_CONSUMER` if the store does not know it.
   */
  async consumerLag(name: string): Promise<ConsumerLag> {
    const local = this.consumerNamed(name);
    if (local) return local.lag();
    const record = (await this.store.listConsumers()).find((consumer) => consumer.name === name);
    if (!record) throw new TonWatchError("UNKNOWN_CONSUMER", `unknown consumer ${name}`);
    return measureLag(this.store, name, record.order ?? "address");
  }

  /**
   * Moves a consumer's cursors to `to`: `"earliest"` (redeliver everything), `"now"`
   * (skip to each frontier) or an lt (deliver what comes after it). A consumer
   * registered here applies it between rounds; one running in another process
   * makes this reject with `ConsumerLockedError`.
   */
  async rewindConsumer(name: string, to: RewindTarget, options: RewindOptions = {}): Promise<void> {
    const local = this.consumerNamed(name);
    if (local) return local.rewind(to, options);
    const addresses = options.addresses?.map(toRawAddress);
    await withConsumerLock(this.store, name, () => rewindCursors(this.store, name, to, addresses));
  }

  /**
   * Deletes a consumer's record, cursors and dead letters; it starts over under the
   * same name. Rejects with `ConsumerLockedError` while it runs anywhere, and with
   * code `CONSUMER_REGISTERED` if it is registered in this process.
   */
  async deleteConsumer(name: string): Promise<void> {
    if (this.consumerNamed(name)) {
      throw new TonWatchError(
        "CONSUMER_REGISTERED",
        `consumer ${name} is registered in this process; delete it from another`,
      );
    }
    await withConsumerLock(this.store, name, () => this.store.deleteConsumer(name));
  }

  /** Dead letters of every consumer, or as filtered; oldest first. */
  deadLetters(filter: DeadLetterFilter = {}): Promise<DeadLetter[]> {
    const address = filter.address === undefined ? undefined : toRawAddress(filter.address);
    return this.store.listDeadLetters({ ...filter, address });
  }

  /** Deletes a dead letter without redelivering it. False if there was none. */
  discardDeadLetter(consumer: string, address: AddressInput, lt: bigint): Promise<boolean> {
    return this.store.deleteDeadLetter(consumer, toRawAddress(address), lt);
  }

  /**
   * Redelivers a dead letter through a consumer registered here (see
   * `Consumer.replayDeadLetter`). Rejects with code `UNKNOWN_CONSUMER` if none is.
   */
  async replayDeadLetter(consumer: string, address: AddressInput, lt: bigint): Promise<void> {
    const local = this.consumerNamed(consumer);
    if (!local) {
      throw new TonWatchError(
        "UNKNOWN_CONSUMER",
        `consumer ${consumer} is not registered in this process`,
      );
    }
    return local.replayDeadLetter(address, lt);
  }

  /**
   * The lowest complete-up-to lt across `addresses` (default: all): every
   * transaction of these addresses with a lower or equal lt is stored.
   */
  async watermark(addresses?: readonly AddressInput[]): Promise<bigint | null> {
    const only = addresses ? new Set(addresses.map(toRawAddress)) : null;
    const states = (await this.store.listAddresses()).filter(
      (state) => !only || only.has(state.address),
    );
    return watermarkOf(states);
  }

  /** Indexing state of every tracked address, as of the last tick. */
  status(): AddressStatus[] {
    return this.indexer.status();
  }

  /** Overall indexing health, as of the last tick (see `Health`). */
  health(options: HealthOptions = {}): Health {
    const maxLagSeconds = options.maxLagSeconds ?? DEFAULT_MAX_LAG_SECONDS;
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
