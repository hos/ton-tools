import { Pool, type PoolClient } from "pg";
import { Address, Cell, loadTransaction, type Transaction } from "@ton/core";
import type {
  WalletTransactions,
  WalletTransactionsInitializer,
} from "./types";
import { safeInsert } from "./safe-insert";
import { pgClient as globalPgClient } from "./database";
import type TxLtCaches from "./types";
import {
  bigIntToBuffer,
  bigIntToHex,
  hashBase64ToBigInt,
  toDisplayAddress,
} from "./ton";
import type { ClientAccountState, LiteClient } from "ton-lite-client";
import type {
  liteServer_masterchainInfo,
  tonNode_blockIdExt,
} from "ton-lite-client/dist/schema";
import { logger } from "./logger";

const MAX_PAGE_SIZE = 30;

export type BeforeWrite = (
  tx: Transaction,
  dbAccess: PoolClient
) => Promise<void>;

interface StoreOptions {
  address: Address;
  state: ClientAccountState;
  lastBlock: liteServer_masterchainInfo;
  liteClient: LiteClient;
  pgClient: Pool;
  // This will be used to run query inside transaction
  pgTxClient: PoolClient;
  txCountPerIteration?: number;
  iterationPerWrite?: number;
}

export class Store {
  readonly pgClient: Pool;
  readonly pgTxClient: PoolClient;
  readonly ltToHash: Map<bigint, bigint> = new Map();
  readonly address: Address;
  readonly state: ClientAccountState;
  readonly lastBlock: liteServer_masterchainInfo;
  readonly liteClient: LiteClient;
  txCountPerIteration = 16;
  iterationPerWrite = 5;

  private constructor(options: StoreOptions) {
    this.pgClient = options.pgClient;
    this.pgTxClient = options.pgTxClient;
    this.state = options.state;
    this.lastBlock = options.lastBlock;
    this.address = options.address;
    this.liteClient = options.liteClient;

    if (options.txCountPerIteration) {
      this.txCountPerIteration = options.txCountPerIteration;
    }

    if (options.iterationPerWrite) {
      this.iterationPerWrite = options.iterationPerWrite;
    }
  }

  static async createFromAddress(
    liteClient: LiteClient,
    addressOrString: Address | string
  ) {
    const address =
      typeof addressOrString === "string"
        ? Address.parse(addressOrString)
        : addressOrString;

    const pgClient = await globalPgClient.connect();

    await pgClient.query("BEGIN");

    const lastBlock = await liteClient.getMasterchainInfo();
    const state = await liteClient.getAccountState(address, lastBlock.last);

    const store = new Store({
      address: typeof address === "string" ? Address.parse(address) : address,
      state,
      lastBlock,
      liteClient,
      pgClient: globalPgClient,
      pgTxClient: pgClient,
    });

    if (state.lastTx) {
      store.ltToHash.set(state.lastTx.lt, state.lastTx.hash);
    }

    return store;
  }

  close = async () => {
    await this.pgClient.query("COMMIT");
    await this.pgTxClient.release();
  };

  async exists(lt: string, hash: string | bigint): Promise<boolean> {
    const lastTxExists = await this.pgClient.query(
      `select 1 from wallet_transactions where target_wallet = $1 and lt = $2 and hash = $3`,
      [
        this.address.toString(),
        lt,
        typeof hash === "bigint" ? bigIntToHex(hash) : hash,
      ]
    );

    if (lastTxExists.rowCount === 1) {
      return true;
    }

    return false;
  }

  async lastTxExistInStore() {
    // If there is no lastTx on blockchain, then this address don't have any transaction.
    if (!this.state.lastTx) {
      return true;
    }

    const lastTxStored = await this.getLatestStoreTx();
    if (!lastTxStored) {
      return false;
    }

    const lastTxExists = await this.exists(
      this.state.lastTx.lt.toString(),
      this.state.lastTx.hash
    );

    return lastTxExists;
  }

  toStructuredTransaction(
    tx: Transaction
  ): WalletTransactionsInitializer | null {
    if (tx.inMessage?.info.type === "internal") {
      return {
        amount: tx.inMessage.info.value.coins.toString(),
        source_wallet: toDisplayAddress(tx.inMessage.info.src),
        target_wallet: toDisplayAddress(tx.inMessage.info.dest),
        lt: tx.lt.toString(),
        hash: bigIntToHex(this.ltToHash.get(tx.lt)),
        message: null,
        transaction_created_at: new Date(tx.now * 1000),
        prev_lt: tx.prevTransactionLt.toString(),
      };
    }

    if (tx.inMessage?.info.type === "external-in") {
      return {
        amount: "0",
        source_wallet: "external",
        target_wallet: toDisplayAddress(tx.inMessage.info.dest),
        lt: tx.lt.toString(),
        hash: bigIntToHex(this.ltToHash.get(tx.lt)),
        message: null,
        transaction_created_at: new Date(tx.now * 1000),
        prev_lt: tx.prevTransactionLt.toString(),
      };
    }

    return null;
  }

  static toDisplayAddress(input: string | Address): string | null {
    if (!input) {
      return null;
    }
    const address = typeof input === "string" ? Address.parse(input) : input;
    return address.toString({ urlSafe: true, bounceable: true });
  }

  toDisplayAddress() {
    return Store.toDisplayAddress(this.address);
  }

  async getOldestStoreTx() {
    const {
      rows: [firstTx],
    } = await this.pgClient.query<WalletTransactions>(
      `--sql
      SELECT * FROM wallet_transactions
      WHERE target_wallet = $1
      ORDER BY lt ASC
      LIMIT 1
    `,
      [this.address.toString()]
    );

    return firstTx;
  }

  async getLatestStoreTx() {
    const {
      rows: [latest],
    } = await this.pgClient.query<WalletTransactions>(
      `--sql
      SELECT * FROM wallet_transactions
      WHERE target_wallet = $1
      ORDER BY lt DESC
      LIMIT 1
    `,
      [this.address.toString()]
    );

    return latest;
  }

  async getCachedTxCount({ afterLt }: { afterLt?: bigint | string }) {
    const {
      rows: [{ count }],
    } = await this.pgClient.query<{ count: number }>(
      `--sql
        SELECT count(*)::int4 count FROM tx_lt_caches
        WHERE address = $1 AND 
          CASE WHEN $2::bigint IS NULL then true ELSE lt >= $2 END
      `,
      [
        this.address.toString(),
        afterLt ? (BigInt(afterLt) + 1n).toString() : null,
      ]
    );

    return count;
  }

  async getNextCachedTransactions({
    afterLt,
    offset,
    limit = 1,
  }: {
    afterLt?: bigint | string;
    offset?: number;
    limit?: number;
  }) {
    const { rows: cached } = await this.pgClient.query<TxLtCaches>(
      `--sql
        SELECT * FROM tx_lt_caches
        WHERE address = $1 AND
          CASE WHEN $2::bigint IS NULL then true ELSE lt >= $2 END
        ORDER BY lt ASC
        OFFSET COALESCE($3, 0)
        LIMIT $4
      `,
      [
        this.address.toString(),
        afterLt ? (BigInt(afterLt) + 1n).toString() : null,
        offset,
        limit,
      ]
    );

    for (const cachedTx of cached) {
      const lastLt = BigInt(cachedTx.lt);
      const lastHash = hashBase64ToBigInt(cachedTx.hash);
      this.ltToHash.set(lastLt, lastHash);
    }

    return cached;
  }

  async getTransactions(
    lt: string,
    hash: Buffer
  ): Promise<{ ids: tonNode_blockIdExt[]; transactions: Transaction[] }> {
    const transactionsRaw = await this.liteClient.getAccountTransactions(
      this.address,
      lt,
      hash,
      this.txCountPerIteration
    );

    const txList = Cell.fromBoc(transactionsRaw.transactions);

    const loadedTransactions = txList.map((tx) => {
      const loadedTx = loadTransaction(tx.beginParse());

      this.ltToHash.set(
        loadedTx.prevTransactionLt,
        loadedTx.prevTransactionHash
      );

      return loadedTx;
    });

    return {
      ids: transactionsRaw.ids,
      transactions: loadedTransactions,
    };
  }

  async write(transactions: Transaction[], beforeWrite?: BeforeWrite) {
    const insertBatch: Transaction[] = [];

    for (const tx of transactions) {
      if (!this.ltToHash.has(tx.lt)) {
        throw new Error(
          `Failed to get hash for transaction with lt '${tx.lt}'.`
        );
      }

      if (
        await this.exists(
          tx.lt.toString(),
          bigIntToHex(this.ltToHash.get(tx.lt))
        )
      ) {
        continue;
      }

      if (beforeWrite) {
        await beforeWrite(tx, this.pgTxClient);
      }

      insertBatch.push(tx);
    }

    for (const tx of insertBatch) {
      const structuredTx = this.toStructuredTransaction(tx);
      if (structuredTx) {
        debugger;
        await safeInsert<WalletTransactions>(
          `wallet_transactions`,
          structuredTx,
          { pgClient: this.pgClient }
        );
      }
    }
  }

  async writeBackward(callback?: BeforeWrite) {
    const firstTx = await this.getOldestStoreTx();
    if (!firstTx || firstTx.prev_lt === "0") {
      return;
    }

    let i = 0;
    let allTransactions: Transaction[] = [];
    let lastLt = BigInt(firstTx.lt);
    let lastHash = BigInt(`0x${firstTx.hash}`);

    this.ltToHash.set(lastLt, lastHash);

    while (i < this.iterationPerWrite) {
      logger.warn(i, this.iterationPerWrite);
      const transactions = await this.getTransactions(
        lastLt.toString(),
        bigIntToBuffer(lastHash)
      );

      const lastTransaction = transactions.transactions.at(-1);
      if (lastTransaction) {
        lastLt = lastTransaction.prevTransactionLt;
        const hashFromLt = this.ltToHash.get(lastTransaction.prevTransactionLt);
        if (hashFromLt) {
          lastHash = hashFromLt;
        }
      }

      allTransactions = allTransactions.concat(transactions.transactions);

      // First transaction
      if (lastLt === 0n) {
        logger.warn(
          `Break >>> Found last transaction: ${this.address.toString()}`
        );
        break;
      }

      i++;
    }
    logger.info(`allTransactions: ${allTransactions.length}`);
    await this.write(allTransactions, callback);
  }

  async writeForward(beforeWrite?: BeforeWrite) {
    const lastTxStored = await this.lastTxExistInStore();
    if (lastTxStored) {
      logger.info(`Last tx already stored for ${this.address.toString()}`);
      return;
    }

    const transactions: Transaction[] = [];

    if (!this.state.lastTx) {
      logger.info(`No last tx for ${this.address.toString()}`);
      return;
    }

    let lastLt = this.state.lastTx.lt;
    let lastHash = this.state.lastTx.hash;

    const latestStoreTx = await this.getLatestStoreTx();

    if (latestStoreTx) {
      let [nextCachedTx] = await this.getNextCachedTransactions({
        afterLt: latestStoreTx.lt,
      });

      const storePrevExistsInCache =
        nextCachedTx && nextCachedTx.prev_transaction_lt === latestStoreTx.lt;
      if (storePrevExistsInCache) {
        const count = await this.getCachedTxCount({
          afterLt: latestStoreTx.lt,
        });
        if (count) {
          const offset = Math.min(300, count - 1);
          const [txAfterWithOffset] = await this.getNextCachedTransactions({
            afterLt: latestStoreTx.lt,
            offset,
          });

          if (txAfterWithOffset) {
            nextCachedTx = txAfterWithOffset;
          }
        }
      }

      const cacheIsOlder =
        nextCachedTx && nextCachedTx.lt && BigInt(nextCachedTx.lt) < lastLt;
      if (cacheIsOlder) {
        lastLt = BigInt(nextCachedTx.lt);
        lastHash = hashBase64ToBigInt(nextCachedTx.hash);
      }
    }

    let i = 0;
    let skip = 0;

    while (i++ < MAX_PAGE_SIZE) {
      const txSet = await this.getTransactions(
        lastLt.toString(),
        bigIntToBuffer(lastHash)
      );

      if (txSet.transactions.length <= skip) {
        break;
      }

      transactions.push(...txSet.transactions.slice(skip));

      // If we didn't have transactions before - just save 1 iteration of loop to start
      if (!latestStoreTx) {
        break;
      }

      // If we found tx that already exists - break
      const lastTx = transactions[transactions.length - 1];
      if (
        await this.exists(lastTx.lt.toString(), lastTx.hash().toString("hex"))
      ) {
        break;
      }

      lastLt = lastTx.lt;
      lastHash = hashBase64ToBigInt(lastTx.hash().toString("base64"));
      skip = 1;
    }

    // If we broke loop because of max pages, save cache and exit
    if (i >= MAX_PAGE_SIZE) {
      for (const tx of transactions) {
        await this.writeCache(tx);
      }
      logger.info(`Max pages reached for ${this.address}`);
      return;
    }

    await this.write(transactions, beforeWrite);

    await this.close();

    logger.info(
      `Stored ${transactions.length} transactions for ${this.address}`
    );
  }

  async writeCache(tx: Transaction) {
    const txHash = this.ltToHash.get(tx.lt);
    if (!txHash) {
      throw new Error(`Failed to get hash for transaction with lt '${tx.lt}'.`);
    }

    const inLt =
      tx.inMessage?.info.type === "internal" ||
      tx.inMessage?.info.type === "external-out"
        ? tx.inMessage.info.createdLt.toString()
        : null;
    const inFrom =
      tx.inMessage?.info.type === "internal" ||
      tx.inMessage?.info.type === "external-out"
        ? Store.toDisplayAddress(tx.inMessage.info.src)
        : null;

    const outMessagesLt = tx.outMessages
      .values()
      .map((m) =>
        m.info.type === "internal" || m.info.type === "external-out"
          ? m.info.createdLt.toString()
          : null
      )
      .filter((v) => v);
    const outMessagesTo = tx.outMessages
      .values()
      .map((m) =>
        m.info.type === "internal" || m.info.type === "external-out"
          ? Store.toDisplayAddress(m.info.src)
          : null
      )
      .filter((v) => v);

    const outMsgLt = outMessagesLt.reduce(
      (acc, v) => `${acc}${acc?.length ? "," : ""}${v}`,
      ""
    );

    const outMsgTo = outMessagesTo.reduce(
      (acc, v) => `${acc}${acc?.length ? "," : ""}${v}`,
      ""
    );

    await globalPgClient.query<TxLtCaches>(
      `--sql
      INSERT INTO
        tx_lt_caches(address,lt,hash,prev_transaction_lt,prev_transaction_hash,in_message_lt,in_from,out_messages_lt,out_messages_to)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::int8[],$9::text[])
      ON CONFLICT DO NOTHING
      RETURNING *`,
      [
        this.address.toString(),
        tx.lt.toString(),
        bigIntToBuffer(txHash).toString("base64"),
        tx.prevTransactionLt.toString(),
        bigIntToBuffer(tx.prevTransactionHash).toString("base64"),
        inLt,
        inFrom,
        `{${outMsgLt}}`,
        `{${outMsgTo}}`,
      ]
    );
  }
}
