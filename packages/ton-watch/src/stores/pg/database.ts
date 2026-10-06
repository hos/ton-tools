import type { Pool } from "pg";

/** Anything that can run a parameterized query: `pg.Pool`, `pg.PoolClient`, PGlite. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** A queryable that can also run a callback inside a transaction (PGlite has this natively). */
export interface PgDatabase extends PgQueryable {
  transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
}

/** Adapts a `pg.Pool` to `PgDatabase`. */
export function poolDatabase(pool: Pool): PgDatabase {
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
