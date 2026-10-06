import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";

import { poolDatabase } from "../../src/stores/pg/database";
import { PgStore } from "../../src/stores/pg/pg-store";
import { fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);

/** A fake `pg.Pool` that records every call; `fail` makes a given statement reject. */
function fakePool(options: { fail?: Record<string, Error>; connectError?: Error } = {}) {
  const calls: string[] = [];
  const client = {
    async query(text: string, params?: unknown[]) {
      calls.push(`client:${text}${params ? ` ${JSON.stringify(params)}` : ""}`);
      const error = options.fail?.[text];
      if (error) throw error;
      return { rows: [{ text }] };
    },
    release() {
      calls.push("release");
    },
  };
  const pool = {
    async query(text: string, params?: unknown[]) {
      calls.push(`pool:${text}${params ? ` ${JSON.stringify(params)}` : ""}`);
      return { rows: [{ text, params }] };
    },
    async connect() {
      calls.push("connect");
      if (options.connectError) throw options.connectError;
      return client;
    },
  };
  return { pool: pool as unknown as Pool, client, calls };
}

describe("poolDatabase", () => {
  test("query goes straight to the pool with its parameters", async () => {
    const { pool, calls } = fakePool();
    const db = poolDatabase(pool);
    const result = await db.query("select $1", [1]);
    expect(result.rows).toEqual([{ text: "select $1", params: [1] }]);
    expect(calls).toEqual(["pool:select $1 [1]"]);
  });

  test("transaction: begin, callback on one client, commit, release", async () => {
    const { pool, client, calls } = fakePool();
    const result = await poolDatabase(pool).transaction(async (tx) => {
      expect(tx).toBe(client as never);
      await tx.query("insert 1");
      return "done";
    });
    expect(result).toBe("done");
    expect(calls).toEqual([
      "connect",
      "client:begin",
      "client:insert 1",
      "client:commit",
      "release",
    ]);
  });

  test("a throwing callback rolls back, releases and rethrows the same error", async () => {
    const { pool, calls } = fakePool();
    const boom = new Error("boom");
    await expect(
      poolDatabase(pool).transaction(async (tx) => {
        await tx.query("insert 1");
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls).toEqual([
      "connect",
      "client:begin",
      "client:insert 1",
      "client:rollback",
      "release",
    ]);
  });

  test("a failing rollback does not mask the original error", async () => {
    const { pool, calls } = fakePool({ fail: { rollback: new Error("connection lost") } });
    const boom = new Error("boom");
    await expect(
      poolDatabase(pool).transaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls.at(-1)).toBe("release");
  });

  test("a failing commit is reported and still rolls back and releases", async () => {
    const commitError = new Error("serialization failure");
    const { pool, calls } = fakePool({ fail: { commit: commitError } });
    await expect(poolDatabase(pool).transaction(async () => 1)).rejects.toBe(commitError);
    expect(calls.slice(-3)).toEqual(["client:commit", "client:rollback", "release"]);
  });

  test("a failing begin never runs the callback but releases the client", async () => {
    const beginError = new Error("too many connections");
    const { pool, calls } = fakePool({ fail: { begin: beginError } });
    let ran = false;
    await expect(
      poolDatabase(pool).transaction(async () => {
        ran = true;
      }),
    ).rejects.toBe(beginError);
    expect(ran).toBe(false);
    expect(calls.at(-1)).toBe("release");
  });

  test("a failing connect rejects without releasing anything", async () => {
    const connectError = new Error("ECONNREFUSED");
    const { pool, calls } = fakePool({ connectError });
    await expect(poolDatabase(pool).transaction(async () => 1)).rejects.toBe(connectError);
    expect(calls).toEqual(["connect"]);
  });

  test("concurrent transactions each get their own begin/commit/release", async () => {
    const { pool, calls } = fakePool();
    const db = poolDatabase(pool);
    await Promise.all([1, 2, 3].map((i) => db.transaction(async (tx) => tx.query(`q${i}`))));
    expect(calls.filter((c) => c === "connect").length).toBe(3);
    expect(calls.filter((c) => c === "client:commit").length).toBe(3);
    expect(calls.filter((c) => c === "release").length).toBe(3);
  });
});

/** A `pg.Pool` look-alike backed by one PGlite, so real SQL runs through `poolDatabase`. */
function pgliteAsPool(pg: PGlite): Pool {
  const query = (text: string, params?: unknown[]) => pg.query(text, params);
  return {
    query,
    connect: async () => ({ query, release() {} }),
  } as unknown as Pool;
}

describe("PgStore over a pg.Pool", () => {
  const pglite = new PGlite();
  let n = 0;
  test("a Pool (no `transaction` method) is wrapped with poolDatabase", async () => {
    const store = new PgStore(pgliteAsPool(pglite), { schema: `pool_${n++}` });
    expect(typeof store.db.transaction).toBe("function");
    await store.migrate();
    await store.addAddress(A, { startLt: 0n });
    expect((await store.getAddress(A))?.active).toBe(true);
  });

  test("store.transaction commits and rolls back through begin/commit/rollback", async () => {
    const store = new PgStore(pgliteAsPool(pglite), { schema: `pool_${n++}` });
    await store.migrate();
    await store.addAddress(A, { startLt: 0n });
    await store.transaction(({ store: tx }) => tx.setCursor("c", A, 1n));
    await expect(
      store.transaction(async ({ store: tx }) => {
        await tx.setCursor("c", A, 2n);
        throw new Error("rollback please");
      }),
    ).rejects.toThrow("rollback please");
    expect(await store.getCursor("c", A)).toBe(1n);
  });

  if (process.env.TEST_DATABASE_URL) {
    test("real pg.Pool: rollback, commit and the client is returned to the pool", async () => {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
      const schema = `tw_db_${process.pid}`;
      try {
        const store = new PgStore(pool, { schema });
        await store.migrate();
        await store.addAddress(A, { startLt: 0n });
        for (let i = 0; i < 5; i++) {
          await expect(
            store.transaction(async ({ store: tx }) => {
              await tx.setCursor("c", A, BigInt(i));
              throw new Error("no");
            }),
          ).rejects.toThrow("no");
        }
        // With max: 1, a leaked client would make this hang.
        await store.transaction(({ store: tx }) => tx.setCursor("c", A, 9n));
        expect(await store.getCursor("c", A)).toBe(9n);
        expect(pool.idleCount).toBe(1);
      } finally {
        await pool.query(`drop schema if exists "${schema}" cascade`);
        await pool.end();
      }
    });
  }
});
