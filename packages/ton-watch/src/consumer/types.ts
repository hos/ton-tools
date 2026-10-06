import type { AddressInput } from "../core/address";
import type { IndexedTx } from "../core/types";
import type { ConsumerOrder, DeadLetter } from "../stores/consumer-state";

export interface HandlerContext<Db = unknown> {
  /** Name of the consumer delivering the transaction. */
  consumer: string;
  /** Raw address the transaction belongs to. */
  address: string;
  /**
   * With a transactional store (`PgStore`), the database transaction the cursor is
   * committed in. Write your own effects through it and they commit exactly once
   * together with the delivery position. Typed after the store: `PgQueryable`
   * with `PgStore`; absent with `MemoryStore`, with `transactional: false`, and
   * in `replayDeadLetter` calls that run outside a transaction.
   */
  db?: Db;
  /** True when a dead letter is being replayed (out of order, see `replayDeadLetter`). */
  replay: boolean;
}

/** Called once per transaction, in order. Throwing fails the delivery (see `ProcessOptions.onError`). */
export type TxHandler<Db = unknown> = (
  tx: IndexedTx,
  ctx: HandlerContext<Db>,
) => Promise<void> | void;

/**
 * What to do with a transaction whose handler keeps failing:
 * - `"retry"`: retry it forever with backoff; nothing is ever skipped.
 * - `"skip"`: after `maxAttempts`, move past it.
 * - `"dead-letter"`: after `maxAttempts`, record it as a dead letter and move past it.
 */
export type FailurePolicy = "retry" | "skip" | "dead-letter";

/** What a consumer does when another instance of the same name holds the lock. */
export type LockMode = "fail" | "wait";

export interface ProcessOptions {
  /**
   * Where to begin for an address this consumer has not seen before:
   * `"earliest"` (default) everything since the address's startLt, `"now"` only what
   * is indexed after this point, or an lt (exclusive). Ignored once a position is stored.
   */
  from?: "earliest" | "now" | bigint;
  /** Addresses to deliver; default every tracked address, including ones added later. */
  addresses?: readonly AddressInput[];
  /**
   * `"address"` (default): each address in lt order, addresses independent of each
   * other. `"global"`: one stream in (lt, address) order, released up to the
   * watermark — the lowest complete-up-to point among the addresses.
   */
  order?: ConsumerOrder;
  /** Transactions read from the store per query. Default 100. */
  batchSize?: number;
  /** Addresses processed in parallel in `"address"` order. Default 8. */
  concurrency?: number;
  /** How often to look for new data when no indexer event arrives. Default 1000ms. */
  pollMs?: number;
  /** First retry delay after a handler failure; doubles per failure. Default 1s. */
  retryMinMs?: number;
  /** Longest retry delay after a handler failure. Default 60s. */
  retryMaxMs?: number;
  /** Commit handler effects and cursor atomically when the store supports it. Default true. */
  transactional?: boolean;
  /** Policy for a transaction whose handler keeps failing. Default `"retry"`. */
  onError?: FailurePolicy;
  /** Failed attempts before `"skip"` or `"dead-letter"` gives up. Default 5. */
  maxAttempts?: number;
  /**
   * Whether a handler error may go away on retry. With `"skip"` or `"dead-letter"`,
   * a transaction failing with a non-retryable error is given up on at once instead
   * of after `maxAttempts`; `"retry"` retries it regardless. Default: every error is
   * retryable.
   */
  isRetryable?: (error: unknown) => boolean;
  /**
   * When another instance runs under the same name: `"fail"` (default) rejects
   * `start()` / `runOnce()` with `ConsumerLockedError`; `"wait"` waits for the lock.
   */
  lock?: LockMode;
  /** How often a started consumer measures its lag (status and metrics); 0 = never. Default 15s. */
  lagIntervalMs?: number;
}

/** How far a consumer is behind on one address. */
export interface AddressLag {
  address: string;
  cursor: bigint;
  /** Deliverable transactions not yet delivered. */
  transactions: number;
  /** Lt of the newest deliverable transaction minus the cursor; 0 when caught up. */
  lt: bigint;
  /** Age of the oldest deliverable transaction not yet delivered; 0 when caught up. */
  seconds: number;
}

/**
 * How far a consumer is behind what it may deliver: each address's frontier, or in
 * global order the watermark. Indexing lag is separate (`AddressStatus.lagSeconds`).
 */
export interface ConsumerLag {
  /** Sum over the addresses. */
  transactions: number;
  /** Maximum over the addresses. */
  lt: bigint;
  /** Maximum over the addresses. */
  seconds: number;
  addresses: AddressLag[];
}

export interface ConsumerStatus {
  name: string;
  running: boolean;
  /** Started in `lock: "wait"` mode (or lost its lock) and waiting for another instance to stop. */
  waitingForLock: boolean;
  /** Transactions delivered since this process started. */
  delivered: number;
  /** Last measured lag; null before the first measurement. */
  lag: ConsumerLag | null;
  addresses: {
    address: string;
    /** Lt of the last delivered transaction. */
    cursor: bigint | null;
    /** Waiting to retry a failed handler. */
    halted: boolean;
    /** Failed attempts on the next transaction (persisted across restarts). */
    failures: number;
    lastError?: string;
  }[];
}

/** One failed handler call. */
export interface HandlerFailure {
  consumer: string;
  address: string;
  lt: bigint;
  hash: Buffer;
  error: unknown;
  /** Failed attempts on this transaction so far, this one included. */
  attempts: number;
  /** What happens next: retried later, or given up on as `"skip"` / `"dead-letter"`. */
  action: FailurePolicy;
}

/** Events emitted by `Consumer`, with their listener arguments. */
export interface ConsumerEventMap {
  /** A handler call failed. */
  handlerError: [failure: HandlerFailure];
  /** A transaction was skipped after `maxAttempts` (`onError: "skip"`). */
  skip: [letter: DeadLetter];
  /** A transaction was dead-lettered after `maxAttempts` (`onError: "dead-letter"`). */
  deadLetter: [letter: DeadLetter];
}

/**
 * Where `rewind` moves a cursor: `"earliest"` (the address's startLt), `"now"` (its
 * frontier), or right after an lt.
 */
export type RewindTarget = "earliest" | "now" | bigint;

export interface RewindOptions {
  /** Addresses to move; default every address the consumer has a cursor on. */
  addresses?: readonly AddressInput[];
}

/**
 * Indexer events a consumer wakes up on (an `Indexer`, or any `EventEmitter`).
 * @experimental
 */
export interface ConsumerWakeEvents {
  on(event: "frontier" | "synced", listener: () => void): unknown;
  off(event: "frontier" | "synced", listener: () => void): unknown;
}
