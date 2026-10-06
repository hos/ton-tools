import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

import type { TxRecord } from "../../src/core/types";
import type { PgDatabase } from "../../src/stores/pg/database";
import { PgStore } from "../../src/stores/pg/pg-store";
import { fakeAddress } from "../fixtures/fake-chain";

/** `PgStore` specifics beyond the shared store contract (tests/stores/store*.test.ts). */

const A = fakeAddress(1);
const B = fakeAddress(2);
const ALL = (1n << 63n) - 1n;

const sha = (...parts: unknown[]) => createHash("sha256").update(parts.join("|")).digest();

function chainOf(address: string, lts: bigint[], utime = 1_700_000_000): TxRecord[] {
  const txs: TxRecord[] = [];
  for (const lt of lts) {
    const prev = txs.at(-1);
    txs.push({
      address,
      lt,
      hash: sha(address, lt),
      prevLt: prev?.lt ?? 0n,
      prevHash: prev?.hash ?? Buffer.alloc(32),
      utime,
      boc: sha("boc", lt),
    });
  }
  return txs;
}

type Target = [string, () => Promise<{ db: PgDatabase; schema: string }>];

const shared = new PGlite();
let seq = 0;
const targets: Target[] = [
  ["PGlite", async () => ({ db: shared as unknown as PgDatabase, schema: `pgs_${seq++}` })],
];

if (process.env.TEST_DATABASE_URL) {
  const { Pool } = await import("pg");
  const { poolDatabase } = await import("../../src/stores/pg/database");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schemas: string[] = [];
  afterAll(async () => {
    for (const s of schemas) await pool.query(`drop schema if exists "${s}" cascade`);
    await pool.end();
  });
  targets.push([
    "postgres",
    async () => {
      const schema = `tw_pgs_${process.pid}_${seq++}`;
      schemas.push(schema);
      return { db: poolDatabase(pool), schema };
    },
  ]);
}

describe("PgStore construction", () => {
  test("rejects schema names that are not plain lowercase identifiers", () => {
    for (const bad of ["", "Idx", "1abc", "a-b", "a b", 'a"b', "a;b", "ton.watch", "é"]) {
      expect(() => new PgStore(shared as any, { schema: bad })).toThrow(
        expect.objectContaining({ code: "INVALID_OPTION" }),
      );
    }
    for (const ok of ["_", "a1_b", "select", "user", "ton_watch"]) {
      expect(new PgStore(shared as any, { schema: ok }).schema).toBe(ok);
    }
    expect(new PgStore(shared as any).schema).toBe("ton_watch");
  });

  test("close calls onClose only when given", async () => {
    let closed = 0;
    await new PgStore(shared as any).close();
    await new PgStore(shared as any, { onClose: async () => void closed++ }).close();
    expect(closed).toBe(1);
  });

  // Postgres truncates identifiers to 63 bytes, so two longer names sharing their
  // first 63 characters would silently use the same tables.
  test("schema names longer than 63 characters are rejected", () => {
    expect(new PgStore(shared as any, { schema: "s".repeat(63) }).schema).toHaveLength(63);
    expect(() => new PgStore(shared as any, { schema: `${"s".repeat(63)}_a` })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" }),
    );
  });
});

for (const [name, target] of targets) {
  describe(`PgStore on ${name}`, () => {
    let store: PgStore;
    let db: PgDatabase;
    let schema: string;
    const count = async (table: string) => {
      const { rows } = await db.query(`select count(*)::int as n from "${schema}".${table}`);
      return (rows[0] as { n: number }).n;
    };

    beforeEach(async () => {
      ({ db, schema } = await target());
      store = new PgStore(db, { schema });
      await store.migrate();
      await store.addAddress(A, { startLt: 0n });
    });

    test("hashes and BOCs come back as Buffers", async () => {
      await store.write(A, chainOf(A, [100n, 200n]));
      await store.advanceFrontier(A);
      const [tx] = await store.read(A, 0n, ALL, 1);
      expect(Buffer.isBuffer(tx!.hash)).toBe(true);
      expect(Buffer.isBuffer(tx!.prevHash)).toBe(true);
      expect(Buffer.isBuffer(tx!.boc)).toBe(true);
      const s = await store.getAddress(A);
      expect(Buffer.isBuffer(s!.head!.hash)).toBe(true);
      expect(Buffer.isBuffer(s!.frontier!.hash)).toBe(true);
      await store.write(
        A,
        chainOf(A, [300n]).map((t) => ({ ...t, prevLt: 250n })),
      );
      const [g] = await store.findGaps(A);
      expect(Buffer.isBuffer(g!.prevHash)).toBe(true);
    });

    test("read labels rows with the requested address", async () => {
      // The record's own `address` field is not stored; the key is the write argument.
      await store.write(
        A,
        chainOf(A, [100n]).map((t) => ({ ...t, address: B })),
      );
      expect((await store.read(A, 0n, ALL, 10))[0]!.address).toBe(A);
    });

    test("operations on an address that was never added are harmless no-ops", async () => {
      const ghost = fakeAddress(77);
      expect(await store.write(ghost, chainOf(ghost, [1n]))).toBe(0);
      expect(await store.findGaps(ghost)).toEqual([]);
      expect(await store.advanceFrontier(ghost)).toBeNull();
      expect(await store.read(ghost, 0n, ALL, 10)).toEqual([]);
      await store.setCursor("c", ghost, 5n);
      expect(await store.getCursor("c", ghost)).toBeNull();
      expect(await count("transactions")).toBe(0);
      expect(await count("cursors")).toBe(0);
    });

    test("purge cascades to transactions and cursors of that address only", async () => {
      await store.addAddress(B, { startLt: 0n });
      await store.write(A, chainOf(A, [100n, 200n]));
      await store.write(B, chainOf(B, [100n]));
      await store.setCursor("c", A, 100n);
      await store.setCursor("c", B, 100n);
      await store.removeAddress(A, { purge: true });
      expect(await count("transactions")).toBe(1);
      expect(await count("cursors")).toBe(1);
      expect(await count("addresses")).toBe(1);
    });

    test("concurrent addAddress of the same address creates one row", async () => {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.addAddress(B, { startLt: BigInt(i) })),
      );
      expect(await count("addresses")).toBe(2);
      const all = await store.listAddresses();
      expect(all.map((s) => s.address)).toEqual([A, B]);
    });

    test("a large batch (5000 rows) is written in one statement", async () => {
      const txs = chainOf(
        A,
        Array.from({ length: 5_000 }, (_, i) => 1_000n + BigInt(i)),
      );
      expect(await store.write(A, txs)).toBe(5_000);
      expect((await store.advanceFrontier(A))?.lt).toBe(5_999n);
      expect(await store.findGaps(A)).toEqual([]);
    });

    test("transaction commits store writes and returns the callback result", async () => {
      const result = await store.transaction(async ({ store: tx, db: client }) => {
        await tx.write(A, chainOf(A, [100n]));
        await tx.setCursor("c", A, 100n);
        expect(client).toBeDefined();
        return 42;
      });
      expect(result).toBe(42);
      expect(await store.getCursor("c", A)).toBe(100n);
      expect((await store.read(A, 0n, ALL, 10)).length).toBe(1);
    });

    test("transaction rolls back every write when the callback throws", async () => {
      const boom = new Error("boom");
      await expect(
        store.transaction(async ({ store: tx, db: client }) => {
          await tx.addAddress(B, { startLt: 0n });
          await tx.write(A, chainOf(A, [100n]));
          await tx.setCursor("c", A, 100n);
          await (client as PgDatabase).query(`update "${schema}".addresses set start_lt = 9`);
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await store.getAddress(B)).toBeNull();
      expect(await store.getCursor("c", A)).toBeNull();
      expect((await store.getAddress(A))?.startLt).toBe(0n);
      expect(await count("transactions")).toBe(0);
    });

    test("transaction-bound store sees its own uncommitted writes", async () => {
      await store.transaction(async ({ store: tx }) => {
        await tx.write(A, chainOf(A, [100n, 200n]));
        expect((await tx.advanceFrontier(A))?.lt).toBe(200n);
        expect((await tx.getAddress(A))?.head?.lt).toBe(200n);
      });
      expect((await store.getAddress(A))?.frontier?.lt).toBe(200n);
    });

    test("nested transactions join the outer one and roll back with it", async () => {
      await expect(
        store.transaction(async ({ store: outer }) => {
          await outer.setCursor("outer", A, 1n);
          await outer.transaction!(async ({ store: inner }) => {
            await inner.setCursor("inner", A, 2n);
          });
          throw new Error("outer fails after the inner one finished");
        }),
      ).rejects.toThrow();
      expect(await store.getCursor("outer", A)).toBeNull();
      expect(await store.getCursor("inner", A)).toBeNull();

      await store.transaction(async ({ store: outer }) => {
        await outer.transaction!(async ({ store: inner }) => inner.setCursor("inner", A, 3n));
      });
      expect(await store.getCursor("inner", A)).toBe(3n);
    });

    test("migrated store reopened on the same database sees the same data", async () => {
      await store.write(A, chainOf(A, [100n]));
      const reopened = new PgStore(db, { schema });
      await reopened.migrate();
      expect((await reopened.getAddress(A))?.head?.lt).toBe(100n);
    });

    test("utime up to 2^31 - 1 round-trips", async () => {
      const utime = 2 ** 31 - 1;
      await store.write(A, chainOf(A, [100n], utime));
      await store.advanceFrontier(A);
      await store.markSynced([A], 100n, utime);
      expect((await store.read(A, 0n, ALL, 1))[0]!.utime).toBe(utime);
      expect((await store.getAddress(A))?.syncedUtime).toBe(utime);
    });

    test("utime past 2038 (2^31) can be stored", async () => {
      const utime = 2 ** 31;
      expect(await store.write(A, chainOf(A, [100n], utime))).toBe(1);
      expect((await store.read(A, 0n, ALL, 1))[0]!.utime).toBe(utime);
    });
  });
}
