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
