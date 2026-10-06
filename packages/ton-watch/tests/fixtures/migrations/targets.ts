import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";

import { type PgDatabase, poolDatabase } from "../../../src/stores/pg/database";

/** A database the migration tests run against; each test takes fresh schemas from it. */
export interface DbTarget {
  name: string;
  db: PgDatabase;
  /** A schema name not used before (dropped by `cleanUp` on Postgres). */
  schema(prefix: string): string;
  /** Another handle on the same database, as a second process would have (PGlite: the same one). */
  connect(): PgDatabase;
}

let seq = 0;
const unique = (prefix: string) => `${prefix}_${process.pid}_${seq++}`;

let pglite: PgDatabase | null = null;
/** The Postgres target's main handle; reopened after `cleanUpDbTargets` (one per test file). */
let postgres: PgDatabase | null = null;
const pools: Pool[] = [];
const schemas: string[] = [];

const pgliteTarget: DbTarget = {
  name: "PGlite",
  get db() {
    pglite ??= new PGlite() as unknown as PgDatabase;
    return pglite;
  },
  schema: unique,
  connect() {
    return this.db;
  },
};

function postgresTarget(url: string): DbTarget {
  const open = () => {
    const pool = new Pool({ connectionString: url });
    pools.push(pool);
    return poolDatabase(pool);
  };
  return {
    name: "Postgres",
    get db() {
      postgres ??= open();
      return postgres;
    },
    schema(prefix) {
      const schema = unique(`tw_${prefix}`);
      schemas.push(schema);
      return schema;
    },
    connect: open,
  };
}

/** PGlite, plus real Postgres when `TEST_DATABASE_URL` is set. */
export const dbTargets: DbTarget[] = [
  pgliteTarget,
  ...(process.env.TEST_DATABASE_URL ? [postgresTarget(process.env.TEST_DATABASE_URL)] : []),
];

/** Drops the Postgres schemas the targets handed out and closes their pools; for `afterAll`. */
export async function cleanUpDbTargets(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (url && schemas.length > 0) {
    const admin = new Pool({ connectionString: url });
    for (const schema of schemas.splice(0)) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
    }
    await admin.end();
  }
  postgres = null;
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
}
