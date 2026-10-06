import type { Metrics } from "../metrics";
import type { TxId, TxRecord } from "../types";

export interface BlockRef {
  workchain: number;
  shard: string;
  seqno: number;
  rootHash: Buffer;
  fileHash: Buffer;
}

export interface ShardTop extends BlockRef {
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

/**
 * Where transactions come from. `LiteSource` is the liteserver implementation; tests
 * use a fake. Every method may throw a `SourceError` (see errors.ts).
 */
export interface TxSource {
  getTip(): Promise<ChainTip>;

  /** Last transaction of `address` as of `tip`, or null if it has none. */
  getLastTx(address: string, tip: ChainTip): Promise<TxId | null>;

  /**
   * Up to `count` transactions of `address`, newest first, starting at `from`
   * (inclusive) and walking back through prev links.
   */
  getTransactions(address: string, from: TxId, count: number): Promise<TxRecord[]>;

  /**
   * Accounts that had transactions in blocks after `prev` up to `next`, with their
   * newest transaction. Returns null when it cannot tell (shard split/merge, too
   * far behind); the caller then falls back to polling every address.
   */
  getTouchedAccounts?(
    prev: ChainTip,
    next: ChainTip,
    workchains: ReadonlySet<number>,
  ): Promise<Map<string, TxId> | null>;

  /**
   * Optional: some transaction of `address` with lt at or below `lt`, close to it.
   * Lets the indexer cut one long missing range into pieces fetched in parallel
   * (a single range is otherwise a strictly sequential walk, one page per round
   * trip). Returns null when nothing is found cheaply.
   */
  findTxNear?(address: string, lt: bigint, hint?: { ltPerTx?: number }): Promise<TxId | null>;

  readonly maxPageSize: number;
  readonly metrics?: Metrics;
  close?(): Promise<void>;
}
