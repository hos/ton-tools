import type { Pool, PoolClient } from "pg";

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

/** `pg.Pool`'s default `max`. */
const DEFAULT_POOL_MAX = 10;

/** Dedicated sessions open per pool, across every `PgDatabase` adapting it. */
const openSessions = new WeakMap<Pool, number>();

/**
 * Adapts a `pg.Pool` to `PgDatabase`. A `session()` keeps one pool client for
 * itself, so it is refused when it would leave the pool no client for queries:
 * with `pg`'s default `connectionTimeoutMillis` of 0 those would wait forever.
 */
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
      // Pool look-alikes (pg-compatible drivers, test doubles) may have no `options`.
      const max = pool.options?.max ?? DEFAULT_POOL_MAX;
      const open = openSessions.get(pool) ?? 0;
      if (open + 1 >= max) {
        throw new Error(
          `pg Pool too small: ${open + 1} dedicated connection(s) (one per running consumer) ` +
            `would leave none of its ${max} for queries. Raise the pool's max to at least ` +
            `the number of consumers plus the connections your handlers and the indexer use at once.`,
        );
      }
      openSessions.set(pool, open + 1);
      let returned = false;
      const forget = () => {
        if (returned) return;
        returned = true;
        openSessions.set(pool, (openSessions.get(pool) ?? 1) - 1);
      };
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        forget();
        throw error;
      }
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
          if (returned) return;
          forget();
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
