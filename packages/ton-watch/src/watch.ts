import { type PoolClient } from "pg";
import { Address, Cell, loadTransaction, type Transaction } from "@ton/core";

import { bigIntToBuffer, toFriendlyAddress } from "./ton";
import type { LiteClient } from "ton-lite-client";
import type { tonNode_blockIdExt } from "ton-lite-client/dist/schema";
import { logger } from "./logger";
import { type Store } from "./stores";

export type BeforeWrite = (
  tx: Transaction,
  dbAccess: PoolClient
) => Promise<void>;

interface WatchOptions<S extends Store> {
  liteClient: LiteClient;
  store: S;
  pageSize?: number;
}

type Cursor = {
  lt: bigint;
  hash: Buffer;
};

export class Watch<S extends Store> {
  readonly store: S;
  readonly liteClient: LiteClient;
  pageSize = 16; // 16 is the maximum we can get with ton-lite-client
  interval = 100;
  private isClosed = false;

  constructor(options: WatchOptions<S>) {
    this.store = options.store;
    this.liteClient = options.liteClient;

    if (options.pageSize) {
      this.pageSize = options.pageSize;
    }
  }

  close = () => {
    this.isClosed = true;
  };

  async getTransactions(
    address: Address,
    lt: string,
    hash: Buffer
  ): Promise<{ ids: tonNode_blockIdExt[]; transactions: Transaction[] }> {
    const { ids, transactions } = await this.liteClient.getAccountTransactions(
      address,
      lt,
      hash,
      this.pageSize
    );

    const cells = Cell.fromBoc(transactions);

    const loadedTransactions = cells.map((cell) => {
      const loadedTx = loadTransaction(cell.beginParse());

      return loadedTx;
    });

    return {
      ids: ids,
      transactions: loadedTransactions,
    };
  }

  async start() {
    const addresses = await this.store.allAddresses();

    for (const addr of addresses) {
      await this.fetchNext(addr).catch((e) => {
        logger.error(`[${addr}]:`, e);
      });
    }

    if (this.isClosed) {
      if (this.store.close) {
        await this.store.close();
      }

      return;
    }

    setTimeout(this.start.bind(this), this.interval);
  }

  async getCursor(address: Address): Promise<Cursor | null> {
    const rawAddr = address.toRawString();
    const oldestNoPrevTx = await this.store.getOldestNoPrevTx(rawAddr);

    // Old transactions that has missing prev tx must be processed first.
    const storeOldestCursor: Cursor | null =
      oldestNoPrevTx && oldestNoPrevTx.prev_lt && oldestNoPrevTx.prev_hash
        ? {
            lt: BigInt(oldestNoPrevTx.prev_lt),
            hash: Buffer.from(oldestNoPrevTx.prev_hash, "hex"),
          }
        : null;

    if (storeOldestCursor) {
      return storeOldestCursor;
    }

    const chain = await this.liteClient.getMasterchainInfo();
    const state = await this.liteClient.getAccountState(
      address,
      chain.last
    );

    if (!state.lastTx) {
      logger.debug(`[${toFriendlyAddress(rawAddr)}] has no transactions`);
      return null;
    }

    const onChainCursor = {
      lt: state.lastTx.lt,
      hash: bigIntToBuffer(state.lastTx.hash),
    };

    const storeLatest = await this.store.getLatestTx(rawAddr);

    // Check if we are up to date.
    if (
      storeLatest &&
      onChainCursor.hash.toString("hex") === storeLatest.hash &&
      onChainCursor.lt === BigInt(storeLatest.lt)
    ) {
      logger.debug(`[${toFriendlyAddress(rawAddr)}] is complete`);
      return null;
    }

    // The on chain cursor is newer than the store cursor.
    return onChainCursor;
  }

  async fetchNext(addr: string) {
    const address = Address.parse(addr);
    const addrRaw = address.toRawString();
    const slug = toFriendlyAddress(addrRaw);

    const cursor = await this.getCursor(address);

    if (!cursor) {
      return;
    }

    const { transactions } = await this.getTransactions(
      address,
      cursor.lt.toString(),
      cursor.hash
    );

    const inserted = await this.store.write(addrRaw, transactions);

    if (inserted.length === 0) {
      logger.debug(`no transactions for ${slug}`);
      return;
    }

    const ltRange = [inserted.at(1)?.lt, "...", inserted.at(-1)?.lt].join("");
    logger.info(
      `[${slug}]: ${inserted.length} tx written ${ltRange} last hash ${
        inserted.at(-1)?.hash
      }`
    );
  }
}
