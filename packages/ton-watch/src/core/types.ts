import { Cell, loadTransaction, type Transaction } from "@ton/core";

/** Identifies one transaction of an account: logical time + cell hash. */
export interface TxId {
  lt: bigint;
  hash: Buffer;
}

/**
 * A transaction as the indexer stores it. Every account transaction links to the
 * previous one through `prevLt`/`prevHash`; that link is what lets writes land in
 * any order and still be checked for completeness. `prevLt === 0n` marks the
 * account's very first transaction.
 */
export interface TxRecord {
  /** Raw address, `<workchain>:<hex>`. */
  address: string;
  lt: bigint;
  hash: Buffer;
  prevLt: bigint;
  prevHash: Buffer;
  /** Unix time of the block the transaction is in. */
  utime: number;
  /** The transaction cell serialized as a BOC. */
  boc: Buffer;
}

/** What the store knows about one tracked address. */
export interface AddressState {
  /** Raw address, `<workchain>:<hex>`. */
  address: string;
  /** Transactions with `lt <= startLt` are out of scope and never fetched or delivered. */
  startLt: bigint;
  active: boolean;
  /** Newest stored transaction. */
  head: TxId | null;
  /**
   * Newest transaction such that every transaction between `startLt` and it is
   * stored. Ordered delivery never goes past this point.
   */
  frontier: TxId | null;
  /**
   * Chain logical time up to which the address is known complete, even when it
   * had no transactions: no transaction with `lt <= syncedLt` is missing.
   * Used for the cross-address watermark.
   */
  syncedLt: bigint;
  /** Chain unix time at which `syncedLt` was observed, for lag reporting. */
  syncedUtime: number | null;
}

/** A missing range below a stored transaction whose previous transaction is not stored. */
export interface Gap {
  address: string;
  /** The stored transaction whose `prev` link is unsatisfied. */
  aboveLt: bigint;
  /** Where to resume fetching (the missing transaction). */
  prevLt: bigint;
  prevHash: Buffer;
  /** Highest stored lt below the gap, or the address `startLt`. Fetching stops here. */
  floorLt: bigint;
}

/** A transaction handed to consumer code. */
export interface IndexedTx extends TxRecord {
  /** Parsed `@ton/core` transaction (parsed lazily, cached). */
  readonly transaction: Transaction;
}

/** Wraps a stored record for delivery; the `transaction` is parsed on first access. */
export function toIndexedTx(record: TxRecord): IndexedTx {
  let parsed: Transaction | undefined;
  return Object.defineProperty({ ...record }, "transaction", {
    enumerable: false,
    get() {
      parsed ??= loadTransaction(Cell.fromBoc(record.boc)[0]!.beginParse());
      return parsed;
    },
  }) as IndexedTx;
}

/** Whether two transaction ids are the same; two missing ids are equal. */
export function txIdEquals(a: TxId | null | undefined, b: TxId | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.lt === b.lt && a.hash.equals(b.hash);
}

/** The lt up to which every transaction of the address is stored (its watermark input). */
export function completeUpTo(state: AddressState): bigint {
  const frontierLt = state.frontier?.lt ?? state.startLt;
  return frontierLt > state.syncedLt ? frontierLt : state.syncedLt;
}
