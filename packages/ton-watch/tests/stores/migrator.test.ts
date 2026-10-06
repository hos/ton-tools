/**
 * The migration runner (`migrateSchema`), driven with synthetic histories: locking,
 * checksums, schemas migrated by a newer version, and non-transactional migrations.
 */
import { afterAll, describe, expect, test } from "bun:test";

import type { PgDatabase, PgQueryable } from "../../src/stores/pg/database";
import { type Migration, migrationChecksum, migrations } from "../../src/stores/pg/migrations";
import { MigrationError, migrateSchema } from "../../src/stores/pg/migrator";
import { PgStore } from "../../src/stores/pg/pg-store";
import { FakeChain, fakeAddress } from "../fixtures/fake-chain";
import { cleanUpDbTargets, dbTargets } from "../fixtures/migrations/targets";

afterAll(cleanUpDbTargets);

const A = fakeAddress(1);
const ALL = (1n << 63n) - 1n;
const LATEST = migrations.length;
const NEXT = LATEST + 1;

const next = (offset: number, up: string[], extra: Partial<Migration> = {}): Migration => ({
  version: NEXT + offset,
  name: `test_${NEXT + offset}`,
  up,
  ...extra,
});

const history = async (db: PgQueryable, schema: string) =>
  (
    await db.query(
      `select version, name, checksum, compatible_from from "${schema}".schema_migrations
       order by version`,
    )
  ).rows as { version: number; name: string; checksum: string; compatible_from: number }[];

const versions = async (db: PgQueryable, schema: string) =>
  (await history(db, schema)).map((row) => Number(row.version));

const tables = async (db: PgQueryable, schema: string) =>
  (
    await db.query(
      `select table_name from information_schema.tables where table_schema = $1 order by 1`,
      [schema],
    )
  ).rows.map((r) => (r as { table_name: string }).table_name);

const column = async (db: PgQueryable, schema: string, table: string, name: string) =>
  (
    await db.query(
      `select 1 from information_schema.columns
       where table_schema = $1 and table_name = $2 and column_name = $3`,
      [schema, table, name],
    )
  ).rows.length > 0;

const indexValid = async (db: PgQueryable, schema: string, name: string) => {
  const { rows } = await db.query(
    `select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2`,
    [schema, name],
  );
  return (rows[0] as { valid: boolean } | undefined)?.valid ?? null;
};

async function seed(store: PgStore) {
  const chain = new FakeChain();
  chain.grow([A], 5);
  await store.addAddress(A, { startLt: 0n });
  await store.write(A, chain.txs(A));
  await store.advanceFrontier(A);
  await store.setCursor("c", A, chain.txs(A)[1]!.lt);
  return chain;
}

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
};

describe.each(dbTargets)("migrateSchema ($name)", (target) => {
  const db = (): PgDatabase => target.db;

  test("creates the schema, its tables and a history row per migration", async () => {
    const schema = target.schema("mig");
    const result = await migrateSchema(db(), schema);
    expect(result).toEqual({ applied: migrations.map((m) => m.version), newer: [] });
    expect(await tables(db(), schema)).toEqual([
      "addresses",
      "consumers",
      "cursors",
      "dead_letters",
      "schema_migrations",
      "transactions",
    ]);
    expect(await history(db(), schema)).toEqual(
      migrations.map((m) => ({
        version: m.version,
        name: m.name,
        checksum: migrationChecksum(m),
        compatible_from: m.compatibleFrom ?? m.version,
      })),
    );
  });

  test("re-running, sequentially and concurrently, applies nothing twice", async () => {
    const schema = target.schema("mig");
    const store = new PgStore(db(), { schema });
    await store.migrate();
    const chain = await seed(store);
    expect(await migrateSchema(db(), schema)).toEqual({ applied: [], newer: [] });
    const handles = Array.from({ length: 5 }, () => target.connect());
    await Promise.all(handles.map((h) => migrateSchema(h, schema)));
    expect(await versions(db(), schema)).toEqual(migrations.map((m) => m.version));
    expect((await store.read(A, 0n, ALL, 100)).length).toBe(chain.txs(A).length);
    expect(await store.getCursor("c", A)).toBe(chain.txs(A)[1]!.lt);
  });

  test("concurrent first-time migrations of one fresh schema", async () => {
    const schema = target.schema("mig");
    const handles = Array.from({ length: 6 }, () => target.connect());
    const results = await Promise.all(handles.map((h) => migrateSchema(h, schema)));
    expect(results.flatMap((r) => r.applied).sort()).toEqual(migrations.map((m) => m.version));
    expect(await versions(db(), schema)).toEqual(migrations.map((m) => m.version));
  });

  test("an existing schema with foreign tables is left alone", async () => {
    const schema = target.schema("mig");
    await db().query(`create schema "${schema}"`);
    await db().query(`create table "${schema}".mine (x int)`);
    await db().query(`insert into "${schema}".mine values (7)`);
    await migrateSchema(db(), schema);
    expect((await db().query(`select x from "${schema}".mine`)).rows).toEqual([{ x: 7 }]);
    expect(await tables(db(), schema)).toContain("transactions");
  });

  test("upgrade: only new migrations run, in order, and existing data survives", async () => {
    const schema = target.schema("mig");
    const store = new PgStore(db(), { schema });
    await store.migrate();
    const chain = await seed(store);
    const list = [
      ...migrations,
      next(0, [`alter table $S.addresses add column note text not null default 'v2'`]),
      next(1, [`create table $S.extra (id int)`, `insert into $S.extra values (3)`]),
    ];
    expect(await migrateSchema(db(), schema, list)).toEqual({
      applied: [NEXT, NEXT + 1],
      newer: [],
    });
    expect((await db().query(`select note from "${schema}".addresses`)).rows).toEqual([
      { note: "v2" },
    ]);
    expect((await db().query(`select id from "${schema}".extra`)).rows).toEqual([{ id: 3 }]);
    expect((await store.read(A, 0n, ALL, 100)).length).toBe(chain.txs(A).length);
    expect((await store.getAddress(A))?.frontier?.lt).toBe(chain.txs(A).at(-1)!.lt);
    expect(await migrateSchema(db(), schema, list)).toEqual({ applied: [], newer: [] });
  });

  test("a failing migration rolls back entirely and can be retried", async () => {
    const schema = target.schema("mig");
    const store = new PgStore(db(), { schema });
    await store.migrate();
    await seed(store);
    const broken = next(0, [
      `alter table $S.addresses add column partial text`,
      `alter table $S.no_such_table add column x int`,
    ]);
    await expect(migrateSchema(db(), schema, [...migrations, broken])).rejects.toThrow();
    expect(await versions(db(), schema)).toEqual(migrations.map((m) => m.version));
    expect(await column(db(), schema, "addresses", "partial")).toBe(false);
    expect((await store.listAddresses()).length).toBe(1);

    const fixed = {
      ...broken,
      up: [broken.up[0]!, `create index p_idx on $S.addresses (partial)`],
    };
    await migrateSchema(db(), schema, [...migrations, fixed]);
    expect(await versions(db(), schema)).toEqual([...migrations.map((m) => m.version), NEXT]);
  });

  describe("checksums", () => {
    test("an applied migration whose statements changed is refused, nothing else runs", async () => {
      const schema = target.schema("sum");
      const original = next(0, [`create table $S.extra (id int)`]);
      await migrateSchema(db(), schema, [...migrations, original]);
      const edited = { ...original, up: [`create table $S.extra (id bigint)`] };
      const error = await rejection(
        migrateSchema(db(), schema, [
          ...migrations,
          edited,
          next(1, [`create table $S.more (id int)`]),
        ]),
      );
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe("modified");
      expect((error as Error).message).toMatch(
        new RegExp(`migration ${NEXT} \\(test_${NEXT}\\) differs.*never be edited`),
      );
      expect(await tables(db(), schema)).not.toContain("more");
    });

    test("whitespace and indentation are not edits", async () => {
      const schema = target.schema("sum");
      const original = next(0, [`create table $S.extra (\n  id int\n)`]);
      await migrateSchema(db(), schema, [...migrations, original]);
      const reindented = { ...original, up: [`  create table $S.extra ( id int )  `] };
      await migrateSchema(db(), schema, [...migrations, reindented]);
    });
  });

  describe("a schema the code does not fully know", () => {
    test("newer compatible migrations are tolerated: the old code starts and works", async () => {
      const schema = target.schema("new");
      const store = new PgStore(db(), { schema });
      const newer = [
        next(0, [`create table $S.extra (id int)`], { compatibleFrom: LATEST }),
        next(1, [`alter table $S.addresses add column note text`], { compatibleFrom: 1 }),
      ];
      await migrateSchema(db(), schema, [...migrations, ...newer]);
      // The old code: the real history only.
      expect(await migrateSchema(db(), schema)).toEqual({ applied: [], newer: [NEXT, NEXT + 1] });
      await store.migrate();
      const chain = await seed(store);
      expect((await store.read(A, 0n, ALL, 100)).length).toBe(chain.txs(A).length);
    });

    test("a newer migration not marked compatible makes the old code refuse to start", async () => {
      const schema = target.schema("new");
      await migrateSchema(db(), schema, [
        ...migrations,
        next(0, [`create table $S.extra (id int)`], { compatibleFrom: LATEST }),
        next(1, [`alter table $S.addresses add column note text`]),
      ]);
      const error = await rejection(new PgStore(db(), { schema }).migrate());
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe("too_new");
      expect((error as Error).message).toMatch(
        new RegExp(`version ${NEXT + 1} by a newer ton-watch.*up to ${LATEST}.*Upgrade ton-watch`),
      );
      // Code that knows every migration runs.
      await migrateSchema(db(), schema, [
        ...migrations,
        next(0, [`create table $S.extra (id int)`], { compatibleFrom: LATEST }),
        next(1, [`alter table $S.addresses add column note text`]),
      ]);
    });

    test("an unknown version below the newest known one is a diverged history", async () => {
      const schema = target.schema("div");
      await migrateSchema(db(), schema, [...migrations, next(0, [`create table $S.a (id int)`])]);
      const other = next(1, [`create table $S.b (id int)`]);
      // Code that numbered a different migration NEXT + 1 and never had NEXT.
      const error = await rejection(
        migrateSchema(db(), schema, [...migrations, { ...other, version: NEXT + 1 }]),
      );
      expect((error as MigrationError).code).toBe("diverged");
    });

    test("a migration numbered below an applied one is refused (it would run out of order)", async () => {
      const schema = target.schema("div");
      const late = next(1, [`create table $S.b (id int)`]);
      await migrateSchema(db(), schema, [...migrations, late]);
      const error = await rejection(
        migrateSchema(db(), schema, [...migrations, next(0, [`create table $S.a (id int)`]), late]),
      );
      expect((error as MigrationError).code).toBe("diverged");
      expect((error as Error).message).toMatch(`migration ${NEXT} (test_${NEXT}) is not applied`);
    });

    test("a pre-release schema (history without checksums) is refused with a clear message", async () => {
      const schema = target.schema("pre");
      await db().query(`create schema "${schema}"`);
      await db().query(`create table "${schema}".schema_migrations (
        version integer primary key, name text not null, applied_at timestamptz not null default now()
      )`);
      await db().query(
        `insert into "${schema}".schema_migrations (version, name) values (1, 'initial')`,
      );
      const error = await rejection(migrateSchema(db(), schema));
      expect((error as MigrationError).code).toBe("diverged");
      expect((error as Error).message).toMatch(/pre-release ton-watch.*drop it/);
    });
  });

  describe("non-transactional migrations", () => {
    const concurrentIndex = (unique = false) =>
      next(
        0,
        [
          `alter table $S.addresses add column if not exists tag text`,
          `create ${unique ? "unique " : ""}index concurrently if not exists addresses_tag_idx on $S.addresses (tag)`,
        ],
        { transaction: false, compatibleFrom: LATEST },
      );

    test("build an index concurrently on a table with data, then later migrations run", async () => {
      const schema = target.schema("ntx");
      const store = new PgStore(db(), { schema });
      await store.migrate();
      await seed(store);
      const list = [...migrations, concurrentIndex(), next(1, [`create table $S.after (id int)`])];
      expect((await migrateSchema(db(), schema, list)).applied).toEqual([NEXT, NEXT + 1]);
      expect(await indexValid(db(), schema, "addresses_tag_idx")).toBe(true);
      expect(await tables(db(), schema)).toContain("after");
      expect((await migrateSchema(db(), schema, list)).applied).toEqual([]);
    });

    test("resume after a crash halfway: statements already done are skipped", async () => {
      const schema = target.schema("ntx");
      await migrateSchema(db(), schema);
      // The first statement ran, then the process died before the rest and the record.
      await db().query(`alter table "${schema}".addresses add column tag text`);
      await migrateSchema(db(), schema, [...migrations, concurrentIndex()]);
      expect(await indexValid(db(), schema, "addresses_tag_idx")).toBe(true);
      expect(await versions(db(), schema)).toEqual([...migrations.map((m) => m.version), NEXT]);
    });

    test("an INVALID index left by a failed build is dropped and rebuilt", async () => {
      const schema = target.schema("ntx");
      const store = new PgStore(db(), { schema });
      await store.migrate();
      await store.addAddress(fakeAddress(1), { startLt: 0n });
      await store.addAddress(fakeAddress(2), { startLt: 0n });
      await db().query(`alter table "${schema}".addresses add column tag text`);
      await db().query(`update "${schema}".addresses set tag = 'same'`);
      const list = [...migrations, concurrentIndex(true)];
      await expect(migrateSchema(db(), schema, list)).rejects.toThrow(/duplicate|unique/i);
      expect(await indexValid(db(), schema, "addresses_tag_idx")).toBe(false);
      expect(await versions(db(), schema)).toEqual(migrations.map((m) => m.version));

      await db().query(`update "${schema}".addresses set tag = address`);
      await migrateSchema(db(), schema, list);
      expect(await indexValid(db(), schema, "addresses_tag_idx")).toBe(true);
      expect(await versions(db(), schema)).toEqual([...migrations.map((m) => m.version), NEXT]);
    });

    test("a failing transactional migration after it still rolls back alone", async () => {
      const schema = target.schema("ntx");
      await migrateSchema(db(), schema);
      const list = [
        ...migrations,
        concurrentIndex(),
        next(1, [`create table $S.half (id int)`, `select * from $S.no_such_table`]),
      ];
      await expect(migrateSchema(db(), schema, list)).rejects.toThrow();
      expect(await versions(db(), schema)).toEqual([...migrations.map((m) => m.version), NEXT]);
      expect(await tables(db(), schema)).not.toContain("half");
      // The store still works after the failure: the lock and the connection were released.
      const store = new PgStore(db(), { schema });
      await seed(store);
      expect((await store.listAddresses()).length).toBe(1);
    });

    test("concurrent runners with a concurrent index build each apply it once", async () => {
      const schema = target.schema("ntx");
      const store = new PgStore(db(), { schema });
      await store.migrate();
      await seed(store);
      const list = [...migrations, concurrentIndex(), next(1, [`create table $S.after (id int)`])];
      const handles = Array.from({ length: 5 }, () => target.connect());
      const results = await Promise.all(handles.map((h) => migrateSchema(h, schema, list)));
      expect(results.flatMap((r) => r.applied).sort()).toEqual([NEXT, NEXT + 1]);
      expect(await indexValid(db(), schema, "addresses_tag_idx")).toBe(true);
    });
  });

  test.skipIf(target.name !== "Postgres")("no migration lock is left behind", async () => {
    const schema = target.schema("lock");
    await migrateSchema(db(), schema, [...migrations, next(0, [`create table $S.x (id int)`])]);
    const { rows } = await db().query(
      `select count(*)::int as n from pg_locks
       where locktype = 'advisory' and objsubid = 1
         and objid = (hashtext($1)::bigint & 4294967295)::oid`,
      [`ton_watch:${schema}`],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });
});

describe("migrateSchema (PGlite only)", () => {
  const target = dbTargets[0]!;

  test("reserved-word and underscore schema names work and stay isolated", async () => {
    const names = ["select", "user", "_", "order_1"];
    const stores = names.map((schema) => new PgStore(target.db, { schema }));
    for (const s of stores) await s.migrate();
    await seed(stores[0]!);
    for (const [i, s] of stores.entries()) {
      expect(await tables(target.db, names[i]!)).toContain("transactions");
      expect((await s.listAddresses()).length).toBe(i === 0 ? 1 : 0);
    }
  });

  test("schemas upgrade independently", async () => {
    const [x, y] = [target.schema("ind"), target.schema("ind")];
    await migrateSchema(target.db, x);
    await migrateSchema(target.db, y, [...migrations, next(0, [`create table $S.extra (id int)`])]);
    expect(await versions(target.db, x)).toEqual(migrations.map((m) => m.version));
    expect(await versions(target.db, y)).toEqual([...migrations.map((m) => m.version), NEXT]);
  });
});
