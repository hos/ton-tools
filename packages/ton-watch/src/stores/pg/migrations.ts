/**
 * Schema migrations, applied in order and recorded in `<schema>.schema_migrations`.
 * Append new ones; never edit an applied migration. `$S` is replaced with the
 * quoted schema name. One statement per string.
 */
export const migrations: { version: number; name: string; up: string[] }[] = [
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
        synced_utime integer,
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
        utime integer not null,
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
];
