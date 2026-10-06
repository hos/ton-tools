import type { Pool } from "pg";

/** Anything that can run a parameterized query: `pg.Pool`, `pg.PoolClient`, PGlite. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * One dedicated database connection, kept until `release()`. Session state such
 * as advisory locks lives on it.
 */
export interface PgSession extends PgQueryable {
  /** Returns the connection; `destroy` closes it instead of reusing it. */
  release(destroy?: boolean): void;
  /** Registers a callback for when the connection breaks (its session state is gone). */
  onClose(listener: () => void): void;
}

/** A queryable that can also run a callback inside a transaction (PGlite has this natively). */
export interface PgDatabase extends PgQueryable {
  transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
  /**
   * Optional: opens a dedicated connection. Without it the database is treated as
   * a single session, as PGlite is.
   */
  session?(): Promise<PgSession>;
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
    async session() {
      const client = await pool.connect();
      const listeners: (() => void)[] = [];
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        for (const listener of listeners) listener();
      };
      // A checked-out client that errors without a listener crashes the process.
      client.on("error", close);
      client.on("end", close);
      return {
        query: (text, params) => client.query(text, params),
        release(destroy) {
          client.off("error", close);
          client.off("end", close);
          client.release(destroy || closed);
        },
        onClose(listener) {
          listeners.push(listener);
        },
      };
    },
  };
}
