import { abbreviateAddress } from "../core/address";
import { classifyError, errorMessage } from "../core/errors";
import { txIdEquals } from "../core/types";
import type { Metrics } from "../metrics/metrics";
import type { Store } from "../stores/store";
import { mapConcurrent } from "../util/async";
import type { Logger } from "../util/logger";
import type { IndexerEmitter } from "./events";
import type { IndexerSettings } from "./options";
import type { AddressTable, TrackedAddress } from "./tracked-address";
import type { WalkScheduler } from "./walk-scheduler";

/** Gaps read per address and round; the rest are found once these are filled. */
const GAPS_PER_SCAN = 50;

export interface MaintenanceDeps {
  store: Store;
  addresses: AddressTable;
  scheduler: WalkScheduler;
  settings: Pick<IndexerSettings, "concurrency" | "gapScanMs">;
  events: IndexerEmitter;
  metrics: Metrics;
  logger: Logger;
}

/**
 * Keeps the store's derived state moving: advances frontiers, turns gaps found in
 * the store into gap walks, and records how far idle addresses are known complete.
 * Because gaps are read back from the store, a crash simply leaves gaps for the
 * next round to refill.
 */
export class Maintenance {
  private lastFullScanAt = 0;

  constructor(private readonly deps: MaintenanceDeps) {}

  /**
   * Advances frontiers and schedules walks for uncovered gaps: for addresses that
   * changed, and for all of them every `gapScanMs` (or when `all` is set).
   */
  async scanGaps(all = false): Promise<void> {
    const { addresses, settings } = this.deps;
    const now = Date.now();
    const full = all || now - this.lastFullScanAt >= settings.gapScanMs;
    if (full) this.lastFullScanAt = now;
    const targets = addresses.all().filter((tracked) => full || tracked.needsMaintenance);
    await mapConcurrent(targets, settings.concurrency, (tracked) => this.scanAddress(tracked));
  }

  /** Records `syncLt` for every address whose stored chain reaches its on-chain last tx. */
  async markSynced(): Promise<void> {
    const { store, addresses, scheduler, events } = this.deps;
    const groups = new Map<string, { syncLt: bigint; utime: number; addresses: string[] }>();
    for (const tracked of addresses.all()) {
      const observed = tracked.observed;
      if (!observed) continue;
      const address = tracked.state.address;
      if (scheduler.hasWalks(address)) continue;
      if (!isComplete(tracked) || observed.syncLt <= tracked.state.syncedLt) continue;
      const key = `${observed.syncLt}:${observed.utime}`;
      const group = groups.get(key) ?? {
        syncLt: observed.syncLt,
        utime: observed.utime,
        addresses: [],
      };
      group.addresses.push(address);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      await store.markSynced(group.addresses, group.syncLt, group.utime);
      for (const address of group.addresses) {
        const tracked = addresses.get(address);
        if (tracked && group.syncLt > tracked.state.syncedLt) {
          tracked.state.syncedLt = group.syncLt;
          tracked.state.syncedUtime = group.utime;
        }
        events.emit("synced", address, group.syncLt);
      }
    }
  }

  /** A walk finished: its range is stored, so the frontier may move. */
  onWalkFinished(address: string): void {
    const { store, addresses, events, metrics } = this.deps;
    const tracked = addresses.get(address);
    if (!tracked) return;
    tracked.needsMaintenance = true;
    void store
      .advanceFrontier(address)
      .then((frontier) => {
        if (frontier && frontier.lt !== tracked.state.frontier?.lt) {
          tracked.state.frontier = frontier;
          events.emit("frontier", address, frontier.lt);
        }
      })
      .catch((error) => metrics.error(classifyError(error), "advanceFrontier"));
  }

  private async scanAddress(tracked: TrackedAddress): Promise<void> {
    const { store, scheduler, events, metrics, logger } = this.deps;
    tracked.needsMaintenance = false;
    const address = tracked.state.address;
    try {
      const previousLt = tracked.state.frontier?.lt;
      const frontier = await store.advanceFrontier(address);
      tracked.state.frontier = frontier;
      if (frontier && frontier.lt !== previousLt) events.emit("frontier", address, frontier.lt);

      const gaps = await store.findGaps(address, GAPS_PER_SCAN);
      tracked.gapsOpen = gaps.length;
      for (const gap of gaps) {
        if (scheduler.covers(address, gap.prevLt)) continue;
        scheduler.add({
          address,
          kind: "gap",
          cursor: { lt: gap.prevLt, hash: gap.prevHash },
          floorLt: gap.floorLt,
          topLt: gap.prevLt,
        });
      }
    } catch (error) {
      tracked.needsMaintenance = true;
      metrics.error(classifyError(error), "maintain");
      logger.warn(`[${abbreviateAddress(address)}] maintenance failed:`, errorMessage(error));
    }
  }
}

/** Everything up to the address's on-chain last transaction is stored and linked. */
function isComplete(tracked: TrackedAddress): boolean {
  const { state, observed } = tracked;
  const lastTx = observed?.lastTx;
  const lastInScope = lastTx && lastTx.lt > state.startLt ? lastTx : null;
  if (lastInScope) {
    return txIdEquals(state.head, lastInScope) && txIdEquals(state.frontier, state.head);
  }
  return txIdEquals(state.frontier, state.head);
}
