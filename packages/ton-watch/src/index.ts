/**
 * ton-watch: an embeddable, ordered transaction indexer for a set of TON addresses.
 *
 * Start with `TonWatch`; the building blocks (`Indexer`, `Consumer`, stores and
 * sources) are exported for custom setups. The toncenter history plug-in lives in
 * the separate `ton-watch/toncenter` entry point.
 *
 * @module
 */

export { Consumer, type ConsumerDeps } from "./consumer/consumer";
export { ConsumerLockedError, CursorConflictError } from "./consumer/errors";
export type {
  AddressLag,
  ConsumerEventMap,
  ConsumerLag,
  ConsumerStatus,
  ConsumerWakeEvents,
  FailurePolicy,
  HandlerContext,
  HandlerFailure,
  LockMode,
  ProcessOptions,
  RewindOptions,
  RewindTarget,
  TxHandler,
} from "./consumer/types";
export { analyzeChain, type ChainAnalysis, validatePage } from "./core/chain";
export { classifyError, type ErrorKind, SourceError } from "./core/errors";
export { recordFromCell } from "./core/transaction";
export {
  type AddressState,
  completeUpTo,
  type Gap,
  type IndexedTx,
  type TxId,
  type TxRecord,
  toIndexedTx,
  txIdEquals,
} from "./core/types";
export type { IndexerEventMap } from "./indexer/events";
export { Indexer } from "./indexer/indexer";
export type { DetectMode, IndexerOptions, SplitOptions } from "./indexer/options";
export type { AddressStatus } from "./indexer/status";
export { Metrics } from "./metrics/metrics";
export type { HistoryOptions, HistorySource } from "./source/history";
export { LiteSource, type LiteSourceOptions } from "./source/liteserver/lite-source";
export {
  type PoolMember,
  ServerPool,
  type ServerPoolOptions,
  type ServerStats,
} from "./source/liteserver/server-pool";
export type { BlockRef, ChainTip, ShardTop, TxSource } from "./source/source";
export type {
  Backlog,
  ConsumerLock,
  ConsumerOrder,
  ConsumerRecord,
  ConsumerStateStore,
  CursorState,
  DeadLetter,
  DeadLetterFilter,
} from "./stores/consumer-state";
export { MemoryStore } from "./stores/memory/memory-store";
export {
  type PgDatabase,
  type PgQueryable,
  type PgSession,
  poolDatabase,
} from "./stores/pg/database";
export { MigrationError, type MigrationErrorCode } from "./stores/pg/migrator";
export { PgStore, type PgStoreOptions } from "./stores/pg/pg-store";
export type {
  AddAddressOptions as StoreAddAddressOptions,
  Store,
  StoreTransaction,
} from "./stores/store";
export {
  type AddAddressOptions,
  type Health,
  TonWatch,
  type TonWatchOptions,
  toRaw,
} from "./ton-watch";
export { consoleLogger, type Logger, type LogLevel, silentLogger } from "./util/logger";
