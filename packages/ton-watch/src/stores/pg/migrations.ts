/** Replaced with the quoted schema name in every statement. */
export const SCHEMA_PLACEHOLDER = "$S";

export interface Migration {
  version: number;
  name: string;
  /** One statement per string. */
  up: string[];
}

/**
 * Schema migrations, applied in order and recorded in `<schema>.schema_migrations`.
 * Append new ones; never edit an applied migration.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial",
    up: [
      `create table $S.addresses (
        id bigint generated always as identity primary key,
        address text not null unique,
        start_lt bigint not null default 0,
        active boolean not null default true,
        frontier_lt bigint,
        frontier_hash bytea,
        synced_lt bigint not null default 0,
        synced_utime bigint,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      // The primary key (address_id, lt) serves every hot query: ordered range reads,
      // prev-link lookups for gap detection, and "highest lt below X" for gap floors.
      `create table $S.transactions (
        address_id bigint not null references $S.addresses(id) on delete cascade,
        lt bigint not null,
        hash bytea not null,
        prev_lt bigint not null,
        prev_hash bytea not null,
        utime bigint not null,
        boc bytea not null,
        primary key (address_id, lt)
      )`,
      `create table $S.cursors (
        consumer text not null,
        address_id bigint not null references $S.addresses(id) on delete cascade,
        lt bigint not null,
        updated_at timestamptz not null default now(),
        primary key (consumer, address_id)
      )`,
      `create index cursors_address_id on $S.cursors (address_id)`,
    ],
  },
  {
    version: 2,
    name: "consumer_state",
    up: [
      // Failure state of the transaction after the cursor; reset whenever it moves.
      `alter table $S.cursors add column attempts integer not null default 0`,
      `alter table $S.cursors add column last_error text`,
      `alter table $S.cursors add column first_failure_at timestamptz`,
      `alter table $S.cursors add column last_failure_at timestamptz`,
      `create table $S.consumers (
        name text primary key,
        delivery_order text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create table $S.dead_letters (
        consumer text not null,
        address_id bigint not null references $S.addresses(id) on delete cascade,
        lt bigint not null,
        hash bytea not null,
        error text not null,
        attempts integer not null,
        first_failure_at timestamptz not null,
        last_failure_at timestamptz not null,
        created_at timestamptz not null default now(),
        primary key (consumer, address_id, lt)
      )`,
      `create index dead_letters_address_id on $S.dead_letters (address_id)`,
    ],
  },
];
