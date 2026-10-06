/**
 * "Does the next release break anyone's database?" For every released version N:
 * build a database at N from the frozen migrations, fill it with the data a
 * deployment at N holds, migrate it with today's code, then check that no data
 * changed, that the schema is exactly a fresh one's, and that today's store,
 * indexer and consumer work on it. Also: code of version N against today's schema.
 * Fixtures and the recipe for a new migration: tests/fixtures/migrations/history.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";

import { Consumer } from "../../src/consumer/consumer";
import { Indexer } from "../../src/indexer/indexer";
import type { PgDatabase } from "../../src/stores/pg/database";
import { migrations } from "../../src/stores/pg/migrations";
import { MigrationError, migrateSchema } from "../../src/stores/pg/migrator";
import { PgStore } from "../../src/stores/pg/pg-store";
import { FakeSource } from "../fixtures/fake-chain";
import { describeSchema } from "../fixtures/migrations/catalog";
import {
  dumpTables,
  type FrozenMigration,
  loadFrozen,
  normalized,
  project,
  schemaRun,
  seeds,
  thawed,
  World,
} from "../fixtures/migrations/history";
import { cleanUpDbTargets, dbTargets } from "../fixtures/migrations/targets";

afterAll(cleanUpDbTargets);

const frozen = loadFrozen();
const LATEST = migrations.at(-1)!.version;
const { A, B, C } = World;
const ALL = (1n << 63n) - 1n;

/** A database at `version`: frozen migrations and their seeds, interleaved as in real life. */
async function buildAt(db: PgDatabase, schema: string, version: number, world: World) {
  const run = schemaRun(db, schema);
  for (const f of frozen.filter((f) => f.version <= version)) {
    const history = frozen.filter((g) => g.version <= f.version).map(thawed);
    await migrateSchema(db, schema, history);
    await seeds[f.version]?.(run, world);
  }
}

/** Today's store, indexer and consumer on a database built by `buildAt`. */
async function checkLatest(db: PgDatabase, schema: string, world: World) {
  const store = new PgStore(db, { schema });
  const tx = (address: string, index: number) => world.tx(address, index);

  // Store reads see the seeded state.
  expect((await store.listAddresses()).map((a) => a.address)).toEqual([A, B]);
  expect((await store.listAddresses({ includeInactive: true })).map((a) => a.address)).toEqual([
    A,
    B,
    C,
  ]);
  expect((await store.getAddress(A))?.frontier?.lt).toBe(tx(A, 4).lt);
  expect((await store.getAddress(B))?.syncedLt).toBe(tx(B, 11).lt);
  expect(await store.findGaps(A)).toEqual([
    {
      address: A,
      aboveLt: tx(A, 8).lt,
      prevLt: tx(A, 7).lt,
      prevHash: tx(A, 7).hash,
      floorLt: tx(A, 4).lt,
    },
  ]);
  expect(await store.listCursors("orders")).toMatchObject([
    {
      address: A,
      lt: tx(A, 2).lt,
      attempts: 3,
      lastError: "handler failed: boom",
      firstFailureAt: world.failedAt,
    },
    { address: B, lt: tx(B, 5).lt, attempts: 0, lastError: null },
  ]);
  expect((await store.listConsumers()).map((c) => [c.name, c.order, c.cursors.length])).toEqual([
    ["ledger", "global", 0],
    ["legacy", null, 1],
    ["orders", "address", 2],
  ]);
  expect(await store.listDeadLetters()).toMatchObject([
    { consumer: "orders", address: B, lt: tx(B, 4).lt, attempts: 5, error: "bad payload" },
  ]);

  // The indexer fills the gap and catches up with transactions added since.
  world.chain.grow([A, B], 3);
  const indexer = new Indexer({ store, source: new FakeSource(world.chain), detect: "poll" });
  await indexer.syncOnce();
  for (const address of [A, B]) {
    const all = world.txs(address).filter((t) => t.lt > ((address === B && tx(B, 1).lt) || 0n));
    const stored = await store.read(address, 0n, ALL, 1_000);
    expect(stored.map((t) => t.lt)).toEqual(all.map((t) => t.lt));
    expect((await store.getAddress(address))?.frontier?.lt).toBe(all.at(-1)!.lt);
    expect(await store.findGaps(address)).toEqual([]);
  }

  // The consumer resumes at its cursors, in chain order, and clears the failure state.
  const delivered = new Map<string, bigint[]>();
  const consumer = new Consumer("orders", store, (t) => {
    delivered.set(t.address, [...(delivered.get(t.address) ?? []), t.lt]);
  });
  while ((await consumer.runOnce()) > 0) {}
  expect(delivered.get(A)).toEqual(
    world
      .txs(A)
      .slice(3)
      .map((t) => t.lt),
  );
  expect(delivered.get(B)).toEqual(
    world
      .txs(B)
      .slice(6)
      .map((t) => t.lt),
  );
  expect(delivered.has(C)).toBe(false);
  expect((await store.listCursors("orders")).map((c) => c.attempts)).toEqual([0, 0]);
}

describe.each(dbTargets)("upgrading released schemas ($name)", (target) => {
  test("the frozen history is today's history", () => {
    expect(frozen.map((f) => f.version)).toEqual(migrations.map((m) => m.version));
  });

  /** The schema of a fresh database, described once per target. */
  let fresh: Promise<string> | null = null;
  const freshSchema = () => {
    fresh ??= (async () => {
      const schema = target.schema("fresh");
      await migrateSchema(target.db, schema);
      return describeSchema(target.db, schema);
    })();
    return fresh;
  };

  test.each(frozen.map((f): [number, FrozenMigration] => [f.version, f]))(
    "a database at version %d keeps its data and works with today's code",
    async (version) => {
      const db = target.db;
      const schema = target.schema(`up${version}`);
      const world = new World();
      await buildAt(db, schema, version, world);
      const run = schemaRun(db, schema);
      const before = await dumpTables(run, schema);

      const result = await migrateSchema(db, schema);
      expect(result.applied).toEqual(
        migrations.filter((m) => m.version > version).map((m) => m.version),
      );

      // Every row and column that existed is unchanged (history rows only grow).
      const after = project(await dumpTables(run, schema), before);
      const history = after.get("schema_migrations")!;
      history.rows = history.rows.filter((row) => Number(row[0]) <= version);
      expect(after).toEqual(normalized(before));
      expect(await describeSchema(db, schema)).toBe(await freshSchema());

      await checkLatest(db, schema, world);
    },
  );

  test.each(frozen.filter((f) => f.version < LATEST).map((f) => [f.version]))(
    "code of version %d against today's schema starts only if marked compatible",
    async (version) => {
      const schema = target.schema(`old${version}`);
      await buildAt(target.db, schema, LATEST, new World());
      const oldCode = frozen.filter((f) => f.version <= version).map(thawed);
      const compatible = migrations
        .filter((m) => m.version > version)
        .every((m) => (m.compatibleFrom ?? m.version) <= version);
      const attempt = migrateSchema(target.db, schema, oldCode);
      if (compatible) {
        expect((await attempt).newer).toEqual(
          migrations.filter((m) => m.version > version).map((m) => m.version),
        );
      } else {
        const error = await attempt.then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(MigrationError);
        expect((error as MigrationError).code).toBe("MIGRATION_TOO_NEW");
      }
    },
  );
});
