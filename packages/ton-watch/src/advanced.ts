/**
 * The building blocks behind `TonWatch`, for custom setups: the store and source
 * contracts, a standalone `Indexer` and `Consumer`, and the chain helpers a
 * custom `TxSource` or `HistorySource` needs.
 *
 * @experimental Everything here may change in any 0.x minor release. Custom
 * `Store`, `ConsumerStateStore` and `TxSource` implementations are unsupported in
 * 0.x: methods may be added to these interfaces in minor versions.
 *
 * @module
 */

export { Consumer, type ConsumerDeps } from "./consumer/consumer";
export type { ConsumerWakeEvents } from "./consumer/types";
export { analyzeChain, type ChainAnalysis, validatePage } from "./core/chain";
export { classifyError } from "./core/errors";
export { recordFromCell } from "./core/transaction";
export type { Gap } from "./core/types";
export type { IndexerEventMap } from "./indexer/events";
export { Indexer } from "./indexer/indexer";
export type { IndexerOptions } from "./indexer/options";
export type { HistorySource } from "./source/history";
export type { FindTxNearOptions, SourceCallOptions, TxSource } from "./source/source";
export type { Backlog, ConsumerLock, ConsumerStateStore } from "./stores/consumer-state";
export type { PgSession } from "./stores/pg/database";
export type {
  AddAddressOptions as StoreAddAddressOptions,
  Store,
  StoreTransaction,
} from "./stores/store";
