import type { AddressState, Gap, TxId, TxRecord } from "../core/types";

/** How a store starts tracking an address. */
export interface AddAddressOptions {
  /** Transactions with `lt <= startLt` are out of scope. 0 = full history. */
  startLt: bigint;
  /** Known-complete chain lt at the time of adding (e.g. when starting "from now"). */
  syncedLt?: bigint;
  /** Chain unix time of `syncedLt`. */
  syncedUtime?: number;
}

/** Handed to the callback of `Store.transaction`. */
export interface StoreTransaction {
  /** The same store, bound to the open database transaction. */
  store: Store;
  /** The store's native transaction handle (for `PgStore`, the `pg`/PGlite client). */
  db: unknown;
}

/**
 * Storage for the indexer. Writes are idempotent and may arrive in any order and
 * concurrently; completeness is derived from the prev links, so a store never needs
 * to know which fetch produced a transaction. `PgStore` is the reference
 * implementation, `MemoryStore` the minimal one.
 *
 * Addresses are always raw (`<workchain>:<hex>`); `TonWatch` normalizes them.
 */
export interface Store {
  /** Creates/upgrades the schema. Idempotent. Never drops data. */
  migrate(): Promise<void>;
  close(): Promise<void>;

  /** Starts tracking an address. Re-activates it if it was removed; never changes its startLt. */
  addAddress(address: string, options: AddAddressOptions): Promise<void>;
  /** Stops tracking. With `purge`, also deletes its transactions and consumer cursors. */
  removeAddress(address: string, options?: { purge?: boolean }): Promise<void>;
  getAddress(address: string): Promise<AddressState | null>;
  listAddresses(options?: { includeInactive?: boolean }): Promise<AddressState[]>;

  /**
   * Inserts transactions of one address, ignoring ones already stored and ones at or
   * below its startLt. Returns how many were new.
   */
  write(address: string, txs: TxRecord[]): Promise<number>;

  /** Missing ranges above the frontier, oldest first. */
  findGaps(address: string, limit?: number): Promise<Gap[]>;

  /** Recomputes and persists the frontier (it only ever moves forward). */
  advanceFrontier(address: string): Promise<TxId | null>;

  /**
   * Records that, as of a chain block with `syncLt`, the address had no transactions
   * beyond what is stored. Applied only to addresses whose frontier equals their
   * head, i.e. nothing is missing.
   */
  markSynced(addresses: string[], syncLt: bigint, utime: number): Promise<void>;

  /** Transactions with `afterLt < lt <= uptoLt`, ascending. */
  read(address: string, afterLt: bigint, uptoLt: bigint, limit: number): Promise<TxRecord[]>;

  getCursor(consumer: string, address: string): Promise<bigint | null>;
  setCursor(consumer: string, address: string, lt: bigint): Promise<void>;

  /**
   * Optional: runs `fn` atomically. Consumers use it to commit the handler's own
   * writes (through `db`) together with the cursor, giving exactly-once effects.
   */
  transaction?<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;
}
