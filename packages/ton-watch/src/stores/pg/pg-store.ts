import {
  Address,
  beginCell,
  storeTransaction,
  type Transaction,
} from "@ton/core";

import {
  bigIntToHex,
  hashToHex,
  toFriendlyAddress,
  toRawAddress,
} from "../../ton";
import type { Pool } from "pg";
import {
  InsertQuery,
  type Transactions,
  type TransactionsInitializer,
} from "./pg-client";
import type { Store, TxCursor } from "../store";
import { logger } from "../../logger";

interface MigrateOptions {
  drop?: boolean;
  schema?: string;
}

export class PgStore implements Store {
  readonly pgClient: Pool;

  constructor(pgClient: Pool) {
    this.pgClient = pgClient;
  }

  async migrate(args: MigrateOptions) {
    const { drop, schema = "public" } = args;

    if (drop) {
      await this.pgClient.query(`--sql
      drop table if exists ${schema}.transactions;
      drop table if exists ${schema}.addresses;
    `);
    }

    await this.pgClient.query(`--sql
      create table if not exists ${schema}.addresses(
        id bigint generated always as identity primary key,
        address text not null unique,
        start_lt bigint not null default 0,
        created_at timestamp with time zone not null default now(),
        updated_at timestamp with time zone not null default now()
      );

      create table if not exists ${schema}.transactions(
        id bigint generated always as identity primary key,
        is_processed boolean default false,
        from_address text not null,
        to_address text not null references addresses(address) on delete cascade,
        lt bigint not null,
        hash text not null,
        boc bytea,
        transaction_created_at timestamp with time zone not null,
        amount bigint not null,

        prev_lt bigint,
        prev_hash text,

        created_at timestamp with time zone not null default now(),
        updated_at timestamp with time zone not null default now(),

        constraint transactions_to_address_lt_hash_unique unique (to_address, lt, hash)
      );
    `);
  }

  async setAddress(address: string, startLt?: bigint) {
    const rawAddress = Address.parse(address).toRawString();

    const params: any[] = [rawAddress];

    if (startLt !== undefined) {
      params.push(startLt);
    }

    await this.pgClient.query(
      `insert into addresses (address, start_lt) values ($1, ${
        params.length === 2 ? "$2" : "default"
      })
        on conflict (address) do update
          set start_lt = coalesce(excluded.start_lt, addresses.start_lt)`,
      params
    );
  }

  async allAddresses() {
    const { rows } = await this.pgClient.query<{ address: string }>(
      `select address from addresses`
    );

    return rows.map((row) => row.address);
  }

  async exists(address: string, { lt, hash }: TxCursor): Promise<boolean> {
    const lastTxExists = await this.pgClient.query(
      `select 1 from transactions where to_address = $1 and lt = $2 and hash = $3`,
      [address, lt.toString(), hashToHex(hash)]
    );

    if (lastTxExists.rowCount === 1) {
      return true;
    }

    return false;
  }

  async existsList(address: string, txs: TxCursor[]): Promise<boolean[]> {
    const res = await this.pgClient.query(
      `select tx.lt, tx.hash from transactions tx where to_address = $1
        and hash not in (
          select hash from unnest($2::bigint[], $3::text[]) as t(lt, hash)
        )
      `,
      [
        address,
        txs.map(({ lt }) => [lt.toString()]),
        txs.map(({ hash }) => [hash.toString()]),
      ]
    );

    return txs.map((tx) => {
      return res.rows.some(
        (row) => row.lt === tx.lt.toString() && row.hash === tx.hash.toString()
      );
    });
  }

  async getLatestTx(address: Address | string) {
    const {
      rows: [latest],
    } = await this.pgClient.query<Transactions>(
      `--sql
      select * from transactions
      where to_address = $1
      order by lt desc
      limit 1
    `,
      [address.toString()]
    );

    return latest;
  }

  async getOldestNoPrevTx(address: string) {
    const {
      rows: [latest],
    } = await this.pgClient.query<Transactions>(
      `--sql
      select * from transactions
      where to_address = $1
      and not exists (
        select 1 from transactions as t2
        where t2.to_address = $1
        and t2.lt = transactions.prev_lt
      )
      and lt > (select start_lt from addresses where address = $1)
      order by lt asc
      limit 1
    `,
      [address]
    );

    return latest;
  }

  async getOldestTx(address: string) {
    const {
      rows: [firstTx],
    } = await this.pgClient.query<Transactions>(
      `--sql
      select * from transactions
      where to_address = $1
      order by lt asc
      limit 1
    `,
      [address]
    );

    return firstTx;
  }

  async write(address: string, transactions: Transaction[]) {
    const ltHashes = transactions.map((tx) => ({
      lt: tx.lt.toString(),
      hash: tx.hash().toString("hex"),
    }));

    const existing = await this.existsList(address, ltHashes);

    const insertBatch: TransactionsInitializer[] = transactions
      .map((tx, i) => {
        if (existing[i]) {
          return [];
        }

        const serialized = this.serialize(tx);
        if (serialized) {
          return serialized;
        }

        return [];
      })
      .flat();

    if (insertBatch.length === 0) {
      logger.info(
        `[${toFriendlyAddress(address)}]: no new transactions to write`
      );

      return [];
    }

    const { query, params } = InsertQuery({
      tableName: "transactions",
      records: insertBatch,
    });

    await this.pgClient.query(`${query}`, params);

    return insertBatch;
  }

  serialize(tx: Transaction): TransactionsInitializer | null {
    if (
      tx.inMessage?.info.type !== "external-in" &&
      tx.inMessage?.info.type !== "internal"
    ) {
      return null;
    }

    const hash = tx.hash().toString("hex");
    const asBuffer = beginCell().store(storeTransaction(tx)).endCell().toBoc();

    if (tx.inMessage?.info.type === "internal") {
      return {
        amount: tx.inMessage.info.value.coins.toString(),
        from_address: toRawAddress(tx.inMessage.info.src),
        to_address: toRawAddress(tx.inMessage.info.dest),
        lt: tx.lt.toString(),
        hash,
        boc: asBuffer,
        transaction_created_at: new Date(tx.now * 1000),
        prev_lt: tx.prevTransactionLt.toString(),
        prev_hash: bigIntToHex(tx.prevTransactionHash),
      };
    }

    if (tx.inMessage?.info.type === "external-in") {
      return {
        amount: "0",
        from_address: "external",
        to_address: toRawAddress(tx.inMessage.info.dest),
        lt: tx.lt.toString(),
        hash,
        boc: asBuffer,
        transaction_created_at: new Date(tx.now * 1000),
        prev_lt: tx.prevTransactionLt.toString(),
        prev_hash: bigIntToHex(tx.prevTransactionHash),
      };
    }

    return null;
  }

  async close() {
    await this.pgClient.end();
  }
}
