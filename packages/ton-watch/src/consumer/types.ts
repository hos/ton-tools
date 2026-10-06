import type { IndexedTx } from "../core/types";

export interface HandlerContext {
  /** Name of the consumer delivering the transaction. */
  consumer: string;
  /** Raw address the transaction belongs to. */
  address: string;
  /**
   * With a transactional store (`PgStore`), the database transaction the cursor is
   * committed in. Write your own effects through it and they commit exactly once
   * together with the delivery position.
   */
  db?: unknown;
}

/** Called once per transaction, in order. Throwing halts and retries the same transaction. */
export type TxHandler = (tx: IndexedTx, ctx: HandlerContext) => Promise<void> | void;

export interface ProcessOptions {
  /**
   * Where to begin for an address this consumer has not seen before:
   * `"start"` (default) everything since the address's startLt, `"now"` only what is
   * indexed after this point, or an lt (exclusive). Ignored once a position is stored.
   */
  from?: "start" | "now" | bigint;
  /** Raw or friendly addresses; default every tracked address, including ones added later. */
  addresses?: string[];
  /**
   * `"address"` (default): each address in lt order, addresses independent of each
   * other. `"global"`: one stream in (lt, address) order, released up to the
   * watermark — the lowest complete-up-to point among the addresses.
   */
  order?: "address" | "global";
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
}

export interface ConsumerStatus {
  name: string;
  running: boolean;
  /** Transactions delivered since this process started. */
  delivered: number;
  addresses: {
    address: string;
    /** Lt of the last delivered transaction. */
    cursor: bigint | null;
    /** Waiting to retry a failed handler. */
    halted: boolean;
    failures: number;
    lastError?: string;
  }[];
}

/** Indexer events a consumer wakes up on (an `Indexer`, or any `EventEmitter`). */
export interface ConsumerWakeEvents {
  on(event: "frontier" | "synced", listener: () => void): unknown;
  off(event: "frontier" | "synced", listener: () => void): unknown;
}
