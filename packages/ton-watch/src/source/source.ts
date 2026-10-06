import type { TxId, TxRecord } from "../core/types";
import type { Metrics } from "../metrics/metrics";
import type { SourceCallOptions } from "./call-options";

/** Full identifier of a block. */
export interface BlockRef {
  workchain: number;
  /** Shard id as a signed 64-bit decimal string. */
  shard: string;
  seqno: number;
  rootHash: Buffer;
  fileHash: Buffer;
}

/** The newest block of one shard as of a masterchain block. */
export interface ShardTop extends BlockRef {
  /** Logical time at the end of the block. */
  endLt: bigint;
}

/** A masterchain block the indexer works against. */
export interface ChainTip {
  seqno: number;
  utime: number;
  block: BlockRef;
  /** Top block of every shard as of this masterchain block. */
  shards: ShardTop[];
  /**
   * Every transaction with `lt <= syncLt`, of any account, is final and visible at
   * this block (min `end_lt` over the shard tops). An address whose last
   * transaction at this block is already stored is complete up to `syncLt`.
   */
  syncLt: bigint;
}

export type { SourceCallOptions };

/** Options of `TxSource.findTxNear`. */
export interface FindTxNearOptions extends SourceCallOptions {
  /** Average lt distance between the account's transactions, to budget the search. */
  ltPerTx?: number;
}

/**
 * Where transactions come from. `LiteSource` is the liteserver implementation; tests
 * use a fake. Every method may throw a `SourceError`, and takes an optional
 * `SourceCallOptions` whose `signal` it should honor (a source that ignores it
 * still works; a stopping indexer then just stops waiting for it).
 *
 * @experimental Custom implementations are unsupported in 0.x: methods may be
 * added in minor versions. Exported from `@ton/watch/advanced`.
 */
export interface TxSource {
  getTip(options?: SourceCallOptions): Promise<ChainTip>;

  /** Last transaction of `address` as of `tip`, or null if it has none. */
  getLastTx(address: string, tip: ChainTip, options?: SourceCallOptions): Promise<TxId | null>;

  /**
   * Up to `count` transactions of `address`, newest first, starting at `from`
   * (inclusive) and walking back through prev links.
   */
  getTransactions(
    address: string,
    from: TxId,
    count: number,
    options?: SourceCallOptions,
  ): Promise<TxRecord[]>;

  /**
   * Accounts that had transactions in blocks after `prev` up to `next`, with their
   * newest transaction. Returns null when it cannot tell (shard split/merge, too
   * far behind); the caller then falls back to polling every address.
   */
  getTouchedAccounts?(
    prev: ChainTip,
    next: ChainTip,
    workchains: ReadonlySet<number>,
    options?: SourceCallOptions,
  ): Promise<Map<string, TxId> | null>;

  /**
   * Optional: some transaction of `address` with lt at or below `lt`, close to it.
   * Lets the indexer cut one long missing range into pieces fetched in parallel
   * (a single range is otherwise a strictly sequential walk, one page per round
   * trip). Returns null when nothing is found cheaply.
   */
  findTxNear?(address: string, lt: bigint, options?: FindTxNearOptions): Promise<TxId | null>;

  /** Largest `count` that `getTransactions` honors. */
  readonly maxPageSize: number;
  /** When set, the indexer records into the same registry. */
  readonly metrics?: Metrics;
  close?(): Promise<void>;
}
