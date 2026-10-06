/**
 * The JSON the service prints and serves: one explicit type per output, built
 * from internal objects by the functions below so that internal changes never
 * leak into it. Every bigint (lt) is a decimal string, every hash lowercase hex,
 * every time an ISO 8601 string, every address raw (`<workchain>:<hex>`).
 *
 * Stability:
 * - Stable (versioned with `version: 1`): `/health`, `/consumers` and the JSON of
 *   the `list`, `consumers` and `dead-letters` commands. Fields may be added;
 *   removing, renaming or changing the meaning of one bumps `version`. Readers
 *   must ignore fields and enum values they do not know.
 * - Unstable: `/status`, a debugging view whose shape may change in any release.
 * - `/metrics` follows the metric names and labels in `METRICS` (metrics/registry.ts).
 *
 * @module
 */
import type { ConsumerStatus } from "../consumer/types";
import type { AddressState, TxId } from "../core/types";
import type { AddressStatus } from "../indexer/status";
import type { ServerStats } from "../source/liteserver/server-pool";
import type { ConsumerOrder, DeadLetter } from "../stores/consumer-state";
import type { Health } from "../ton-watch";

/** Version of the stable outputs; see the module documentation. */
export const OUTPUT_VERSION = 1;

/** Decimal string of an unsigned 64-bit integer (lt). */
export type DecimalString = string;

export type HealthStatus = "ok" | "degraded" | "down";

// ----------------------------------------------------------------- /health

/**
 * `/health`, the same shape under `run` and `deliver`. Answered with 503 when
 * `status` is `down`, 200 otherwise.
 */
export interface HealthResponse {
  version: typeof OUTPUT_VERSION;
  /** The worst of the components' statuses. */
  status: HealthStatus;
  /** Every component's reasons, prefixed with the component. */
  reasons: string[];
  components: {
    /** The indexer; null under `deliver`, which does not index. */
    indexer: IndexerHealthJson | null;
    /** One per configured webhook target. */
    webhooks: WebhookHealthJson[];
  };
}

export interface IndexerHealthJson {
  /** `down`: not running or not ticking; `degraded`: running with problems. */
  status: HealthStatus;
  reasons: string[];
  running: boolean;
  tip: { seqno: number; utime: number; ageSeconds: number } | null;
  addresses: number;
  /** Worst address lag; null before any address has been synced. */
  maxLagSeconds: number | null;
  gapsOpen: number;
  stuckRanges: number;
  /** Transactions written per second over the last minute. */
  txWrittenPerSecond: number;
}

export interface WebhookHealthJson {
  /** Consumer name, `webhook:<target>`. */
  name: string;
  /** `down`: not running; `degraded`: an address is waiting to retry a failed request. */
  status: HealthStatus;
  reasons: string[];
  running: boolean;
  /** Waiting for another instance of the same consumer to stop. */
  waitingForLock: boolean;
  /** Addresses waiting to retry a failed request. */
  retrying: number;
}

const SEVERITY: Record<HealthStatus, number> = { ok: 0, degraded: 1, down: 2 };

/** `/health` from the indexer's health (null under `deliver`) and the webhook consumers. */
export function healthResponse(
  indexer: Health | null,
  webhooks: readonly ConsumerStatus[],
): HealthResponse {
  const components = {
    indexer: indexer && indexerHealthJson(indexer),
    webhooks: webhooks.map(webhookHealthJson),
  };
  const all = [...(components.indexer ? [components.indexer] : []), ...components.webhooks];
  const status = all.reduce<HealthStatus>(
    (worst, { status }) => (SEVERITY[status] > SEVERITY[worst] ? status : worst),
    "ok",
  );
  return {
    version: OUTPUT_VERSION,
    status,
    reasons: [
      ...(components.indexer?.reasons.map((reason) => `indexer: ${reason}`) ?? []),
      ...components.webhooks.flatMap(({ name, reasons }) =>
        reasons.map((reason) => `${name}: ${reason}`),
      ),
    ],
    components,
  };
}

function indexerHealthJson(health: Health): IndexerHealthJson {
  return {
    status: health.status,
    reasons: [...health.reasons],
    running: health.running,
    tip: health.tip && {
      seqno: health.tip.seqno,
      utime: health.tip.utime,
      ageSeconds: health.tip.ageSeconds,
    },
    addresses: health.addresses,
    maxLagSeconds: health.maxLagSeconds,
    gapsOpen: health.gapsOpen,
    stuckRanges: health.stuckRanges,
    txWrittenPerSecond: health.txWrittenPerSecond,
  };
}

function webhookHealthJson(status: ConsumerStatus): WebhookHealthJson {
  const retrying = status.addresses.filter((lane) => lane.halted);
  const reasons = [
    ...(status.running ? [] : [status.waitingForLock ? "waiting for its lock" : "not running"]),
    ...retrying.map((lane) => `retrying ${lane.address}: ${lane.lastError ?? "failed"}`),
  ];
  return {
    name: status.name,
    status: !status.running ? "down" : retrying.length > 0 ? "degraded" : "ok",
    reasons,
    running: status.running,
    waitingForLock: status.waitingForLock,
    retrying: retrying.length,
  };
}

// ----------------------------------------------------------------- /status (unstable)

/** `/status`: a debugging view, unstable (no `version`; may change in any release). */
export interface StatusResponse {
  mode: "run" | "deliver";
  /** Per-address indexing progress; null under `deliver`. */
  addresses: AddressStatusJson[] | null;
  /** Liteservers; null under `deliver`. */
  servers: ServerStatsJson[] | null;
  webhooks: ConsumerStatusJson[];
}

export interface AddressStatusJson {
  address: string;
  head: DecimalString | null;
  frontier: DecimalString | null;
  syncedLt: DecimalString;
  lagSeconds: number | null;
  gapsOpen: number;
  walks: number;
  stuck: number;
}

export interface ServerStatsJson {
  id: string;
  archive: boolean;
  ready: boolean;
  inFlight: number;
  latencyMs: number;
  calls: number;
  coolingDownMs: number;
  /** Failures by error kind. */
  errors: Record<string, number>;
}

export interface ConsumerStatusJson {
  name: string;
  running: boolean;
  waitingForLock: boolean;
  /** Transactions delivered since this process started. */
  delivered: number;
  /** Last measured lag; null before the first measurement. */
  lag: {
    transactions: number;
    lt: DecimalString;
    seconds: number;
    addresses: {
      address: string;
      cursor: DecimalString;
      transactions: number;
      lt: DecimalString;
      seconds: number;
    }[];
  } | null;
  addresses: {
    address: string;
    /** Lt of the last delivered transaction; null before the first. */
    cursor: DecimalString | null;
    /** Waiting to retry a failed handler call. */
    halted: boolean;
    failures: number;
    lastError: string | null;
  }[];
}

/** `/status` of `ton-watch run`. */
export function runStatusResponse(
  addresses: readonly AddressStatus[],
  servers: readonly ServerStats[],
  webhooks: readonly ConsumerStatus[],
): StatusResponse {
  return {
    mode: "run",
    addresses: addresses.map(addressStatusJson),
    servers: servers.map(serverStatsJson),
    webhooks: webhooks.map(consumerStatusJson),
  };
}

/** `/status` of `ton-watch deliver`. */
export function deliverStatusResponse(webhooks: readonly ConsumerStatus[]): StatusResponse {
  return {
    mode: "deliver",
    addresses: null,
    servers: null,
    webhooks: webhooks.map(consumerStatusJson),
  };
}

function addressStatusJson(status: AddressStatus): AddressStatusJson {
  return {
    address: status.address,
    head: optionalDecimal(status.head),
    frontier: optionalDecimal(status.frontier),
    syncedLt: status.syncedLt.toString(),
    lagSeconds: status.lagSeconds,
    gapsOpen: status.gapsOpen,
    walks: status.walks,
    stuck: status.stuck,
  };
}

function serverStatsJson(stats: ServerStats): ServerStatsJson {
  const errors: Record<string, number> = {};
  for (const [kind, count] of Object.entries(stats.errors)) {
    if (count !== undefined) errors[kind] = count;
  }
  return {
    id: stats.id,
    archive: stats.archive,
    ready: stats.ready,
    inFlight: stats.inFlight,
    latencyMs: stats.latencyMs,
    calls: stats.calls,
    coolingDownMs: stats.coolingDownMs,
    errors,
  };
}

function consumerStatusJson(status: ConsumerStatus): ConsumerStatusJson {
  return {
    name: status.name,
    running: status.running,
    waitingForLock: status.waitingForLock,
    delivered: status.delivered,
    lag: status.lag && {
      transactions: status.lag.transactions,
      lt: status.lag.lt.toString(),
      seconds: status.lag.seconds,
      addresses: status.lag.addresses.map((lag) => ({
        address: lag.address,
        cursor: lag.cursor.toString(),
        transactions: lag.transactions,
        lt: lag.lt.toString(),
        seconds: lag.seconds,
      })),
    },
    addresses: status.addresses.map((lane) => ({
      address: lane.address,
      cursor: optionalDecimal(lane.cursor),
      halted: lane.halted,
      failures: lane.failures,
      lastError: lane.lastError ?? null,
    })),
  };
}

// ----------------------------------------------------------------- /consumers, `consumers`

/** `/consumers` and `ton-watch consumers`: every consumer in the database. */
export interface ConsumersResponse {
  version: typeof OUTPUT_VERSION;
  consumers: ConsumerSummaryJson[];
}

export interface ConsumerSummaryJson {
  name: string;
  /** Order it last ran with; null if unknown. */
  order: ConsumerOrder | null;
  /** When it first ran (ISO 8601); null if unknown. */
  createdAt: string | null;
  /** Addresses it has a cursor on. */
  addresses: number;
  /** Addresses whose next transaction has failed at least once. */
  failing: number;
  /** Its backlog: transactions summed, lt and seconds the maximum over its addresses. */
  lag: { transactions: number; lt: DecimalString; seconds: number };
  deadLetters: number;
}

/** A consumer summary as `consumerSummaries` computes it. */
export interface ConsumerSummary {
  name: string;
  order: ConsumerOrder | null;
  createdAt: Date | null;
  addresses: number;
  failing: number;
  lag: { transactions: number; lt: bigint; seconds: number };
  deadLetters: number;
}

export function consumersResponse(summaries: readonly ConsumerSummary[]): ConsumersResponse {
  return {
    version: OUTPUT_VERSION,
    consumers: summaries.map((summary) => ({
      name: summary.name,
      order: summary.order,
      createdAt: summary.createdAt?.toISOString() ?? null,
      addresses: summary.addresses,
      failing: summary.failing,
      lag: {
        transactions: summary.lag.transactions,
        lt: summary.lag.lt.toString(),
        seconds: summary.lag.seconds,
      },
      deadLetters: summary.deadLetters,
    })),
  };
}

// ----------------------------------------------------------------- `dead-letters`

/** `ton-watch dead-letters`. */
export interface DeadLettersResponse {
  version: typeof OUTPUT_VERSION;
  /** Oldest first, by consumer, address and lt. */
  deadLetters: DeadLetterJson[];
}

export interface DeadLetterJson {
  consumer: string;
  address: string;
  lt: DecimalString;
  /** Transaction hash, hex. */
  hash: string;
  /** Message of the last error. */
  error: string;
  attempts: number;
  /** ISO 8601. */
  firstFailureAt: string;
  /** ISO 8601. */
  lastFailureAt: string;
}

export function deadLettersResponse(letters: readonly DeadLetter[]): DeadLettersResponse {
  return {
    version: OUTPUT_VERSION,
    deadLetters: letters.map((letter) => ({
      consumer: letter.consumer,
      address: letter.address,
      lt: letter.lt.toString(),
      hash: letter.hash.toString("hex"),
      error: letter.error,
      attempts: letter.attempts,
      firstFailureAt: letter.firstFailureAt.toISOString(),
      lastFailureAt: letter.lastFailureAt.toISOString(),
    })),
  };
}

// ----------------------------------------------------------------- `list`

/** `ton-watch list`: every watched address. */
export interface AddressListResponse {
  version: typeof OUTPUT_VERSION;
  addresses: AddressJson[];
}

export interface TxIdJson {
  lt: DecimalString;
  /** Hex. */
  hash: string;
}

export interface AddressJson {
  address: string;
  /** Transactions at or below this lt are out of scope. */
  startLt: DecimalString;
  /** False once removed without `--purge`. */
  active: boolean;
  /** Newest stored transaction. */
  head: TxIdJson | null;
  /** Newest transaction with every one down to `startLt` stored. */
  frontier: TxIdJson | null;
  /** Lt up to which the address is known complete. */
  syncedLt: DecimalString;
  /** Chain time (unix seconds) at which `syncedLt` was observed. */
  syncedUtime: number | null;
}

export function addressListResponse(states: readonly AddressState[]): AddressListResponse {
  return {
    version: OUTPUT_VERSION,
    addresses: states.map((state) => ({
      address: state.address,
      startLt: state.startLt.toString(),
      active: state.active,
      head: txIdJson(state.head),
      frontier: txIdJson(state.frontier),
      syncedLt: state.syncedLt.toString(),
      syncedUtime: state.syncedUtime,
    })),
  };
}

// ----------------------------------------------------------------- helpers

/** Pretty-printed JSON of one of the outputs above. */
export const toJson = (value: unknown): string => JSON.stringify(value, null, 2);

const optionalDecimal = (value: bigint | null): DecimalString | null =>
  value === null ? null : value.toString();

const txIdJson = (id: TxId | null): TxIdJson | null =>
  id && { lt: id.lt.toString(), hash: id.hash.toString("hex") };
