import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ERROR_SITES,
  METRICS,
  type MetricDefinition,
  SOURCE_METHODS,
} from "../../src/metrics/registry";

const SRC = join(import.meta.dir, "../../src");

// Type-level: every entry is a well-formed definition (the registry itself is only
// `as const`, so this is where the shape is enforced).
const registry: Record<string, MetricDefinition> = METRICS satisfies Record<
  string,
  MetricDefinition
>;

/** Every `ton_watch_*` metric name quoted in the source, outside the registry. */
function namesInSource(): Set<string> {
  const names = new Set<string>();
  const files = readdirSync(SRC, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !file.endsWith(join("metrics", "registry.ts")));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [, name] of text.matchAll(/["'`](ton_watch_[a-z0-9_]+)["'`]/g)) names.add(name!);
  }
  return names;
}

describe("METRICS registry", () => {
  test("every registered metric is emitted somewhere, and nothing else is", () => {
    expect([...namesInSource()].sort()).toEqual(Object.keys(METRICS).sort());
  });

  test("names follow Prometheus conventions", () => {
    for (const [name, { type, help, labels }] of Object.entries(registry)) {
      expect(name).toMatch(/^ton_watch_[a-z][a-z0-9_]*$/);
      if (type === "counter") expect(name).toEndWith("_total");
      else expect(name).not.toEndWith("_total");
      expect(help.length).toBeGreaterThan(0);
      expect(help).not.toContain("\n");
      for (const label of labels) expect(label).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  test("closed label sets end in other; error sites include every source method", () => {
    expect(SOURCE_METHODS.at(-1)).toBe("other");
    expect(ERROR_SITES.at(-1)).toBe("other");
    expect(new Set(ERROR_SITES).size).toBe(ERROR_SITES.length);
    for (const method of SOURCE_METHODS) expect(ERROR_SITES).toContain(method);
  });
});
