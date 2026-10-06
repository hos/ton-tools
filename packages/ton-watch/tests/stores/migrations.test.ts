import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import type { PgDatabase } from "../../src/stores/pg/database";
import { migrations, SCHEMA_PLACEHOLDER } from "../../src/stores/pg/migrations";
import { PgStore } from "../../src/stores/pg/pg-store";
import { FakeChain, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const ALL = (1n << 63n) - 1n;

/** Snapshot of the real migration list; tests that append to it restore it. */
const original = [...migrations];
afterEach(() => {
  migrations.splice(0, migrations.length, ...original);
});

const versions = async (db: PgDatabase, schema = "ton_watch") =>
  (
    await db.query(`select version, name from "${schema}".schema_migrations order by version`)
  ).rows.map((r) => {
    const row = r as { version: number; name: string };
    return `${row.version}:${row.name}`;
  });

const tables = async (db: PgDatabase, schema: string) =>
  (
    await db.query(
      `select table_name from information_schema.tables where table_schema = $1 order by 1`,
      [schema],
    )
  ).rows.map((r) => (r as { table_name: string }).table_name);

async function seed(store: PgStore, count = 5) {
  const chain = new FakeChain();
  chain.grow([A], count);
  await store.addAddress(A, { startLt: 0n });
  await store.write(A, chain.txs(A));
  await store.advanceFrontier(A);
  await store.setCursor("c", A, chain.txs(A)[1]!.lt);
  return chain;
}

describe("migration definitions", () => {
  test("versions are unique and ascending, names unique", () => {
    const vs = migrations.map((m) => m.version);
    expect(vs).toEqual([...vs].sort((a, b) => a - b));
    expect(new Set(vs).size).toBe(vs.length);
    expect(new Set(migrations.map((m) => m.name)).size).toBe(migrations.length);
    expect(vs[0]).toBe(1);
  });

  test("statements never drop or delete and always go through the schema placeholder", () => {
    for (const m of migrations) {
      expect(m.up.length).toBeGreaterThan(0);
      for (const sql of m.up) {
        const withoutFkActions = sql.replace(/\bon delete (cascade|restrict|set null)\b/gi, "");
        expect(withoutFkActions).not.toMatch(/\b(drop|truncate|delete)\b/i);
        expect(sql).toContain(`${SCHEMA_PLACEHOLDER}.`);
        // Every table reference is schema-qualified.
        const refs = sql.matchAll(/\b(?:table|references|index\s+\w+\s+on)\s+([\w$."]+)/gi);
        for (const [, table] of refs) expect(table!.startsWith(SCHEMA_PLACEHOLDER)).toBe(true);
      }
    }
  });
});

describe("PgStore.migrate (PGlite)", () => {
  // One PGlite for the whole file (starting one is slow); each test uses fresh schemas.
  const db = new PGlite() as unknown as PgDatabase;
  let n = 0;
  const fresh = () => `mig_${n++}`;

  test("creates the default schema, its tables and the version table", async () => {
    await new PgStore(db).migrate();
    expect(await tables(db, "ton_watch")).toEqual([
      "addresses",
      "cursors",
      "schema_migrations",
      "transactions",
    ]);
    expect(await versions(db)).toEqual(["1:initial"]);
  });

  test("running three times, sequentially and concurrently, applies each migration once", async () => {
    const schema = fresh();
    const store = new PgStore(db, { schema });
    await store.migrate();
    const chain = await seed(store);
    await store.migrate();
    await Promise.all(Array.from({ length: 5 }, () => new PgStore(db, { schema }).migrate()));
    expect(await versions(db, schema)).toEqual(["1:initial"]);
    expect((await store.read(A, 0n, ALL, 100)).length).toBe(chain.txs(A).length);
    expect(await store.getCursor("c", A)).toBe(chain.txs(A)[1]!.lt);
  });

  test("concurrent first-time migrations of one fresh schema", async () => {
    const schema = fresh();
    await Promise.all(Array.from({ length: 5 }, () => new PgStore(db, { schema }).migrate()));
    expect(await versions(db, schema)).toEqual(["1:initial"]);
  });

  test("reserved-word and underscore schema names work and stay isolated", async () => {
    const names = ["select", "user", "_", "order_1"];
    const stores = names.map((schema) => new PgStore(db, { schema }));
    for (const s of stores) await s.migrate();
    await seed(stores[0]!);
    for (const [i, s] of stores.entries()) {
      expect(await tables(db, names[i]!)).toContain("transactions");
      expect((await s.listAddresses()).length).toBe(i === 0 ? 1 : 0);
    }
  });

  test("an existing schema with foreign tables is left alone", async () => {
    const schema = fresh();
    await db.query(`create schema ${schema}`);
    await db.query(`create table ${schema}.mine (x int)`);
    await db.query(`insert into ${schema}.mine values (7)`);
    await new PgStore(db, { schema }).migrate();
    expect((await db.query(`select x from ${schema}.mine`)).rows).toEqual([{ x: 7 }]);
    expect(await tables(db, schema)).toContain("transactions");
  });

  test("upgrade: only the new migration runs, existing data survives", async () => {
    const schema = fresh();
    const store = new PgStore(db, { schema });
    await store.migrate();
    const chain = await seed(store);

    migrations.push({
      version: 2,
      name: "add_note",
      up: [
        `alter table $S.addresses add column note text not null default 'v2'`,
        `create index addresses_note on $S.addresses (note)`,
      ],
    });
    await new PgStore(db, { schema }).migrate();
    expect(await versions(db, schema)).toEqual(["1:initial", "2:add_note"]);
    expect((await db.query(`select note from ${schema}.addresses`)).rows).toEqual([{ note: "v2" }]);
    expect((await store.read(A, 0n, ALL, 100)).length).toBe(chain.txs(A).length);
    expect((await store.getAddress(A))?.frontier?.lt).toBe(chain.txs(A).at(-1)!.lt);
    // Running again with v2 present is a no-op (would fail if re-applied).
    await store.migrate();
  });

  test("a failing migration rolls back entirely and can be retried", async () => {
    const schema = fresh();
    const store = new PgStore(db, { schema });
    await store.migrate();
    await seed(store);

    const broken = {
      version: 2,
      name: "broken",
      up: [
        `alter table $S.addresses add column partial text`,
        `alter table $S.no_such_table add column x int`,
      ],
    };
    migrations.push(broken);
    await expect(store.migrate()).rejects.toThrow();
    expect(await versions(db, schema)).toEqual(["1:initial"]);
    const cols = await db.query(
      `select column_name from information_schema.columns
       where table_schema = $1 and table_name = 'addresses' and column_name = 'partial'`,
      [schema],
    );
    expect(cols.rows).toEqual([]);
    // The store keeps working after the failed upgrade.
    expect((await store.listAddresses()).length).toBe(1);

    broken.up[1] = `create index addresses_partial on $S.addresses (partial)`;
    await store.migrate();
    expect(await versions(db, schema)).toEqual(["1:initial", "2:broken"]);
  });

  test("a schema migrated by an older version (v1 only) upgrades over several steps", async () => {
    const schema = fresh();
    await new PgStore(db, { schema }).migrate();
    migrations.push(
      { version: 2, name: "two", up: [`create table $S.extra_two (id int)`] },
      { version: 3, name: "three", up: [`insert into $S.extra_two values (3)`] },
    );
    await new PgStore(db, { schema }).migrate();
    expect(await versions(db, schema)).toEqual(["1:initial", "2:two", "3:three"]);
    expect((await db.query(`select id from ${schema}.extra_two`)).rows).toEqual([{ id: 3 }]);
  });

  test("schemas upgrade independently", async () => {
    const [x, y] = [fresh(), fresh()];
    await new PgStore(db, { schema: x }).migrate();
    migrations.push({ version: 2, name: "two", up: [`create table $S.extra (id int)`] });
    await new PgStore(db, { schema: y }).migrate();
    expect(await versions(db, x)).toEqual(["1:initial"]);
    expect(await versions(db, y)).toEqual(["1:initial", "2:two"]);
  });
});

if (process.env.TEST_DATABASE_URL) {
  const { Pool } = await import("pg");
  const url = process.env.TEST_DATABASE_URL;
  const admin = new Pool({ connectionString: url });
  const schemas: string[] = [];
  let n = 0;
  const fresh = () => {
    const schema = `tw_mig_${process.pid}_${n++}`;
    schemas.push(schema);
    return schema;
  };
  afterAll(async () => {
    for (const s of schemas) await admin.query(`drop schema if exists "${s}" cascade`);
    await admin.end();
  });

  describe("PgStore.migrate (postgres)", () => {
    test("concurrent migrations from separate pools on an existing schema", async () => {
      const schema = fresh();
      await new PgStore(admin, { schema }).migrate();
      const pools = Array.from({ length: 6 }, () => new Pool({ connectionString: url }));
      try {
        await Promise.all(pools.map((p) => new PgStore(p, { schema }).migrate()));
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }
      const { rows } = await admin.query(
        `select count(*)::int as n from "${schema}".schema_migrations`,
      );
      expect(rows[0].n).toBe(migrations.length);
    });

    // BUG: PgStore.migrate (src/stores/pg/pg-store.ts:111-117) runs `create schema if not
    // exists` and `create table if not exists $S.schema_migrations` before taking the
    // advisory lock, outside any transaction. In Postgres these IF NOT EXISTS checks are
    // not race-free: when several processes migrate a fresh database at once (e.g. a
    // service scaled to N replicas on first deploy), the losers fail with
    // `duplicate key value violates unique constraint "pg_namespace_nspname_index"` or
    // `"pg_type_typname_nsp_index"`. Expected: every concurrent migrate() resolves.
    // Reproduced 3/3 runs with 10 pools. Fix: take the advisory lock (session- or
    // xact-level) before both statements.
    test.failing("concurrent first-time migrations from separate pools", async () => {
      const schema = fresh();
      const pools = Array.from({ length: 10 }, () => new Pool({ connectionString: url }));
      try {
        const results = await Promise.allSettled(
          pools.map((p) => new PgStore(p, { schema }).migrate()),
        );
        const errors = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
        expect(errors).toEqual([]);
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }
    });
  });
}
