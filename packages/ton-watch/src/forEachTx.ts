import { type Transaction } from "@ton/core";
import { type PoolClient } from "pg";
import { bigIntToBuffer, bigIntToHex, hashBase64ToBigInt } from "./ton";
import { safeInsert } from "./safe-insert";
import { Store, type BeforeWrite } from "./store";
import { logger } from "./logger";
import { getLiteClient } from "./lite-client";
import type { WalletTransactions } from "./types";
import { pgClient } from "./database";

interface ForEachTxOptions {
  beforeWrite?: BeforeWrite;
}

export async function forEachTx(address: string, options?: ForEachTxOptions) {
  const { beforeWrite } = options || {};
  const liteClient = await getLiteClient();

  const store = await Store.createFromAddress(liteClient, address);
  if (!store.state.lastTx) {
    logger.info(`No last tx for ${address}`);
    return;
  }

  await store.writeBackward(beforeWrite);

  await store.writeForward(beforeWrite);
}
