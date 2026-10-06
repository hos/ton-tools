import { describe, expect, test } from "bun:test";

import { Indexer } from "../../src/indexer/indexer";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SPLIT,
  type IndexerOptions,
  resolveHistory,
  resolveSettings,
  resolveSplit,
} from "../../src/indexer/options";
import { Metrics } from "../../src/metrics/metrics";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { FakeChain, FakeHistory, FakeSource, fakeAddress } from "../fixtures/fake-chain";

const base = (): IndexerOptions => ({
  store: new MemoryStore(),
  source: new FakeSource(new FakeChain()),
});

describe("resolveSettings", () => {
  test("applies the documented defaults", () => {
    expect(resolveSettings(base())).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      concurrency: 16,
      tickMs: 1_000,
      detect: "auto",
      autoBlocksThreshold: 50,
      maxIdlePollMs: 30_000,
      reconcileMs: 600_000,
      gapScanMs: 60_000,
      retryMinMs: 1_000,
      retryMaxMs: 60_000,
      archiveRetryMs: 600_000,
      addressMetrics: true,
    });
  });

  test("every option overrides its default", () => {
    const options = {
      concurrency: 3,
      tickMs: 7,
      detect: "blocks",
      autoBlocksThreshold: 9,
      maxIdlePollMs: 11,
      reconcileMs: 13,
      gapScanMs: 17,
      retryMinMs: 19,
      retryMaxMs: 23,
      archiveRetryMs: 29,
      addressMetrics: false,
    } as const;
    expect(resolveSettings({ ...base(), ...options })).toEqual(options);
  });

  test("zero and false are kept, not replaced by defaults", () => {
    const settings = resolveSettings({
      ...base(),
      maxIdlePollMs: 0,
      gapScanMs: 0,
      retryMinMs: 0,
      addressMetrics: false,
    });
    expect(settings).toMatchObject({
      maxIdlePollMs: 0,
      gapScanMs: 0,
      retryMinMs: 0,
      addressMetrics: false,
    });
  });

  test("does not carry unrelated options into the settings", () => {
    const settings = resolveSettings({ ...base(), split: false });
    expect(Object.keys(settings).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});

describe("resolveSplit", () => {
  test("defaults when the source can find split points", () => {
    expect(resolveSplit(base())).toEqual(DEFAULT_SPLIT);
    expect(DEFAULT_SPLIT).toEqual({ minTxs: 1_000, targetTxs: 400, maxParts: 32 });
  });

  test("partial options are filled from defaults", () => {
    expect(resolveSplit({ ...base(), split: { targetTxs: 50 } })).toEqual({
      ...DEFAULT_SPLIT,
      targetTxs: 50,
    });
  });

  test("off when disabled or when the source has no findTxNear", () => {
    expect(resolveSplit({ ...base(), split: false })).toBeNull();
    const source = new FakeSource(new FakeChain());
    (source as any).findTxNear = undefined;
    expect(resolveSplit({ store: new MemoryStore(), source, split: { minTxs: 1 } })).toBeNull();
  });
});

describe("resolveHistory", () => {
  const history = new FakeHistory(new FakeChain());

  test("null without a plug-in or when it is switched off", () => {
    expect(resolveHistory(base())).toBeNull();
    expect(resolveHistory({ ...base(), history: { source: history, enabled: false } })).toBeNull();
  });

  test("defaults to fallback mode, enabled", () => {
    expect(resolveHistory({ ...base(), history: { source: history } })).toEqual({
      source: history,
      mode: "fallback",
      enabled: true,
    });
  });

  test("keeps an explicit mode", () => {
    expect(
      resolveHistory({ ...base(), history: { source: history, mode: "boost", enabled: true } }),
    ).toEqual({ source: history, mode: "boost", enabled: true });
  });
});

describe("Indexer option wiring", () => {
  test("records into the source's metrics unless a registry is given", () => {
    const options = base();
    expect(new Indexer(options).metrics).toBe(options.source.metrics!);
    const metrics = new Metrics();
    expect(new Indexer({ ...options, metrics }).metrics).toBe(metrics);
    const source = new FakeSource(new FakeChain());
    (source as any).metrics = undefined;
    expect(new Indexer({ store: new MemoryStore(), source }).metrics).toBeInstanceOf(Metrics);
  });

  test("a source without findTxNear indexes long ranges without splitting", async () => {
    const chain = new FakeChain();
    const a = fakeAddress(1);
    chain.grow([a], 200, 8);
    const store = new MemoryStore();
    await store.addAddress(a, { startLt: 0n });
    const source = new FakeSource(chain);
    (source as any).findTxNear = undefined;
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      split: { minTxs: 10, targetTxs: 5 },
    });
    await indexer.syncOnce();
    expect(indexer.metrics.get("ton_watch_splits_total")).toBe(0);
    expect((await store.getAddress(a))!.frontier?.lt).toBe(chain.txs(a).at(-1)!.lt);
  });

  test("addressMetrics: false publishes no per-address gauges", async () => {
    const chain = new FakeChain();
    const a = fakeAddress(1);
    chain.grow([a], 3);
    const store = new MemoryStore();
    await store.addAddress(a, { startLt: 0n });
    const indexer = new Indexer({
      store,
      source: new FakeSource(chain),
      detect: "poll",
      addressMetrics: false,
    });
    await indexer.syncOnce();
    expect(indexer.metrics.toPrometheus()).not.toContain("ton_watch_address_");
    expect(indexer.metrics.get("ton_watch_addresses")).toBe(1);
  });
});
