/**
 * Golden files pin external contracts (webhook payloads, CLI and HTTP JSON): a
 * change to them must show up as a diff under `tests/fixtures/golden/`.
 * Regenerate deliberately with `UPDATE_GOLDEN=1 bun test`.
 */
import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "golden");

/** Asserts that `text` equals the golden file `name`, or rewrites it under `UPDATE_GOLDEN=1`. */
export function expectGolden(name: string, text: string): void {
  const path = join(DIR, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(path, text);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(`missing golden file ${path}; create it with UPDATE_GOLDEN=1`);
  }
  expect(text).toBe(readFileSync(path, "utf8"));
}

/** `expectGolden` for a JSON value, as the service writes it (2-space indent, final newline). */
export function expectGoldenJson(name: string, value: unknown): void {
  expectGolden(name, `${JSON.stringify(value, null, 2)}\n`);
}
