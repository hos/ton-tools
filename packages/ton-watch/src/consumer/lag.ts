import { watermarkOf } from "../core/types";
import type { Metrics } from "../metrics/metrics";
import type { ConsumerOrder } from "../stores/consumer-state";
import type { Store } from "../stores/store";
import type { AddressLag, ConsumerLag } from "./types";

/**
 * Measures how far `consumer` is behind on the addresses it has cursors on: up to
 * each frontier, or in global order up to the watermark of those addresses.
 */
export async function measureLag(
  store: Store,
  consumer: string,
  order: ConsumerOrder,
  nowMs = Date.now(),
): Promise<ConsumerLag> {
  let uptoLt: bigint | undefined;
  if (order === "global") {
    const addresses = new Set((await store.listCursors(consumer)).map((cursor) => cursor.address));
    const states = (await store.listAddresses()).filter((state) => addresses.has(state.address));
    uptoLt = watermarkOf(states) ?? undefined;
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  const addresses: AddressLag[] = (await store.backlog(consumer, uptoLt)).map((backlog) => ({
    address: backlog.address,
    cursor: backlog.cursor,
    transactions: backlog.transactions,
    lt: backlog.newestLt === null ? 0n : backlog.newestLt - backlog.cursor,
    seconds: backlog.oldestUtime === null ? 0 : Math.max(0, nowSeconds - backlog.oldestUtime),
  }));
  return {
    transactions: addresses.reduce((sum, lag) => sum + lag.transactions, 0),
    lt: addresses.reduce((max, lag) => (lag.lt > max ? lag.lt : max), 0n),
    seconds: addresses.reduce((max, lag) => Math.max(max, lag.seconds), 0),
    addresses,
  };
}

/** Publishes `ton_watch_consumer_lag_*` gauges for one consumer. */
export function recordLagGauges(metrics: Metrics, consumer: string, lag: ConsumerLag): void {
  const labels = { consumer };
  metrics.set("ton_watch_consumer_lag_transactions", lag.transactions, labels);
  metrics.set("ton_watch_consumer_lag_seconds", lag.seconds, labels);
}
