import type { Address, Transaction } from "@ton/core";
import type { BlockID, LiteClient, QueryArgs } from "ton-lite-client";
import type { liteServer_masterchainInfo } from "ton-lite-client/dist/schema";

export interface LsConfig {
  ip: number;
  port: number;
  id: {
    key: string;
  };
}

export interface TestedLsConfig {
  lsConfig: LsConfig;
  success: number;
  error: number;
  avgTiming: number;
}

export interface AppLiteClient extends LiteClient {
  getFullTransaction: (
    src: Address,
    lt: string,
    block: BlockID,
    queryArgs?: QueryArgs
  ) => Promise<Transaction>;

  getCachedMaterchainInfo: () => Promise<liteServer_masterchainInfo>;

  getCachedBlock: (seqno: number) => Promise<{
    shards: {
      rootHash: Buffer;
      fileHash: Buffer;
      transactions: { hash: Buffer; lt: string; account: Buffer }[];
      workchain: number;
      seqno: number;
      shard: string;
    }[];
  }>;
}

export interface WalletTransactions {
  id: string;

  source_wallet: string;

  target_wallet: string;

  lt: string;

  hash: string | null;

  message: string | null;

  transaction_created_at: Date;

  amount: string;

  created_at: Date;

  updated_at: Date;

  prev_lt: string | null;
}

export interface WalletTransactionsInitializer {
  /** Default value: nextval('wallet_transactions_id_seq'::regclass) */
  id?: string;

  source_wallet: string;

  target_wallet: string;

  lt: string;

  hash: string;

  message?: string | null;

  transaction_created_at: Date;

  amount: string;

  /** Default value: now() */
  created_at?: Date;

  /** Default value: now() */
  updated_at?: Date;

  prev_lt?: string | null;
}

export default interface TxLtCaches {
  address: string;

  lt: string;

  hash: string;

  prev_transaction_lt: string | null;

  prev_transaction_hash: string | null;

  in_message_lt: string | null;

  in_from: string | null;

  out_messages_lt: string[] | null;

  out_messages_to: string[] | null;
}

export interface TxLtCachesInitializer {
  address: Address;

  lt: string;

  hash?: string | null;

  prev_transaction_lt?: string | null;

  prev_transaction_hash?: string | null;

  in_message_lt?: string | null;

  in_from?: string | null;

  out_messages_lt?: string[] | null;

  out_messages_to?: string[] | null;
}
