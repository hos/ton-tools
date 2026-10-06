/**
 * The migration history itself: static rules every statement must follow, the
 * frozen copy of every released migration, and the snapshot of the schema they
 * build. Runner behaviour is in migrator.test.ts, upgrades of seeded databases in
 * migration-upgrade.test.ts. Rules and recipe: docs/migrations.md.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  compatibleFrom,
  type Migration,
  migrationChecksum,
  migrations,
  SCHEMA_PLACEHOLDER,
} from "../../src/stores/pg/migrations";
import { CONCURRENT_INDEX, migrateSchema } from "../../src/stores/pg/migrator";
import { describeSchema } from "../fixtures/migrations/catalog";
import {
  FROZEN_DIR,
  frozenFileName,
  loadFrozen,
  SNAPSHOT_FILE,
  UPDATE_ENV,
  updating,
  writeFrozen,
} from "../fixtures/migrations/history";
import { cleanUpDbTargets, dbTargets } from "../fixtures/migrations/targets";

afterAll(cleanUpDbTargets);

/** Tables that grow without bound: indexes on them must be built concurrently. */
const LARGE_TABLES = ["transactions"];

/**
 * Statements allowed to break a rule after review, keyed `<version>:<statement index>`,
 * with the reason. Keep this empty unless there is no other way.
 */
const REVIEWED_EXCEPTIONS: Record<string, string> = {};

/** Every rule `statement` (number `index` of `migration`) breaks. */
function lint(migration: Migration, position: number, statement: string): string[] {
  const sql = statement
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const nonTransactional = migration.transaction === false;
  const problems: string[] = [];
  const fail = (rule: string) => problems.push(`v${migration.version}[${position}]: ${rule}`);

  const withoutFkActions = sql.replace(
    /\bon (delete|update) (cascade|restrict|set null|set default|no action)\b/g,
    "",
  );
  if (/\b(drop|truncate|delete|rename)\b/.test(withoutFkActions)) {
    fail("destructive (drop/truncate/delete/rename): expand instead, never remove");
  }
  if (/\balter column \S+ (set data )?type\b/.test(sql)) {
    fail("changes a column type (rewrites the table, breaks old code): add a new column");
  }
  if (/\balter column \S+ set not null\b/.test(sql)) {
    fail("set not null scans the table under an exclusive lock: add a `not valid` check");
  }
  for (const [, clause] of sql.matchAll(/\badd column\b([^,]*)/g)) {
    if (/\bnot null\b/.test(clause!) && !/\bdefault\b/.test(clause!)) {
      fail("adds a not null column without a default (old code's inserts would fail)");
    }
  }
  for (const [, clause] of sql.matchAll(/\badd constraint \S+ ([^,]*)/g)) {
    if (/^(check|foreign key)\b/.test(clause!) && !/\bnot valid\b/.test(clause!)) {
      fail("adds a check/foreign key without `not valid` (validate it in a later statement)");
    }
    if (/^(unique|primary key)\b/.test(clause!) && !/\busing index\b/.test(clause!)) {
      fail("adds a unique/primary key directly: build the index concurrently, then `using index`");
    }
  }

  const createsIndex = /\bcreate (unique )?index\b/.test(sql);
  const concurrent = /\bconcurrently\b/.test(sql);
  if (concurrent && !nonTransactional) {
    fail("`concurrently` cannot run in a transaction: use `transaction: false`");
  }
  if (concurrent && createsIndex && !CONCURRENT_INDEX.test(sql)) {
    fail(
      "write concurrent index builds as `create [unique] index concurrently if not exists <name> on`",
    );
  }
  const indexed = /\bindex (?:concurrently )?(?:if not exists )?\w+ on (?:only )?([^\s(]+)/.exec(
    sql,
  )?.[1];
  if (createsIndex && !concurrent && LARGE_TABLES.some((t) => indexed === `$s.${t}`)) {
    fail(`indexes on ${indexed} must be built concurrently (transaction: false)`);
  }
  if (nonTransactional && !/\bif (not )?exists\b/.test(sql)) {
    fail("statements of a non-transactional migration must be idempotent (`if not exists`)");
  }

  const references = [
    /\b(?:create|alter) table (?:if not exists )?(?:only )?([^\s(]+)/g,
    /\breferences ([^\s(]+)/g,
    /\bindex (?:concurrently )?(?:if not exists )?\w+ on (?:only )?([^\s(]+)/g,
    /\binsert into ([^\s(]+)/g,
    /\bupdate ([^\s(]+) /g,
    /\b(?:from|join) ([^\s(),]+)/g,
  ];
  for (const pattern of references) {
    for (const [, table] of sql.matchAll(pattern)) {
      if (!table!.startsWith(`${SCHEMA_PLACEHOLDER.toLowerCase()}.`)) {
        fail(`${table} is not written as ${SCHEMA_PLACEHOLDER}.<table>`);
      }
    }
  }
  if (/\bton_watch\b/.test(sql)) fail("hard-codes the schema name");
  return problems;
}

describe("migration definitions", () => {
  test("versions are 1, 2, 3, … and names unique snake_case", () => {
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_, i) => i + 1));
    expect(new Set(migrations.map((m) => m.name)).size).toBe(migrations.length);
    for (const m of migrations) expect(m.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test("compatibleFrom is a version at or below the migration's own", () => {
    for (const m of migrations) {
      expect(Number.isInteger(compatibleFrom(m))).toBe(true);
      expect(compatibleFrom(m)).toBeGreaterThanOrEqual(1);
      expect(compatibleFrom(m)).toBeLessThanOrEqual(m.version);
    }
  });

  test("every statement follows the rules of docs/migrations.md", () => {
    const problems = migrations.flatMap((m) => {
      expect(m.up.length).toBeGreaterThan(0);
      return m.up.flatMap((sql, i) =>
        REVIEWED_EXCEPTIONS[`${m.version}:${i}`] ? [] : lint(m, i, sql),
      );
    });
    expect(problems).toEqual([]);
  });

  test("the rules catch what they are meant to", () => {
    const m = (up: string[], transaction?: boolean): Migration => ({
      version: 9,
      name: "x",
      up,
      transaction,
    });
    const broken: [Migration, RegExp][] = [
      [m([`drop table $S.cursors`]), /destructive/],
      [m([`alter table $S.cursors drop column lt`]), /destructive/],
      [m([`delete from $S.cursors`]), /destructive/],
      [m([`truncate $S.cursors`]), /destructive/],
      [m([`alter table $S.cursors rename column lt to x`]), /destructive/],
      [m([`alter table $S.cursors alter column lt type numeric`]), /column type/],
      [m([`alter table $S.cursors alter column lt set data type numeric`]), /column type/],
      [m([`alter table $S.cursors alter column last_error set not null`]), /set not null/],
      [m([`alter table $S.cursors add column x int not null`]), /without a default/],
      [m([`alter table $S.cursors add constraint c check (lt > 0)`]), /not valid/],
      [m([`alter table $S.cursors add constraint c unique (lt)`]), /using index/],
      [m([`create index t_idx on $S.transactions (utime)`]), /concurrently/],
      [m([`create index concurrently if not exists t_idx on $S.cursors (lt)`]), /transaction/],
      [m([`create index concurrently t_idx on $S.cursors (lt)`], false), /if not exists/],
      [m([`alter table $S.cursors add column x int`], false), /idempotent/],
      [m([`create table cursors2 (x int)`]), /\$S/],
      [m([`create table $S.c (a bigint references addresses (id))`]), /\$S/],
      [m([`insert into ton_watch.cursors values (1)`]), /\$S|schema name/],
    ];
    for (const [migration, rule] of broken) {
      expect(lint(migration, 0, migration.up[0]!).join("\n")).toMatch(rule);
    }
    const fine: Migration[] = [
      m([`alter table $S.cursors add column x int not null default 0`]),
      m([`alter table $S.cursors add column note text`]),
      m([`create table $S.c (a bigint references $S.addresses (id) on delete cascade)`]),
      m([`alter table $S.cursors add constraint c check (lt > 0) not valid`]),
      m([`alter table $S.cursors validate constraint c`]),
      m([`create unique index concurrently if not exists t_idx on $S.transactions (hash)`], false),
      m([`alter table $S.addresses add column if not exists x int`], false),
    ];
    for (const migration of fine) expect(lint(migration, 0, migration.up[0]!)).toEqual([]);
  });
});

describe("released migrations are frozen", () => {
  test("each has a frozen copy it still matches; none was removed", () => {
    const frozen = new Map(loadFrozen().map((f) => [f.version, f]));
    const problems: string[] = [];
    for (const m of migrations) {
      const copy = frozen.get(m.version);
      frozen.delete(m.version);
      if (copy === undefined) {
        if (updating) {
          writeFrozen({
            version: m.version,
            name: m.name,
            transaction: m.transaction !== false,
            compatibleFrom: compatibleFrom(m),
            checksum: migrationChecksum(m),
            up: [...m.up],
          });
          continue;
        }
        problems.push(
          `migration ${m.version} (${m.name}) has no frozen copy; once it is final, run ` +
            `${UPDATE_ENV}=1 bun test tests/stores/migrations.test.ts and commit ` +
            `${FROZEN_DIR}/${frozenFileName(m)}`,
        );
        continue;
      }
      // The pinned checksum is the one databases store: it must hold for both copies.
      if (migrationChecksum(copy) !== copy.checksum) {
        problems.push(`frozen copy of migration ${m.version} was edited (checksum mismatch)`);
      }
      if (migrationChecksum(m) !== copy.checksum) {
        problems.push(
          `migration ${m.version} (${m.name}) was edited after release: databases that applied ` +
            `it will refuse to start. Revert it and add a new migration instead`,
        );
      }
      if (m.name !== copy.name) problems.push(`migration ${m.version} was renamed`);
      if ((m.transaction !== false) !== copy.transaction) {
        problems.push(`migration ${m.version}: transaction flag changed`);
      }
      if (compatibleFrom(m) !== copy.compatibleFrom) {
        problems.push(
          `migration ${m.version}: compatibleFrom changed (databases keep the old one)`,
        );
      }
    }
    for (const copy of frozen.values()) {
      problems.push(`migration ${copy.version} (${copy.name}) was removed; it is released`);
    }
    expect(problems).toEqual([]);
  });
});

describe.each(dbTargets)("schema snapshot ($name)", (target) => {
  test("a fresh database migrates to exactly the committed schema", async () => {
    const schema = target.schema("snap");
    await migrateSchema(target.db, schema);
    const actual = await describeSchema(target.db, schema);
    if (updating && target.name === "PGlite") writeFileSync(SNAPSHOT_FILE, actual);
    const hint =
      `The migrated schema differs from ${SNAPSHOT_FILE}. If the change is intended (a new ` +
      `migration), regenerate it with ${UPDATE_ENV}=1 bun test tests/stores/migrations.test.ts ` +
      `and review the diff; otherwise a migration changed an existing database's shape.`;
    if (!existsSync(SNAPSHOT_FILE)) throw new Error(hint);
    try {
      expect(actual).toBe(readFileSync(SNAPSHOT_FILE, "utf8"));
    } catch (error) {
      throw new Error(`${hint}\n\n${(error as Error).message}`);
    }
  });
});
