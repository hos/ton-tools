/**
 * The package is described twice: `package.json` for the bun workspace and
 * `jsr.json` for publishing. They are not linked, so this keeps the name,
 * version and entry points equal, and `VERSION` (src/version.ts) with them.
 */
import { expect, test } from "bun:test";

import jsr from "../jsr.json";
import pkg from "../package.json";
import { VERSION } from "../src/version";

test("package.json and jsr.json agree on name, version and exports", () => {
  expect(jsr.name).toBe(pkg.name);
  expect(jsr.version).toBe(pkg.version);
  expect(jsr.exports).toEqual(pkg.exports);
});

test("VERSION is the package version", () => {
  expect(VERSION).toBe(pkg.version);
});

test("every entry point is published", () => {
  const { include, exclude } = jsr.publish;
  for (const file of Object.values(jsr.exports)) {
    const path = file.replace(/^\.\//, "");
    expect(include.some((dir) => path.startsWith(`${dir}/`))).toBe(true);
    expect(exclude.some((dir) => path.startsWith(`${dir}/`))).toBe(false);
  }
});
