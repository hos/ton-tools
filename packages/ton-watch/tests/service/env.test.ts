import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ENV_VARS } from "../../src/service/env";

const SRC = join(import.meta.dir, "../../src");
const PACKAGE = join(import.meta.dir, "../..");
/** Where the variables are documented in full. */
const SERVICE_DOC = join(PACKAGE, "docs/service.md");
/** Every page that may mention a variable. */
const DOCS = [join(PACKAGE, "README.md"), ...sources(join(PACKAGE, "docs"), ".md")];

/** Every file under `dir` with `extension`, recursively. */
function sources(dir: string, extension = ".ts"): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
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

  test("docs/service.md documents every variable", () => {
    const doc = readFileSync(SERVICE_DOC, "utf8");
    expect(tableNames.filter((name) => !doc.includes(name))).toEqual([]);
  });

  test("the docs mention no TON_WATCH_ variable the service does not read", () => {
    const readme = DOCS.map((file) => readFileSync(file, "utf8")).join("\n");
    const mentioned = new Set(
      [...readme.matchAll(/\bTON_WATCH_[A-Z0-9_]*[A-Z0-9](?![A-Z0-9_])/g)].map(([name]) => name),
    );
    expect([...mentioned].filter((name) => !(tableNames as string[]).includes(name))).toEqual([]);
  });
});
