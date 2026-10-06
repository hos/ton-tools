import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ENV_VARS } from "../../src/service/env";

const SRC = join(import.meta.dir, "../../src");
const README = join(import.meta.dir, "../../README.md");

/** Every `.ts` file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Variable names the service code mentions: `TON_WATCH_*`, and any `env.X` read. */
function namesInSource(): Set<string> {
  const names = new Set<string>();
  for (const file of [...sources(join(SRC, "service")), ...sources(join(SRC, "bin"))]) {
    const text = readFileSync(file, "utf8");
    for (const [name] of text.matchAll(/\bTON_WATCH_[A-Z0-9_]*[A-Z0-9](?![A-Z0-9_])/g))
      names.add(name);
    for (const [, name] of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(name!);
  }
  return names;
}

const tableNames = ENV_VARS.map(({ name }) => name);

describe("ENV_VARS", () => {
  test("lists exactly the variables the service reads", () => {
    expect([...namesInSource()].sort()).toEqual([...tableNames].sort());
  });

  test("names are unique and, except the DATABASE_URL fallback, prefixed TON_WATCH_", () => {
    expect(new Set(tableNames).size).toBe(tableNames.length);
    expect(tableNames.filter((name) => !name.startsWith("TON_WATCH_"))).toEqual(["DATABASE_URL"]);
  });

  test("every entry has a description", () => {
    for (const { description } of ENV_VARS) expect(description.length).toBeGreaterThan(0);
  });

  // Enabled after the README is updated for the TON_WATCH_ renames: the docs pass
  // turns this into `test`.
  test.todo("README documents every variable", () => {
    const readme = readFileSync(README, "utf8");
    expect(tableNames.filter((name) => !readme.includes(name))).toEqual([]);
  });
});
