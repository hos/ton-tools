import { Address } from "@ton/core";

import { Consumer, type ProcessOptions, type TxHandler } from "./consumer";
import { Indexer, type AddressStatus, type IndexerOptions } from "./indexer";
import { logger as defaultLogger, type Logger } from "./logger";
import { Metrics } from "./metrics";
import type { TxSource } from "./source/source";
import type { Store } from "./stores/store";
import { completeUpTo, type AddressState } from "./types";

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

export interface Health {
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

/** Normalizes any address form to raw `<workchain>:<hex>`. */
export const toRaw = (address: string) => Address.parse(address).toRawString();

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
    this.logger = options.logger ?? defaultLogger;
    this.shouldMigrate = options.migrate ?? true;
    this.indexer = new Indexer({ ...options, metrics: this.metrics, logger: this.logger });
  }

  /** Runs migrations (never drops anything). Called by `start()`. */
  async init() {
    if (this.migrated || !this.shouldMigrate) return;
    await this.store.migrate();
    this.migrated = true;
  }

  async start() {
    if (this.started) return;
    await this.init();
    this.started = true;
    this.indexer.start();
    for (const c of this.consumers) c.start();
  }

  /** Graceful stop: consumers finish their current transaction, in-flight fetches complete. */
  async stop({ closeSource = true, closeStore = true } = {}) {
    this.started = false;
    await Promise.all([...this.consumers].map((c) => c.stop()));
    await this.indexer.stop();
    if (closeSource) await this.source.close?.();
    if (closeStore) await this.store.close();
  }

  async addAddress(address: string, options: AddAddressOptions = {}) {
    await this.init();
    const raw = toRaw(address);
    const from = options.from ?? "now";
    if (from === "genesis") {
      await this.store.addAddress(raw, { startLt: 0n });
    } else if (typeof from === "bigint") {
      await this.store.addAddress(raw, { startLt: from });
    } else {
      const tip = await this.source.getTip();
      const last = await this.source.getLastTx(raw, tip);
      await this.store.addAddress(raw, {
        startLt: last?.lt ?? 0n,
        syncedLt: tip.syncLt,
        syncedUtime: tip.utime,
      });
    }
    return raw;
  }

  async removeAddress(address: string, options?: { purge?: boolean }) {
    await this.store.removeAddress(toRaw(address), options);
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
      { ...options, addresses: options.addresses?.map(toRaw) },
      { events: this.indexer, logger: this.logger, metrics: this.metrics }
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
    const only = addresses ? new Set(addresses.map(toRaw)) : null;
    const states = (await this.store.listAddresses()).filter((s) => !only || only.has(s.address));
    if (states.length === 0) return null;
    return states.map(completeUpTo).reduce((a, b) => (b < a ? b : a));
  }

  status(): AddressStatus[] {
    return this.indexer.status();
  }

  health(maxLagSeconds = 120): Health {
    const tip = this.indexer.chainTip;
    const now = Math.floor(Date.now() / 1000);
    const statuses = this.indexer.status();
    const lags = statuses.map((s) => s.lagSeconds).filter((x): x is number => x != null);
    const maxLag = lags.length ? Math.max(...lags) : null;
    const stuck = statuses.reduce((n, s) => n + s.stuck, 0);
    const reasons: string[] = [];
    const tickAge = this.indexer.lastTickAt ? (Date.now() - this.indexer.lastTickAt) / 1000 : Infinity;
    if (!this.started) reasons.push("not running");
    if (tickAge > 60) reasons.push(`no successful tick for ${Math.round(tickAge)}s`);
    if (maxLag != null && maxLag > maxLagSeconds) reasons.push(`max lag ${maxLag}s`);
    if (stuck > 0) reasons.push(`${stuck} range(s) not served by any liteserver`);
    const down = !this.started || tickAge > 60;
    return {
      status: down ? "down" : reasons.length ? "degraded" : "ok",
      running: this.started,
      tip: tip ? { seqno: tip.seqno, utime: tip.utime, ageSeconds: now - tip.utime } : null,
      addresses: statuses.length,
      maxLagSeconds: maxLag,
      gapsOpen: statuses.reduce((n, s) => n + s.gapsOpen, 0),
      stuckRanges: stuck,
      txWrittenPerSecond: this.metrics.writeRate(),
      reasons,
    };
  }
}
