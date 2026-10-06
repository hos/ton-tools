/**
 * Every metric ton-watch exports: name, type, help text and label names. This is
 * the contract for dashboards and alerts; `Metrics` refuses anything not listed
 * here, and `toPrometheus()` takes `# HELP` and `# TYPE` from it.
 *
 * Label values are bounded: `address` series exist only with the indexer's
 * `addressMetrics` option (off by default), and `where` / `method` take values
 * from the closed sets below (anything else is reported as `other`).
 */

/** A metric's definition. */
export interface MetricDefinition {
  type: "counter" | "gauge";
  help: string;
  labels: readonly string[];
}

/**
 * Chain calls counted by `ton_watch_source_calls_total{method}`: liteserver
 * methods, and the `TxSource` methods of sources that are not liteservers.
 */
export const SOURCE_METHODS = [
  "getTip",
  "getAccountState",
  "getTransactions",
  "lookupBlock",
  "listBlockTransactions",
  "getLastTx",
  "findTxNear",
  "getTouchedAccounts",
  "other",
] as const;

export type SourceMethod = (typeof SOURCE_METHODS)[number];

/** Where a failure counted by `ton_watch_errors_total{where}` happened. */
export const ERROR_SITES = [
  "getTip",
  "getAccountState",
  "getTransactions",
  "lookupBlock",
  "listBlockTransactions",
  "getLastTx",
  "findTxNear",
  "getTouchedAccounts",
  "walk",
  "tick",
  "maintain",
  "advanceFrontier",
  "history",
  "other",
] as const;

export type ErrorSite = (typeof ERROR_SITES)[number];

/**
 * The registry. Declared `as const` (not `satisfies`, which isolated declarations
 * cannot see through); tests/metrics/registry.test.ts checks it against
 * `MetricDefinition`.
 */
export const METRICS = {
  ton_watch_build_info: {
    type: "gauge",
    help: "Always 1; the version label is the running ton-watch version.",
    labels: ["version"],
  },

  // Indexer.
  ton_watch_addresses: { type: "gauge", help: "Addresses being indexed.", labels: [] },
  ton_watch_tip_seqno: {
    type: "gauge",
    help: "Masterchain seqno of the newest chain tip seen.",
    labels: [],
  },
  ton_watch_tip_utime: {
    type: "gauge",
    help: "Unix time (seconds) of the newest chain tip seen.",
    labels: [],
  },
  ton_watch_max_lag_seconds: {
    type: "gauge",
    help: "Largest address lag: chain tip time minus the time the address was last known complete.",
    labels: [],
  },
  ton_watch_gaps_open: {
    type: "gauge",
    help: "Missing ranges currently known, over all addresses.",
    labels: [],
  },
  ton_watch_walks: { type: "gauge", help: "Missing ranges being fetched.", labels: [] },
  ton_watch_walks_stuck: {
    type: "gauge",
    help: "Missing ranges waiting for a liteserver (archival) that can serve them.",
    labels: [],
  },
  ton_watch_address_lag_seconds: {
    type: "gauge",
    help: "Chain tip time minus the time the address was last known complete; absent until known. Only with addressMetrics.",
    labels: ["address"],
  },
  ton_watch_address_gaps_open: {
    type: "gauge",
    help: "Missing ranges currently known for the address. Only with addressMetrics.",
    labels: ["address"],
  },
  ton_watch_walks_started_total: {
    type: "counter",
    help: "Walks (backward fetches over a missing range) started, by kind (head or gap).",
    labels: ["kind"],
  },
  ton_watch_pages_total: {
    type: "counter",
    help: "Transaction pages fetched and stored, by walk kind (head or gap).",
    labels: ["kind"],
  },
  ton_watch_tx_written_total: {
    type: "counter",
    help: "Transactions newly stored. Use rate() for throughput.",
    labels: [],
  },
  ton_watch_splits_total: {
    type: "counter",
    help: "Long walks split into parallel pieces.",
    labels: [],
  },
  ton_watch_split_points_total: {
    type: "counter",
    help: "Split points found for long walks.",
    labels: [],
  },
  ton_watch_detect_fallbacks_total: {
    type: "counter",
    help: "Block listings that failed, so every address was polled instead.",
    labels: [],
  },
  ton_watch_reconcile_misses_total: {
    type: "counter",
    help: "Transactions the block listing missed, found by reconciliation polling.",
    labels: [],
  },
  ton_watch_history_pages_total: {
    type: "counter",
    help: "Pages served by the history plug-in, by plug-in name and reason (fallback or boost).",
    labels: ["source", "why"],
  },

  // Chain source.
  ton_watch_source_calls_total: {
    type: "counter",
    help: "Calls to the chain, by method.",
    labels: ["method"],
  },
  ton_watch_errors_total: {
    type: "counter",
    help: "Failures by kind (see ErrorKind) and where they happened.",
    labels: ["kind", "where"],
  },

  // Consumers.
  ton_watch_consumer_delivered_total: {
    type: "counter",
    help: "Transactions handed to the consumer's handler and committed.",
    labels: ["consumer"],
  },
  ton_watch_consumer_errors_total: {
    type: "counter",
    help: "Failed handler calls.",
    labels: ["consumer"],
  },
  ton_watch_consumer_skipped_total: {
    type: "counter",
    help: 'Transactions given up on and skipped (onError "skip").',
    labels: ["consumer"],
  },
  ton_watch_consumer_dead_letters_total: {
    type: "counter",
    help: 'Transactions given up on and dead-lettered (onError "dead-letter").',
    labels: ["consumer"],
  },
  ton_watch_consumer_replayed_total: {
    type: "counter",
    help: "Dead letters replayed successfully.",
    labels: ["consumer"],
  },
  ton_watch_consumer_lag_transactions: {
    type: "gauge",
    help: "Deliverable transactions the consumer has not delivered yet.",
    labels: ["consumer"],
  },
  ton_watch_consumer_lag_seconds: {
    type: "gauge",
    help: "Age of the oldest deliverable transaction the consumer has not delivered yet.",
    labels: ["consumer"],
  },
  ton_watch_consumer_watermark_lt: {
    type: "gauge",
    help: "Global order: lt the stream is released up to. A float64, exact below 2^53 (mainnet lt is near 2^46); use it for changes(), not for lt lookups.",
    labels: ["consumer"],
  },
} as const;

export type MetricName = keyof typeof METRICS;

/** The label set a metric takes: exactly its declared labels. */
export type MetricLabels<N extends MetricName> = Record<
  (typeof METRICS)[N]["labels"][number],
  string
>;

export type CounterName = {
  [N in MetricName]: (typeof METRICS)[N]["type"] extends "counter" ? N : never;
}[MetricName];

export type GaugeName = {
  [N in MetricName]: (typeof METRICS)[N]["type"] extends "gauge" ? N : never;
}[MetricName];

/** `value` if it is in `allowed`, else `"other"`: keeps a label's values a closed set. */
export function closedLabel<T extends string>(allowed: readonly T[], value: string): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : ("other" as T);
}
