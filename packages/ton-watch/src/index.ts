/**
 * ton-watch: an embeddable, ordered transaction indexer for a set of TON addresses.
 *
 * Start with `TonWatch`: give it a store (`PgStore` or `MemoryStore`) and a source
 * (`LiteSource`), add addresses, and register consumers with `process()`.
 *
 * Other entry points:
 * - `@ton/watch/toncenter`: the toncenter history plug-in.
 * - `@ton/watch/parse`: typed views of transactions (transfers, jettons, NFTs).
 * - `@ton/watch/webhook`: verifying the service's webhook deliveries.
 * - `@ton/watch/advanced` (experimental): the building blocks behind `TonWatch`,
 *   for custom stores, sources and setups.
 *
 * Every error ton-watch throws on purpose is a `TonWatchError`; match on its
 * `code` with `isTonWatchError`.
 *
 * @module
 */

export type { Consumer } from "./consumer/consumer";
export { ConsumerLockedError, CursorConflictError } from "./consumer/errors";
export type {
  AddressLag,
  ConsumerEventMap,
  ConsumerLag,
  ConsumerStatus,
  FailurePolicy,
  HandlerContext,
  HandlerFailure,
  LockMode,
  ProcessOptions,
  RewindOptions,
  RewindTarget,
  TxHandler,
} from "./consumer/types";
export { type AddressInput, toRawAddress } from "./core/address";
export {
  type ErrorKind,
  isTonWatchError,
  SourceError,
  type SourceErrorCode,
  TonWatchError,
  type TonWatchErrorCode,
} from "./core/errors";
export type { AddressState, IndexedTx, TxId, TxRecord } from "./core/types";
export type { DetectMode, IndexingOptions, SplitOptions } from "./indexer/options";
export type { AddressStatus } from "./indexer/status";
export { Metrics } from "./metrics/metrics";
export type { HistoryOptions } from "./source/history";
export { LiteSource, type LiteSourceOptions } from "./source/liteserver/lite-source";
export type { ServerStats } from "./source/liteserver/server-pool";
export type { BlockRef, ChainTip, ShardTop } from "./source/source";
export type {
  ConsumerOrder,
  ConsumerRecord,
  CursorState,
  DeadLetter,
  DeadLetterFilter,
} from "./stores/consumer-state";
export { MemoryStore } from "./stores/memory/memory-store";
export type { PgDatabase, PgQueryable } from "./stores/pg/database";
export { MigrationError, type MigrationErrorCode } from "./stores/pg/migrator";
export { PgStore, type PgStoreOptions } from "./stores/pg/pg-store";
export {
  type AddAddressOptions,
  type Health,
  type HealthOptions,
  type RemoveAddressOptions,
  TonWatch,
  type TonWatchEventMap,
  type TonWatchOptions,
} from "./ton-watch";
export { consoleLogger, type Logger, type LogLevel, silentLogger } from "./util/logger";
