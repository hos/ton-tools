import type { Consumer } from "../consumer/consumer";
import type { ConsumerStatus } from "../consumer/types";
import type { Metrics } from "../metrics/metrics";
import type { ServerStats } from "../source/liteserver/server-pool";
import type { Store } from "../stores/store";
import type { Health, TonWatch } from "../ton-watch";
import { consumerSummaries } from "./consumer-admin";
import type { ServiceProbe } from "./http-server";

/** `ton-watch run` health: the indexer's, made worse by any webhook consumer's problems. */
export interface RunHealth extends Health {
  /** Webhook consumers reported on. */
  webhooks: number;
}

/**
 * `ton-watch run`: the indexer's health combined with that of the webhook
 * consumers; status adds liteservers and webhook consumers.
 */
export function indexerProbe(
  watch: TonWatch,
  serverStats: () => ServerStats[],
  webhooks: readonly Consumer[] = [],
): ServiceProbe {
  const statuses = () => webhooks.map((consumer) => consumer.status());
  return {
    metrics: () => watch.metrics.toPrometheus(),
    health: () => runHealth(watch.health(), deliveryHealth(statuses())),
    status: () => ({
      addresses: watch.status(),
      servers: serverStats(),
      webhooks: statuses(),
    }),
    consumers: () => consumerSummaries(watch.store),
  };
}

export interface DeliveryHealth {
  /** `down`: a consumer is not running; `degraded`: an address is waiting to retry. */
  status: "ok" | "degraded" | "down";
  running: boolean;
  webhooks: number;
  reasons: string[];
}

/** `ton-watch deliver`: health from the webhook consumers alone. */
export function deliveryProbe(
  metrics: Metrics,
  webhooks: readonly Consumer[],
  store: Store,
): ServiceProbe {
  const statuses = () => webhooks.map((consumer) => consumer.status());
  return {
    metrics: () => metrics.toPrometheus(),
    health: () => deliveryHealth(statuses()),
    status: () => ({ webhooks: statuses() }),
    consumers: () => consumerSummaries(store),
  };
}

const SEVERITY = { ok: 0, degraded: 1, down: 2 } as const;

/** The worse of the two statuses, with the reasons of both. */
export function runHealth(indexer: Health, delivery: DeliveryHealth): RunHealth {
  const status =
    SEVERITY[delivery.status] > SEVERITY[indexer.status] ? delivery.status : indexer.status;
  return {
    ...indexer,
    status,
    webhooks: delivery.webhooks,
    reasons: [...indexer.reasons, ...delivery.reasons],
  };
}

export function deliveryHealth(statuses: ConsumerStatus[]): DeliveryHealth {
  const stopped = statuses.filter((status) => !status.running);
  const reasons = [
    ...stopped.map((status) => `${status.name} not running`),
    ...statuses.flatMap((status) =>
      status.addresses
        .filter((lane) => lane.halted)
        .map((lane) => `${status.name} retrying ${lane.address}: ${lane.lastError ?? "failed"}`),
    ),
  ];
  return {
    status: stopped.length > 0 ? "down" : reasons.length > 0 ? "degraded" : "ok",
    running: stopped.length === 0,
    webhooks: statuses.length,
    reasons,
  };
}
