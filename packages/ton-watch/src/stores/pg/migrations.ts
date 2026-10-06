import { createHash } from "node:crypto";

/** Replaced with the quoted schema name in every statement. */
export const SCHEMA_PLACEHOLDER = "$S";

export interface Migration {
  /** Position in the history: 1, 2, 3, … with no gaps. */
  version: number;
  /** snake_case, unique. */
  name: string;
  /** One statement per string, every table reference written as `$S.<table>`. */
  up: readonly string[];
  /**
   * Default true: all statements and the bookkeeping row commit atomically.
   * `false` runs them one by one outside a transaction, as `create index concurrently`
   * requires. A crash can then leave the migration half applied, so every statement
   * must be safe to run again (`if not exists`); an index left INVALID by a crashed
   * concurrent build is dropped and rebuilt on the next run.
   */
  transaction?: boolean;
  /**
   * Oldest schema version whose code keeps working once this migration is applied:
   * code that knows only migrations up to that version may still run against the
   * database (e.g. old instances during a rolling deploy). Default: this migration's
   * own version, i.e. older code refuses to start. Set it only for expand-only
   * changes that older code is known to tolerate (see docs/migrations.md).
   */
  compatibleFrom?: number;
}

/**
 * The schema history, applied in order and recorded in `<schema>.schema_migrations`.
 * Released migrations are frozen (tests/fixtures/migrations pins each one's checksum):
 * append a new one, never edit or remove one. Rules: docs/migrations.md.
 */
export const migrations: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "initial",
    up: [
      // Addresses are canonical raw (`<workchain>:<hex>`, lowercase hex, no leading zeros
      // in the workchain), exactly as `toRawAddress` writes them: one address, one row.
      `create table $S.addresses (
        id bigint generated always as identity primary key,
        address text not null,
        start_lt bigint not null default 0,
        active boolean not null default true,
        frontier_lt bigint,
        frontier_hash bytea,
        synced_lt bigint not null default 0,
        synced_utime bigint,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint addresses_address_key unique (address),
        constraint addresses_address_check check (address ~ '^(0|-?[1-9][0-9]{0,9}):[0-9a-f]{64}$'),
        constraint addresses_start_lt_check check (start_lt >= 0),
        constraint addresses_synced_lt_check check (synced_lt >= 0),
        constraint addresses_frontier_check check ((frontier_lt is null) = (frontier_hash is null)),
        constraint addresses_frontier_hash_check check (octet_length(frontier_hash) = 32)
      )`,
      // The primary key (address_id, lt) serves every hot query: ordered range reads,
      // prev-link lookups for gap detection, and "highest lt below X" for gap floors.
      `create table $S.transactions (
        address_id bigint not null references $S.addresses (id) on delete cascade,
        lt bigint not null,
        hash bytea not null,
        prev_lt bigint not null,
        prev_hash bytea not null,
        utime bigint not null,
        boc bytea not null,
        primary key (address_id, lt),
        constraint transactions_hash_check check (octet_length(hash) = 32),
        constraint transactions_prev_hash_check check (octet_length(prev_hash) = 32)
      )`,
      // A consumer's position per address, plus the failure state of the transaction
      // after it (reset whenever the cursor moves). Not tied to `consumers`: a cursor
      // may exist before (or without) its consumer is registered.
      `create table $S.cursors (
        consumer text not null,
        address_id bigint not null references $S.addresses (id) on delete cascade,
        lt bigint not null,
        attempts integer not null default 0,
        last_error text,
        first_failure_at timestamptz,
        last_failure_at timestamptz,
        updated_at timestamptz not null default now(),
        primary key (consumer, address_id),
        constraint cursors_lt_check check (lt >= 0),
        constraint cursors_attempts_check check (attempts >= 0)
      )`,
      `create index cursors_address_id_idx on $S.cursors (address_id)`,
      `create table $S.consumers (
        name text primary key,
        delivery_order text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint consumers_delivery_order_check check (delivery_order in ('address', 'global'))
      )`,
      // No foreign key to `transactions`: pruning old transactions must not touch these.
      `create table $S.dead_letters (
        consumer text not null,
        address_id bigint not null references $S.addresses (id) on delete cascade,
        lt bigint not null,
        hash bytea not null,
        error text not null,
        attempts integer not null,
        first_failure_at timestamptz not null,
        last_failure_at timestamptz not null,
        created_at timestamptz not null default now(),
        primary key (consumer, address_id, lt),
        constraint dead_letters_hash_check check (octet_length(hash) = 32),
        constraint dead_letters_attempts_check check (attempts >= 0)
      )`,
      `create index dead_letters_address_id_idx on $S.dead_letters (address_id)`,
    ],
  },
]);

/**
 * sha256 of a migration's statements, insensitive to whitespace (re-indenting the
 * source is not an edit). Stored per applied migration and checked on every migrate.
 */
export function migrationChecksum(migration: Pick<Migration, "up">): string {
  const statements = migration.up.map((sql) => sql.replace(/\s+/g, " ").trim());
  return createHash("sha256").update(JSON.stringify(statements)).digest("hex");
}

/** The oldest code version `migration` tolerates (see `Migration.compatibleFrom`). */
export function compatibleFrom(migration: Migration): number {
  return migration.compatibleFrom ?? migration.version;
}
