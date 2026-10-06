import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { MemoryStore } from "../../src/stores/memory/memory-store";
import { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";
import { FakeChain, fakeAddress, rng } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const B = fakeAddress(2);

function shuffle<T>(items: T[], seed: number): T[] {
  const r = rng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const factories: [string, () => Promise<Store>][] = [
  ["MemoryStore", async () => new MemoryStore()],
  [
    "PgStore (PGlite)",
    async () => {
      const store = new PgStore(new PGlite() as any);
      await store.migrate();
      return store;
    },
  ],
];

// Also run the contract against a real server: TEST_DATABASE_URL=postgres://… bun test
if (process.env.TEST_DATABASE_URL) {
  const { Pool } = await import("pg");
  let n = 0;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schemas: string[] = [];
  afterAll(async () => {
    for (const s of schemas) await admin.query(`drop schema if exists ${s} cascade`);
    await admin.end();
  });
  factories.push([
    "PgStore (postgres)",
    async () => {
      const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      const schema = `tw_test_${process.pid}_${n++}`;
      schemas.push(schema);
      await pool.query(`drop schema if exists ${schema} cascade`);
      const store = new PgStore(pool, { schema, onClose: () => pool.end() });
      await store.migrate();
      return store;
    },
  ]);
}

for (const [name, make] of factories) {
  describe(name, () => {
    let store: Store;
    let chain: FakeChain;

    beforeEach(async () => {
      store = await make();
      chain = new FakeChain();
      chain.grow([A, B], 40, 3);
      await store.addAddress(A, { startLt: 0n });
      await store.addAddress(B, { startLt: 0n });
    });

    test("writes are idempotent: duplicates are ignored, not errors", async () => {
      const txs = chain.txs(A);
      expect(await store.write(A, txs.slice(0, 20))).toBe(20);
      expect(await store.write(A, txs.slice(10, 30))).toBe(10);
      expect(await store.write(A, txs.slice(0, 30))).toBe(0);
      expect((await store.read(A, 0n, 1n << 62n, 1000)).length).toBe(30);
    });

    test("out-of-order writes: frontier stops at the first gap, then closes", async () => {
      const txs = chain.txs(A);
      await store.write(A, txs.slice(25, 40));
      await store.write(A, txs.slice(0, 10));
      expect((await store.advanceFrontier(A))?.lt).toBe(txs[9]!.lt);

      const gaps = await store.findGaps(A);
      expect(gaps.length).toBe(1);
      expect(gaps[0]!.aboveLt).toBe(txs[25]!.lt);
      expect(gaps[0]!.prevLt).toBe(txs[24]!.lt);
      expect(gaps[0]!.prevHash.equals(txs[24]!.hash)).toBe(true);
      expect(gaps[0]!.floorLt).toBe(txs[9]!.lt);

      await store.write(A, txs.slice(10, 25));
      expect((await store.advanceFrontier(A))?.lt).toBe(txs[39]!.lt);
      expect(await store.findGaps(A)).toEqual([]);
    });

    test("random-order single-tx writes converge to the full chain", async () => {
      const txs = chain.txs(A);
      for (const tx of shuffle(txs, 7)) {
        await store.write(A, [tx]);
        await store.advanceFrontier(A);
      }
      const state = await store.getAddress(A);
      expect(state?.frontier?.lt).toBe(txs.at(-1)!.lt);
      expect(state?.head?.lt).toBe(txs.at(-1)!.lt);
      const read = await store.read(A, 0n, 1n << 62n, 1000);
      expect(read.map((t) => t.lt)).toEqual(txs.map((t) => t.lt));
      expect(read.every((t, i) => t.boc.equals(txs[i]!.boc))).toBe(true);
    });

    test("multiple gaps are reported oldest first with correct floors", async () => {
      const txs = chain.txs(A);
      await store.write(A, [...txs.slice(5, 10), ...txs.slice(20, 25), ...txs.slice(35, 40)]);
      expect(await store.advanceFrontier(A)).toBeNull();
      const gaps = await store.findGaps(A);
      expect(gaps.map((g) => g.aboveLt)).toEqual([txs[5]!.lt, txs[20]!.lt, txs[35]!.lt]);
      expect(gaps.map((g) => g.floorLt)).toEqual([0n, txs[9]!.lt, txs[24]!.lt]);
    });

    test("startLt: older transactions are dropped and the first one in scope is anchored", async () => {
      const txs = chain.txs(B);
      const C = fakeAddress(3);
      chain.grow([C], 1);
      await store.addAddress(C, { startLt: 0n });
      const startLt = txs[14]!.lt;
      const D = fakeAddress(4);
      // Reuse B's chain under a fresh address with a startLt in the middle.
      await store.addAddress(D, { startLt });
      const moved = txs.map((t) => ({ ...t, address: D }));
      expect(await store.write(D, moved)).toBe(25);
      expect((await store.advanceFrontier(D))?.lt).toBe(txs[39]!.lt);
      expect((await store.read(D, 0n, 1n << 62n, 100))[0]!.lt).toBe(txs[15]!.lt);
    });

    test("concurrent overlapping writers on the same address", async () => {
      const txs = chain.txs(A);
      const batches = Array.from({ length: 12 }, (_, i) => shuffle(txs, i).slice(0, 20));
      const counts = await Promise.all(batches.map((b) => store.write(A, b)));
      const stored = (await store.read(A, 0n, 1n << 62n, 1000)).length;
      expect(counts.reduce((a, b) => a + b, 0)).toBe(stored);
      await store.write(A, txs);
      await Promise.all([store.advanceFrontier(A), store.advanceFrontier(A)]);
      expect((await store.getAddress(A))?.frontier?.lt).toBe(txs.at(-1)!.lt);
    });

    test("markSynced only applies when nothing is missing", async () => {
      const txs = chain.txs(A);
      await store.write(A, [...txs.slice(0, 10), ...txs.slice(12, 20)]);
      await store.advanceFrontier(A);
      await store.markSynced([A, B], 999_999_999n, 123);
      expect((await store.getAddress(A))?.syncedLt).toBe(0n);
      // B has nothing stored: frontier == head == null → complete.
      expect((await store.getAddress(B))?.syncedLt).toBe(999_999_999n);

      await store.write(A, txs.slice(10, 12));
      await store.advanceFrontier(A);
      await store.markSynced([A], 999_999_999n, 124);
      const a = await store.getAddress(A);
      expect(a?.syncedLt).toBe(999_999_999n);
      expect(a?.syncedUtime).toBe(124);
      // Never moves backwards.
      await store.markSynced([A], 5n, 1);
      expect((await store.getAddress(A))?.syncedLt).toBe(999_999_999n);
    });

    test("read is ordered and bounded", async () => {
      const txs = chain.txs(A);
      await store.write(A, shuffle(txs, 3));
      const r = await store.read(A, txs[4]!.lt, txs[9]!.lt, 100);
      expect(r.map((t) => t.lt)).toEqual(txs.slice(5, 10).map((t) => t.lt));
      expect((await store.read(A, 0n, 1n << 62n, 3)).length).toBe(3);
    });

    test("cursors persist per consumer and address", async () => {
      expect(await store.getCursor("c1", A)).toBeNull();
      await store.setCursor("c1", A, 10n);
      await store.setCursor("c1", A, 20n);
      await store.setCursor("c2", A, 5n);
      expect(await store.getCursor("c1", A)).toBe(20n);
      expect(await store.getCursor("c2", A)).toBe(5n);
      expect(await store.getCursor("c1", B)).toBeNull();
    });

    test("remove deactivates; purge deletes; re-adding keeps startLt", async () => {
      await store.write(A, chain.txs(A));
      await store.removeAddress(A);
      expect((await store.listAddresses()).map((s) => s.address)).toEqual([B]);
      expect((await store.listAddresses({ includeInactive: true })).length).toBe(2);
      await store.addAddress(A, { startLt: 777n });
      const a = await store.getAddress(A);
      expect(a?.active).toBe(true);
      expect(a?.startLt).toBe(0n);
      expect((await store.read(A, 0n, 1n << 62n, 1000)).length).toBe(40);

      await store.setCursor("c", B, 1n);
      await store.removeAddress(B, { purge: true });
      expect(await store.getAddress(B)).toBeNull();
      await store.addAddress(B, { startLt: 0n });
      expect(await store.getCursor("c", B)).toBeNull();
    });
  });
}

describe("PgStore migrations", () => {
  test("migrate is idempotent and never drops data", async () => {
    const db = new PGlite();
    const s1 = new PgStore(db as any);
    await s1.migrate();
    await s1.addAddress(A, { startLt: 0n });
    const chain = new FakeChain();
    chain.grow([A], 5);
    await s1.write(A, chain.txs(A));

    const s2 = new PgStore(db as any);
    await s2.migrate();
    await s2.migrate();
    expect((await s2.read(A, 0n, 1n << 62n, 100)).length).toBe(5);
    const { rows } = await db.query<{ version: number }>(
      `select version from ton_watch.schema_migrations`,
    );
    expect(rows.map((r) => r.version)).toEqual([1]);
  });

  test("custom schema isolates tables", async () => {
    const db = new PGlite();
    const s1 = new PgStore(db as any, { schema: "idx_a" });
    const s2 = new PgStore(db as any, { schema: "idx_b" });
    await s1.migrate();
    await s2.migrate();
    await s1.addAddress(A, { startLt: 0n });
    expect((await s2.listAddresses()).length).toBe(0);
    expect(() => new PgStore(db as any, { schema: "bad;name" })).toThrow();
  });
});
