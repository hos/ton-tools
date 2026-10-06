import { validatePage } from "../core/chain";
import { classifyError } from "../core/errors";
import type { TxRecord } from "../core/types";
import type { Metrics } from "../metrics/metrics";
import type { HistoryOptions } from "../source/history";
import type { TxSource } from "../source/source";
import type { WalkRange } from "./walk";

/**
 * Fetches one page of a walk: from liteservers, or from the history plug-in when
 * one is configured. Every page is validated against the cursor before it is
 * returned, whichever side served it.
 */
export class PageFetcher {
  constructor(
    private readonly source: TxSource,
    private readonly history: Required<HistoryOptions> | null,
    private readonly metrics: Metrics,
  ) {}

  async fetch(walk: Pick<WalkRange, "address" | "cursor">): Promise<TxRecord[]> {
    const history = this.history;
    if (history?.mode === "boost" && !history.source.busy?.()) {
      try {
        return await this.fetchFromHistory(history, walk, "boost");
      } catch (error) {
        this.metrics.error(classifyError(error), "history");
      }
    }
    try {
      const page = await this.source.getTransactions(
        walk.address,
        walk.cursor,
        this.source.maxPageSize,
      );
      validatePage(walk.cursor, page);
      return page;
    } catch (error) {
      if (!history || classifyError(error) !== "archive_unavailable") throw error;
      try {
        return await this.fetchFromHistory(history, walk, "fallback");
      } catch (historyError) {
        this.metrics.error(classifyError(historyError), "history");
        throw error;
      }
    }
  }

  private async fetchFromHistory(
    history: Required<HistoryOptions>,
    walk: Pick<WalkRange, "address" | "cursor">,
    reason: "boost" | "fallback",
  ): Promise<TxRecord[]> {
    const { source } = history;
    const page = await source.getTransactions(walk.address, walk.cursor, source.maxPageSize);
    validatePage(walk.cursor, page);
    this.metrics.inc("ton_watch_history_pages_total", { source: source.name, why: reason });
    return page;
  }
}
