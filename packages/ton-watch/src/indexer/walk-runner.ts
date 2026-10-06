import { abbreviateAddress } from "../core/address";
import { classifyError, errorMessage } from "../core/errors";
import type { TxRecord } from "../core/types";
import type { Metrics } from "../metrics/metrics";
import type { Store } from "../stores/store";
import { exponentialBackoff } from "../util/backoff";
import type { Logger } from "../util/logger";
import type { IndexerEmitter } from "./events";
import type { IndexerSettings } from "./options";
import type { PageFetcher } from "./page-fetcher";
import { isParked, type Walk } from "./walk";
import type { WalkScheduler } from "./walk-scheduler";
import type { WalkSplitter } from "./walk-splitter";

export interface WalkRunnerDeps {
  store: Store;
  fetcher: PageFetcher;
  scheduler: WalkScheduler;
  /** Null when splitting is off. */
  splitter: WalkSplitter | null;
  settings: Pick<IndexerSettings, "retryMinMs" | "retryMaxMs" | "archiveRetryMs">;
  events: IndexerEmitter;
  metrics: Metrics;
  logger: Logger;
  /** Called after a walk is done and removed from the scheduler. */
  onWalkFinished: (address: string) => void;
}

/**
 * Runs one page of a walk: fetch, store what is in range, then either move the
 * cursor down, finish the walk, or schedule a retry with backoff.
 */
export class WalkRunner {
  constructor(private readonly deps: WalkRunnerDeps) {}

  async runPage(walk: Walk): Promise<void> {
    try {
      const page = await this.deps.fetcher.fetch(walk);
      await this.storePage(walk, page);
    } catch (error) {
      this.scheduleRetry(walk, error);
    }
  }

  private async storePage(walk: Walk, page: TxRecord[]): Promise<void> {
    const { store, metrics, scheduler, splitter } = this.deps;
    walk.pages++;
    walk.fetched += page.length;
    walk.failures = 0;
    walk.lastError = undefined;

    const inScope = page.filter((tx) => tx.lt > walk.floorLt);
    const written = inScope.length > 0 ? await store.write(walk.address, inScope) : 0;
    metrics.txWritten(written);
    metrics.inc("ton_watch_pages_total", { kind: walk.kind });

    const oldest = page.at(-1)!;
    const reachedFloor = oldest.prevLt <= walk.floorLt || inScope.length < page.length;
    // Everything already stored: another walk got here first; gap scans pick up the rest.
    const overlapped = written === 0 && inScope.length > 0 && walk.pages > 1;
    if (reachedFloor || overlapped) {
      scheduler.remove(walk);
      this.deps.onWalkFinished(walk.address);
      return;
    }
    walk.cursor = { lt: oldest.prevLt, hash: oldest.prevHash };
    splitter?.maybeSplit(walk);
  }

  private scheduleRetry(walk: Walk, error: unknown): void {
    const { settings, metrics, logger, events } = this.deps;
    const kind = classifyError(error);
    walk.failures++;
    walk.lastError = kind;
    metrics.error(kind, "walk");
    const delay = isParked(walk)
      ? settings.archiveRetryMs
      : exponentialBackoff(walk.failures, settings.retryMinMs, settings.retryMaxMs);
    walk.notBefore = Date.now() + delay;

    const message =
      `[${abbreviateAddress(walk.address)}] fetch at lt ${walk.cursor.lt} failed (${kind}), ` +
      `retry in ${Math.round(delay / 1000)}s: ${errorMessage(error)}`;
    if (walk.failures === 1 || isParked(walk)) logger.warn(message);
    else logger.debug(message);
    events.emit("fetchError", walk.address, kind, error);
  }
}
