import { Pool } from "pg";
import { DATABASE_URL } from "./config";

export const pgClient = new Pool({ connectionString: DATABASE_URL });

export const pgPool = pgClient

await pgClient.query(`--sql
  create table if not exists wallet_transactions(
    id serial8 primary key,
    source_wallet text not null,
    target_wallet text not null,
    lt int8 not null,
    hash text not null,
    message text,
    transaction_created_at timestamp with time zone not null,
    amount numeric(100, 0) not null,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    prev_lt int8,

    constraint wallet_transactions_target_unique unique (target_wallet, lt, hash)
  )
`);

await pgClient.query(`--sql
  create table if not exists tx_lt_caches (
    address text not null,
    lt int8 not null,

    hash text,

    prev_transaction_lt int8,
    prev_transaction_hash text,

    in_message_lt int8,
    in_from text,

    out_messages_lt int8[],
    out_messages_to text[],

    primary key (address, lt)
  );
`);
