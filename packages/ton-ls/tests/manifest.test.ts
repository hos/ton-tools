/**
 * The package is described twice: `package.json` for the bun workspace and
 * `jsr.json` for publishing. They are not linked, so this keeps the name,
 * version and entry points equal.
 */
import { expect, test } from "bun:test";

import jsr from "../jsr.json";
import pkg from "../package.json";

test("package.json and jsr.json agree on name, version and exports", () => {
  expect(jsr.name).toBe(pkg.name);
  expect(jsr.version).toBe(pkg.version);
  expect(jsr.exports).toEqual(pkg.exports);
});
