import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";

import { MemoryStore } from "../../src/stores/memory/memory-store";
import type { PgDatabase } from "../../src/stores/pg/database";
import { PgStore } from "../../src/stores/pg/pg-store";
import type { Store } from "../../src/stores/store";

/** A kind of store the consumer-state contract runs against. */
export interface StoreTarget {
  name: string;
  /** A fresh, migrated store. */
  make(): Promise<Store>;
  /** Two handles on one fresh database, as two instances of a service would have. */
  makePair(): Promise<[Store, Store]>;
  /** Real Postgres: separate connections, so session locks are truly separate. */
  realPostgres: boolean;
}

let seq = 0;
const freshSchema = (prefix: string) => `${prefix}_${process.pid}_${seq++}`;

const memory: StoreTarget = {
  name: "MemoryStore",
  realPostgres: false,
  make: async () => new MemoryStore(),
  makePair: async () => {
    const store = new MemoryStore();
    return [store, store];
  },
};

/** One PGlite for all PGlite targets (starting one is slow); each store gets its own schema. */
let pglite: PgDatabase | null = null;
const sharedPglite = () => {
  pglite ??= new PGlite() as unknown as PgDatabase;
  return pglite;
};

const pgliteTarget: StoreTarget = {
  name: "PgStore (PGlite)",
  realPostgres: false,
  async make() {
    const store = new PgStore(sharedPglite(), { schema: freshSchema("cs") });
    await store.migrate();
    return store;
  },
  async makePair() {
    const schema = freshSchema("cs");
    const first = new PgStore(sharedPglite(), { schema });
    await first.migrate();
    return [first, new PgStore(sharedPglite(), { schema })];
  },
};

const pools: Pool[] = [];
const schemas: string[] = [];

function postgresTarget(url: string): StoreTarget {
  const open = (schema: string) => {
    const pool = new Pool({ connectionString: url });
    pools.push(pool);
    return new PgStore(pool, { schema });
  };
  return {
    name: "PgStore (postgres)",
    realPostgres: true,
    async make() {
      const schema = freshSchema("tw_cs");
      schemas.push(schema);
      const store = open(schema);
      await store.migrate();
      return store;
    },
    async makePair() {
      const schema = freshSchema("tw_cs");
      schemas.push(schema);
      const first = open(schema);
      await first.migrate();
      return [first, open(schema)];
    },
  };
}

/** MemoryStore, PgStore on PGlite, and PgStore on `TEST_DATABASE_URL` if set. */
export const storeTargets: StoreTarget[] = [
  memory,
  pgliteTarget,
  ...(process.env.TEST_DATABASE_URL ? [postgresTarget(process.env.TEST_DATABASE_URL)] : []),
];

/** Drops the Postgres schemas the targets created and closes their pools; call from `afterAll`. */
export async function cleanUpStoreTargets(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (url && schemas.length > 0) {
    const admin = new Pool({ connectionString: url });
    for (const schema of schemas.splice(0)) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
    }
    await admin.end();
  }
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
}
