import type { TxId, TxRecord } from "../core/types";
import type { SourceCallOptions } from "./call-options";

/**
 * Optional plug-in that serves account history with bigger pages and deeper
 * retention than liteservers (e.g. `@ton/watch/toncenter`). The indexer only ever
 * asks it for the same thing it asks liteservers — "transactions of this address,
 * newest first, starting at this one" — and checks every page the same way, so a
 * history source can make fetching faster or reach further back, but cannot change
 * what gets stored.
 *
 * @experimental Methods may be added in minor 0.x versions. Exported from
 * `@ton/watch/advanced`.
 */
export interface HistorySource {
  readonly name: string;
  /** Largest page it serves (toncenter: up to 1000). */
  readonly maxPageSize: number;
  /** Like `TxSource.getTransactions`; should honor `options.signal` the same way. */
  getTransactions(
    address: string,
    from: TxId,
    count: number,
    options?: SourceCallOptions,
  ): Promise<TxRecord[]>;
  /** True while it has no spare capacity (rate budget used up); `boost` mode then uses liteservers. */
  busy?(): boolean;
  close?(): Promise<void>;
}

export interface HistoryOptions {
  source: HistorySource;
  /**
   * - `fallback` (default): liteservers first; the history source only for ranges
   *   no liteserver serves any more (older than ~5 weeks on public servers).
   * - `boost`: also use it whenever it has spare capacity, for its bigger pages.
   */
  mode?: "fallback" | "boost";
  /** Off switch without removing the wiring. Default true. */
  enabled?: boolean;
}
