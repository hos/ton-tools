import type { Address, Transaction } from "@ton/core";
import type { TransactionsInitializer } from "./pg/pg-client";

export type TxCursor = {
  lt: bigint | string;
  hash: bigint | string;
};

export type StoreTx = {
  lt: string;
  hash: string;
  prev_lt?: string | null;
  prev_hash?: string | null;
};

export interface Store {
  migrate: (args: { drop?: boolean; schema?: string }) => Promise<void>;

  /**
   * @param address Address to check if it exists in the database.
   * @param cursor Cursor to check if the address has been processed.
   * @returns
   */
  exists: (address: string, cursor: TxCursor) => Promise<boolean>;

  /**
   * @param address Address to store in the database, it must be converted to raw address, in the store implementations.
   * @param startLt Optional, the start "lt" which we are interested in, history older than this "lt" will be ignored.
   * @returns
   */
  setAddress: (address: string, startLt?: bigint) => Promise<void>;

  /**
   * @returns All addresses stored in the database.
   */
  allAddresses: () => Promise<string[]>;

  /**
   * @param address Address to get the oldest transaction for a specific address.
   * @returns The oldest transaction.
   */
  getOldestTx: (address: string) => Promise<StoreTx>;

  /**
   * @param address Address to get the latest (most recent) transaction for a specific address.
   * @returns The latest transaction.
   */
  getLatestTx: (address: string) => Promise<StoreTx>;

  /**
   * Returns the oldest transaction that for which the previous transaction is not stored.
   * It will return nothing if the latest transaction prev_lt is equal to the address.start_lt on adding address.
   * @param address 
   * @returns 
   */
  getOldestNoPrevTx: (address: string) => Promise<StoreTx>;
  write: (
    address: string,
    transactions: Transaction[]
  ) => Promise<TransactionsInitializer[]>;

  /**
   * Store implementation can close the database connection, or do any other cleanup.
   * @returns
   */
  close: () => Promise<void>;
}
