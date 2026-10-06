/**
 * Frozen schema history for the migration tests: a copy of every released
 * migration (`frozen/`), the schema they produce (`schema.snapshot`), and the
 * representative data a database holds at each version (`seeds`).
 *
 * Adding migration N (docs/migrations.md has the full recipe):
 * 1. Append it to `src/stores/pg/migrations.ts`.
 * 2. `UPDATE_MIGRATION_FIXTURES=1 bun test tests/stores/migrations.test.ts` freezes
 *    `frozen/000N-<name>.json` and rewrites `schema.snapshot`; review both diffs.
 * 3. If it adds tables or columns that hold data, add `seeds[N]` below (raw SQL
 *    against the version-N schema) and extend `checkLatest` in the upgrade test.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TxRecord } from "../../../src/core/types";
import type { PgQueryable } from "../../../src/stores/pg/database";
import { type Migration, SCHEMA_PLACEHOLDER } from "../../../src/stores/pg/migrations";
import { FakeChain, fakeAddress } from "../fake-chain";

/** Set to rewrite the schema snapshot and freeze migrations that have no frozen copy yet. */
export const UPDATE_ENV = "UPDATE_MIGRATION_FIXTURES";
export const updating = process.env[UPDATE_ENV] === "1";

const HERE = import.meta.dir;
export const FROZEN_DIR = join(HERE, "frozen");
export const SNAPSHOT_FILE = join(HERE, "schema.snapshot");

/** A released migration exactly as it shipped, plus its pinned checksum. */
export interface FrozenMigration {
  version: number;
  name: string;
  transaction: boolean;
  compatibleFrom: number;
  checksum: string;
  up: string[];
}

export const frozenFileName = (m: Pick<Migration, "version" | "name">) =>
  `${String(m.version).padStart(4, "0")}-${m.name}.json`;

/** Every frozen migration, by version. */
export function loadFrozen(): FrozenMigration[] {
  return readdirSync(FROZEN_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(FROZEN_DIR, file), "utf8")) as FrozenMigration)
    .sort((a, b) => a.version - b.version);
}

export function writeFrozen(frozen: FrozenMigration): void {
  writeFileSync(join(FROZEN_DIR, frozenFileName(frozen)), `${JSON.stringify(frozen, null, 2)}\n`);
}

/** The frozen copy as a runnable migration. */
export const thawed = (f: FrozenMigration): Migration => ({
  version: f.version,
  name: f.name,
  up: f.up,
  transaction: f.transaction,
  compatibleFrom: f.compatibleFrom,
});

/** Runs `sql` against `schema`; rows typed by the caller. */
export type SchemaRun = <Row = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<Row[]>;

export const schemaRun =
  (db: PgQueryable, schema: string): SchemaRun =>
  async <Row>(sql: string, params?: unknown[]) =>
    (await db.query(sql.replaceAll(SCHEMA_PLACEHOLDER, `"${schema}"`), params)).rows as Row[];

/**
 * The chain behind the seeded data:
 * - `A`: active, full history; stored 0..4 and 8..9 (a gap at 5..7, 10..11 not yet
 *   fetched); consumer `orders` is at 2 with three failed attempts on 3.
 * - `B`: active, history starting after tx 1; stored 2..11 and complete; `orders` is at 5
 *   and dead-lettered 4.
 * - `C`: removed (inactive), stored 0..5; a cursor of the unregistered consumer `legacy`.
 * Consumers `orders` (per-address order) and `ledger` (global order, no cursors yet).
 */
export class World {
  static readonly A = fakeAddress(0xa1);
  static readonly B = fakeAddress(0xb2);
  static readonly C = fakeAddress(0xc3);
  readonly chain = new FakeChain();
  readonly failedAt = new Date("2026-01-02T03:04:05Z");

  constructor() {
    this.chain.grow([World.A, World.B, World.C], 12, 3);
  }

  txs(address: string): TxRecord[] {
    return this.chain.txs(address);
  }

  tx(address: string, index: number): TxRecord {
    return this.txs(address)[index]!;
  }

  /** What is stored per address after the v1 seed. */
  stored(address: string): TxRecord[] {
    const txs = this.txs(address);
    if (address === World.A) return [...txs.slice(0, 5), ...txs.slice(8, 10)];
    if (address === World.B) return txs.slice(2);
    return txs.slice(0, 6);
  }
}

/**
 * Data written into a database that has just reached version N, with that
 * version's own SQL (never today's `PgStore`: its statements follow the latest
 * schema). Building a database at version N applies frozen 1, seeds[1], frozen 2,
 * seeds[2], … — data accumulates as it would in a real deployment.
 */
export const seeds: Record<number, (run: SchemaRun, world: World) => Promise<void>> = {
  1: async (run, world) => {
    const { A, B, C } = World;
    const frontier = (address: string, index: number) => world.tx(address, index);
    const address = async (
      raw: string,
      startLt: bigint,
      active: boolean,
      front: TxRecord,
      syncedLt = 0n,
    ) =>
      run(
        `insert into $S.addresses (address, start_lt, active, frontier_lt, frontier_hash, synced_lt,
           synced_utime) values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          raw,
          startLt.toString(),
          active,
          front.lt.toString(),
          front.hash,
          syncedLt.toString(),
          syncedLt === 0n ? null : front.utime,
        ],
      );
    await address(A, 0n, true, frontier(A, 4));
    await address(B, world.tx(B, 1).lt, true, frontier(B, 11), frontier(B, 11).lt);
    await address(C, 0n, false, frontier(C, 5));

    for (const raw of [A, B, C]) {
      for (const tx of world.stored(raw)) {
        await run(
          `insert into $S.transactions (address_id, lt, hash, prev_lt, prev_hash, utime, boc)
           select id, $2, $3, $4, $5, $6, $7 from $S.addresses where address = $1`,
          [raw, tx.lt.toString(), tx.hash, tx.prevLt.toString(), tx.prevHash, tx.utime, tx.boc],
        );
      }
    }

    await run(
      `insert into $S.consumers (name, delivery_order) values ('orders', 'address'), ('ledger', 'global')`,
    );
    const cursor = (consumer: string, raw: string, index: number) =>
      run(
        `insert into $S.cursors (consumer, address_id, lt)
         select $1, id, $3 from $S.addresses where address = $2`,
        [consumer, raw, world.tx(raw, index).lt.toString()],
      );
    await cursor("orders", A, 2);
    await cursor("orders", B, 5);
    await cursor("legacy", C, 1);
    await run(
      `update $S.cursors set attempts = 3, last_error = 'handler failed: boom',
         first_failure_at = $1, last_failure_at = $1
       where consumer = 'orders' and address_id = (select id from $S.addresses where address = $2)`,
      [world.failedAt, A],
    );
    const dead = world.tx(B, 4);
    await run(
      `insert into $S.dead_letters
         (consumer, address_id, lt, hash, error, attempts, first_failure_at, last_failure_at)
       select 'orders', id, $2, $3, 'bad payload', 5, $4, $4 from $S.addresses where address = $1`,
      [B, dead.lt.toString(), dead.hash, world.failedAt],
    );
  },
};

/** Every row of every table, as text, column by column (the same shape on `pg` and PGlite). */
export type TableDump = Map<string, { columns: string[]; rows: string[][] }>;

export async function dumpTables(run: SchemaRun, schema: string): Promise<TableDump> {
  const columns = await run<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
     where table_schema = $1 order by table_name, ordinal_position`,
    [schema],
  );
  const dump: TableDump = new Map();
  for (const { table_name, column_name } of columns) {
    const table = dump.get(table_name) ?? { columns: [], rows: [] };
    table.columns.push(column_name);
    dump.set(table_name, table);
  }
  for (const [table, entry] of dump) {
    const select = entry.columns.map((c) => `"${c}"::text`).join(", ");
    const order = entry.columns.map((_, i) => i + 1).join(", ");
    const rows = await run(`select ${select} from $S."${table}" order by ${order}`);
    entry.rows = rows.map((row) => Object.values(row).map((v) => (v === null ? "∅" : String(v))));
  }
  return dump;
}

/** `after` restricted to the tables and columns `before` has, rows in `before`'s column order. */
export function project(after: TableDump, before: TableDump): TableDump {
  const projected: TableDump = new Map();
  for (const [table, { columns }] of before) {
    const entry = after.get(table);
    if (!entry) continue;
    const indexes = columns.map((c) => entry.columns.indexOf(c));
    projected.set(table, {
      columns: indexes.map((i) => entry.columns[i] ?? "<missing>"),
      rows: entry.rows.map((row) => indexes.map((i) => row[i] ?? "<missing>")).sort(compareRows),
    });
  }
  return projected;
}

function compareRows(a: string[], b: string[]): number {
  for (let i = 0; i < a.length; i++) {
    const order = (a[i] ?? "").localeCompare(b[i] ?? "");
    if (order !== 0) return order;
  }
  return 0;
}

/** `dump` with rows sorted the way `project` sorts them. */
export function normalized(dump: TableDump): TableDump {
  return new Map(
    [...dump].map(([table, entry]) => [
      table,
      { columns: entry.columns, rows: [...entry.rows].sort(compareRows) },
    ]),
  );
}
