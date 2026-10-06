import type { Metrics } from "../metrics/metrics";
import type { ChainTip } from "../source/source";
import type { TrackedAddress } from "./tracked-address";
import { isParked, type Walk } from "./walk";

/** Indexing progress of one address. */
export interface AddressStatus {
  address: string;
  /** Newest stored transaction lt. */
  head: bigint | null;
  /** Newest lt with everything below it stored. */
  frontier: bigint | null;
  syncedLt: bigint;
  /** Seconds between the chain tip and the last time the address was known complete. */
  lagSeconds: number | null;
  gapsOpen: number;
  /** Missing ranges being fetched. */
  walks: number;
  /** Walks waiting on history no server could serve. */
  stuck: number;
}

export function addressStatus(
  tracked: TrackedAddress,
  walks: Walk[],
  tip: ChainTip | null,
): AddressStatus {
  const { state } = tracked;
  return {
    address: state.address,
    head: state.head?.lt ?? null,
    frontier: state.frontier?.lt ?? null,
    syncedLt: state.syncedLt,
    lagSeconds:
      tip && state.syncedUtime != null ? Math.max(0, tip.utime - state.syncedUtime) : null,
    gapsOpen: tracked.gapsOpen,
    walks: walks.length,
    stuck: walks.filter(isParked).length,
  };
}

/**
 * Publishes indexer-wide gauges and, if `perAddress`, per-address lag and gap
 * gauges. Per-address series are rebuilt each time, so a removed address loses
 * its series and an address whose lag is unknown has no lag series.
 */
export function recordGauges(
  metrics: Metrics,
  statuses: AddressStatus[],
  walks: Walk[],
  perAddress: boolean,
): void {
  metrics.set("ton_watch_addresses", statuses.length);
  metrics.set("ton_watch_walks", walks.length);
  metrics.set("ton_watch_walks_stuck", walks.filter(isParked).length);
  metrics.remove("ton_watch_address_lag_seconds");
  metrics.remove("ton_watch_address_gaps_open");
  let gapsOpen = 0;
  let maxLagSeconds = 0;
  for (const status of statuses) {
    gapsOpen += status.gapsOpen;
    if (status.lagSeconds != null) maxLagSeconds = Math.max(maxLagSeconds, status.lagSeconds);
    if (perAddress) {
      const labels = { address: status.address };
      if (status.lagSeconds != null) {
        metrics.set("ton_watch_address_lag_seconds", status.lagSeconds, labels);
      }
      metrics.set("ton_watch_address_gaps_open", status.gapsOpen, labels);
    }
  }
  metrics.set("ton_watch_gaps_open", gapsOpen);
  metrics.set("ton_watch_max_lag_seconds", maxLagSeconds);
}
