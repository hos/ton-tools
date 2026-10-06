import type { Metrics } from "../metrics/metrics";
import type { HistoryOptions } from "../source/history";
import type { TxSource } from "../source/source";
import type { Store } from "../stores/store";
import type { Logger } from "../util/logger";
import { assertPositiveInteger } from "../util/validate";

/**
 * How to find addresses with new transactions:
 * - `poll`: one account-state call per address, idle addresses polled less often.
 * - `blocks`: list the transactions of every new shard block once and match
 *   watched addresses; cost does not grow with the number of addresses.
 * - `auto`: `blocks` from `autoBlocksThreshold` addresses on, `poll` below.
 */
export type DetectMode = "poll" | "blocks" | "auto";

/** Splitting of long missing ranges into parallel pieces. */
export interface SplitOptions {
  /** Only ranges estimated at this many transactions or more are split. Default 1000. */
  minTxs?: number;
  /** Aim for pieces of about this many transactions. Default 400. */
  targetTxs?: number;
  /** At most this many pieces per range. Default 32. */
  maxParts?: number;
}

/** Indexing tuning, shared by `TonWatchOptions` and `IndexerOptions`. */
export interface IndexingOptions {
  /** Pages fetched in parallel across all addresses and ranges. Default 16. */
  concurrency?: number;
  /** How often to look at the chain tip. Default 1000ms. */
  tickMs?: number;
  /** See `DetectMode`. Default `auto`. */
  detect?: DetectMode;
  /** Address count from which `auto` uses `blocks`. Default 50. */
  autoBlocksThreshold?: number;
  /** Poll mode: an address that keeps not changing is polled at most this rarely. Default 30s. */
  maxIdlePollMs?: number;
  /** Blocks mode: every address is also checked directly at least this often. Default 10 min. */
  reconcileMs?: number;
  /** Every address is rescanned for gaps this often (changed ones every tick). Default 60s. */
  gapScanMs?: number;
  /** First retry delay of a failing range fetch; doubles per failure. Default 1s. */
  retryMinMs?: number;
  /** Longest retry delay of a failing range fetch. Default 60s. */
  retryMaxMs?: number;
  /** Retry delay for history no server can serve (archive miss). Default 10 min. */
  archiveRetryMs?: number;
  /**
   * Cut long missing ranges into parallel pieces (needs `source.findTxNear`).
   * `false` disables it.
   */
  split?: SplitOptions | false;
  /** Optional history plug-in (see `HistorySource`), e.g. `@ton/watch/toncenter`. */
  history?: HistoryOptions;
  /**
   * Export per-address gauges (`ton_watch_address_lag_seconds`,
   * `ton_watch_address_gaps_open`), one series per address. Default false: with
   * many addresses they multiply the series a Prometheus server has to keep.
   */
  addressMetrics?: boolean;
}

/**
 * Options of a standalone `Indexer` (`@ton/watch/advanced`).
 * @experimental
 */
export interface IndexerOptions<Db = unknown> extends IndexingOptions {
  store: Store<Db>;
  source: TxSource;
  metrics?: Metrics;
  logger?: Logger;
}

/** `IndexerOptions` tuning values with defaults applied. */
export interface IndexerSettings {
  concurrency: number;
  tickMs: number;
  detect: DetectMode;
  autoBlocksThreshold: number;
  maxIdlePollMs: number;
  reconcileMs: number;
  gapScanMs: number;
  retryMinMs: number;
  retryMaxMs: number;
  archiveRetryMs: number;
  addressMetrics: boolean;
}

export const DEFAULT_SETTINGS: IndexerSettings = {
  concurrency: 16,
  tickMs: 1_000,
  detect: "auto",
  autoBlocksThreshold: 50,
  maxIdlePollMs: 30_000,
  reconcileMs: 600_000,
  gapScanMs: 60_000,
  retryMinMs: 1_000,
  retryMaxMs: 60_000,
  archiveRetryMs: 600_000,
  addressMetrics: false,
};

export const DEFAULT_SPLIT: Required<SplitOptions> = {
  minTxs: 1_000,
  targetTxs: 400,
  maxParts: 32,
};

/** Tuning values with defaults applied. Throws on a `concurrency` that would start no work. */
export function resolveSettings(options: IndexingOptions): IndexerSettings {
  const settings: IndexerSettings = {
    concurrency: options.concurrency ?? DEFAULT_SETTINGS.concurrency,
    tickMs: options.tickMs ?? DEFAULT_SETTINGS.tickMs,
    detect: options.detect ?? DEFAULT_SETTINGS.detect,
    autoBlocksThreshold: options.autoBlocksThreshold ?? DEFAULT_SETTINGS.autoBlocksThreshold,
    maxIdlePollMs: options.maxIdlePollMs ?? DEFAULT_SETTINGS.maxIdlePollMs,
    reconcileMs: options.reconcileMs ?? DEFAULT_SETTINGS.reconcileMs,
    gapScanMs: options.gapScanMs ?? DEFAULT_SETTINGS.gapScanMs,
    retryMinMs: options.retryMinMs ?? DEFAULT_SETTINGS.retryMinMs,
    retryMaxMs: options.retryMaxMs ?? DEFAULT_SETTINGS.retryMaxMs,
    archiveRetryMs: options.archiveRetryMs ?? DEFAULT_SETTINGS.archiveRetryMs,
    addressMetrics: options.addressMetrics ?? DEFAULT_SETTINGS.addressMetrics,
  };
  assertPositiveInteger("concurrency", settings.concurrency);
  return settings;
}

/** Split settings, or null when splitting is off or the source cannot find split points. */
export function resolveSplit(options: IndexerOptions<unknown>): Required<SplitOptions> | null {
  if (options.split === false || !options.source.findTxNear) return null;
  return {
    minTxs: options.split?.minTxs ?? DEFAULT_SPLIT.minTxs,
    targetTxs: options.split?.targetTxs ?? DEFAULT_SPLIT.targetTxs,
    maxParts: options.split?.maxParts ?? DEFAULT_SPLIT.maxParts,
  };
}

/** History plug-in settings, or null when none is configured or it is switched off. */
export function resolveHistory(options: IndexingOptions): Required<HistoryOptions> | null {
  if (!options.history || options.history.enabled === false) return null;
  return { mode: "fallback", enabled: true, ...options.history };
}
