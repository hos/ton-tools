/** Delivery order of a consumer (see `ProcessOptions.order`). */
export type ConsumerOrder = "address" | "global";

/** A consumer's position on one address, with the failure state of the transaction after it. */
export interface CursorState {
  consumer: string;
  /** Raw address. */
  address: string;
  /** Lt of the last transaction delivered, skipped or dead-lettered. */
  lt: bigint;
  /** When the cursor last moved: the last delivery, skip, dead letter or rewind. */
  updatedAt: Date;
  /** Failed handler attempts on the transaction after the cursor; 0 when it has not failed. */
  attempts: number;
  lastError: string | null;
  firstFailureAt: Date | null;
  lastFailureAt: Date | null;
}

/** A consumer known to the store. */
export interface ConsumerRecord {
  name: string;
  /** Order it last ran with; null for a consumer whose cursors predate the record. */
  order: ConsumerOrder | null;
  /** When it first ran; null when unknown (see `order`). */
  createdAt: Date | null;
  cursors: CursorState[];
}

/** A transaction a consumer gave up on after `maxAttempts` failed handler calls. */
export interface DeadLetter {
  consumer: string;
  /** Raw address. */
  address: string;
  lt: bigint;
  hash: Buffer;
  /** Message of the last error. */
  error: string;
  attempts: number;
  firstFailureAt: Date;
  lastFailureAt: Date;
}

export interface DeadLetterFilter {
  consumer?: string;
  /** Raw address. */
  address?: string;
  lt?: bigint;
  /** Default: no limit. */
  limit?: number;
}

/** Stored, not yet delivered transactions of one address for one consumer. */
export interface Backlog {
  address: string;
  cursor: bigint;
  /** Stored transactions above the cursor, up to the frontier (and `uptoLt`). */
  transactions: number;
  /** Lt of the newest of them; null when there are none. */
  newestLt: bigint | null;
  /** Chain time of the oldest of them; null when there are none. */
  oldestUtime: number | null;
}

/** A consumer's single-instance lock, held until released (or its connection is lost). */
export interface ConsumerLock {
  /** False once released or once the connection holding it broke. */
  readonly held: boolean;
  release(): Promise<void>;
}

/**
 * The per-consumer half of a `Store`: delivery positions, failure counts, dead
 * letters and the single-instance lock. Addresses are raw.
 */
export interface ConsumerStateStore {
  getCursor(consumer: string, address: string): Promise<bigint | null>;
  /** Moves the cursor (either direction) and clears its failure state. */
  setCursor(consumer: string, address: string, lt: bigint): Promise<void>;
  /**
   * Moves the cursor to `lt` and clears its failure state, but only if it still is
   * at `expected` (`null`: only if there is no cursor yet). Resolves to false,
   * changing nothing, if another writer moved it. Inside `Store.transaction` a
   * concurrent move commits first or waits for this one, never both.
   */
  compareAndSetCursor(
    consumer: string,
    address: string,
    expected: bigint | null,
    lt: bigint,
  ): Promise<boolean>;
  /** Cursors of active and inactive addresses, of one consumer or all of them. */
  listCursors(consumer?: string): Promise<CursorState[]>;
  /**
   * Counts a failed attempt on the transaction after the cursor. Resolves to the
   * updated cursor, or null if the consumer has no cursor on the address.
   */
  recordFailure(consumer: string, address: string, error: string): Promise<CursorState | null>;

  /** Records that a consumer runs (with this order). Idempotent. */
  saveConsumer(name: string, order: ConsumerOrder): Promise<void>;
  /** Every consumer with a record or a cursor, by name. */
  listConsumers(): Promise<ConsumerRecord[]>;
  /** Deletes a consumer's record, cursors and dead letters. */
  deleteConsumer(name: string): Promise<void>;

  /** Inserts a dead letter, or replaces the one for the same (consumer, address, lt). */
  putDeadLetter(letter: DeadLetter): Promise<void>;
  /**
   * Replaces the dead letter for the same (consumer, address, lt) only if it still
   * exists; resolves to false, inserting nothing, if it does not.
   */
  updateDeadLetter(letter: DeadLetter): Promise<boolean>;
  /** Oldest first (by consumer, address, lt). */
  listDeadLetters(filter?: DeadLetterFilter): Promise<DeadLetter[]>;
  /** Resolves to false if there was no such dead letter. */
  deleteDeadLetter(consumer: string, address: string, lt: bigint): Promise<boolean>;

  /**
   * Per active address the consumer has a cursor on: what is stored above the cursor
   * up to the address's frontier, and up to `uptoLt` if given.
   */
  backlog(consumer: string, uptoLt?: bigint): Promise<Backlog[]>;

  /**
   * Optional: takes the lock that keeps a consumer name running in one place at a
   * time. Resolves to null if another instance holds it. Without this method
   * nothing stops two instances from delivering the same transactions.
   */
  lockConsumer?(name: string): Promise<ConsumerLock | null>;
}
