import type { Consumer } from "../consumer/consumer";
import type { Metrics } from "../metrics/metrics";
import type { ServerStats } from "../source/liteserver/server-pool";
import type { Store } from "../stores/store";
import type { TonWatch } from "../ton-watch";
import { consumerSummaries } from "./consumer-admin";
import type { ServiceProbe } from "./http-server";
import {
  consumersResponse,
  deliverStatusResponse,
  healthResponse,
  runStatusResponse,
} from "./output";

/** `ton-watch run`: the indexer and the webhook consumers it runs. */
export function indexerProbe(
  watch: TonWatch,
  serverStats: () => ServerStats[],
  webhooks: readonly Consumer[] = [],
): ServiceProbe {
  const statuses = () => webhooks.map((consumer) => consumer.status());
  return {
    metrics: () => watch.metrics.toPrometheus(),
    health: () => healthResponse(watch.health(), statuses()),
    status: () => runStatusResponse(watch.status(), serverStats(), statuses()),
    consumers: async () => consumersResponse(await consumerSummaries(watch.store)),
  };
}

/** `ton-watch deliver`: the webhook consumers alone. */
export function deliveryProbe(
  metrics: Metrics,
  webhooks: readonly Consumer[],
  store: Store,
): ServiceProbe {
  const statuses = () => webhooks.map((consumer) => consumer.status());
  return {
    metrics: () => metrics.toPrometheus(),
    health: () => healthResponse(null, statuses()),
    status: () => deliverStatusResponse(statuses()),
    consumers: async () => consumersResponse(await consumerSummaries(store)),
  };
}
