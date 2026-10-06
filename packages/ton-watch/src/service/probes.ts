import type { Consumer } from "../consumer/consumer";
import type { ConsumerStatus } from "../consumer/types";
import type { Metrics } from "../metrics/metrics";
import type { ServerStats } from "../source/liteserver/server-pool";
import type { Store } from "../stores/store";
import type { Health, TonWatch } from "../ton-watch";
import { consumerSummaries } from "./consumer-admin";
import type { ServiceProbe } from "./http-server";

/** `ton-watch run`: the indexer's health; status adds liteservers and webhook consumers. */
export function indexerProbe(
  watch: TonWatch,
  serverStats: () => ServerStats[],
  webhooks: readonly Consumer[] = [],
): ServiceProbe {
  return {
    metrics: () => watch.metrics.toPrometheus(),
    health: (): Health => watch.health(),
    status: () => ({
      addresses: watch.status(),
      servers: serverStats(),
      webhooks: webhooks.map((consumer) => consumer.status()),
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
