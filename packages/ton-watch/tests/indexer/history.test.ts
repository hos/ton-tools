import { describe, expect, test } from "bun:test";

import { Indexer } from "../../src/indexer/indexer";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import type { Store } from "../../src/stores/store";
import { FakeChain, FakeHistory, FakeSource, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const B = fakeAddress(2);

async function setup(perAccount = 400) {
  const chain = new FakeChain();
  chain.grow([A, B], perAccount, 3);
  const store = new MemoryStore();
  for (const a of [A, B]) await store.addAddress(a, { startLt: 0n });
  return { chain, store, source: new FakeSource(chain) };
}

async function expectComplete(store: Store, chain: FakeChain) {
  for (const a of [A, B]) {
    const stored = await store.read(a, 0n, 1n << 62n, 1_000_000);
    expect(stored.map((t) => t.lt)).toEqual(chain.txs(a).map((t) => t.lt));
    expect((await store.getAddress(a))?.frontier?.lt).toBe(chain.txs(a).at(-1)!.lt);
  }
}

describe("history plug-in", () => {
  test("fallback: history pruned from every liteserver is fetched from the plug-in", async () => {
    const { chain, store, source } = await setup();
    // Liteservers only keep the newest ~quarter of history.
    source.faults = { archiveFloorLt: chain.txs(A)[300]!.lt };
    const history = new FakeHistory(chain);
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      split: false,
      history: { source: history },
    });
    await indexer.syncOnce();
    await expectComplete(store, chain);
    expect(history.calls.getTransactions).toBeGreaterThan(0);
    // Liteservers still did the recent part.
    expect(
      indexer.metrics.get("ton_watch_history_pages_total", {
        source: "fake-history",
        why: "fallback",
      }),
    ).toBe(history.calls.getTransactions);
  });

  test("without the plug-in the same history is parked, not skipped", async () => {
    const { chain, store, source } = await setup();
    source.faults = { archiveFloorLt: chain.txs(A)[300]!.lt };
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      split: false,
      retryMinMs: 1,
      retryMaxMs: 2,
    });
    await indexer.syncOnce(20);
    expect((await store.getAddress(A))?.frontier).toBeNull();
    expect(indexer.status().find((s) => s.address === A)?.stuck).toBe(1);
  });

  test("boost: bigger pages from the plug-in mean far fewer requests", async () => {
    const { chain, store, source } = await setup();
    const history = new FakeHistory(chain, { pageSize: 200 });
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      split: false,
      history: { source: history, mode: "boost" },
    });
    await indexer.syncOnce();
    await expectComplete(store, chain);
    expect(history.calls.getTransactions).toBe(4); // 2 addresses × 400 tx / 200
    expect(source.calls.getTransactions ?? 0).toBe(0);
  });

  test("boost leaves work to liteservers while the plug-in is busy", async () => {
    const { chain, store, source } = await setup();
    const history = new FakeHistory(chain, { busy: true });
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      split: false,
      history: { source: history, mode: "boost" },
    });
    await indexer.syncOnce();
    await expectComplete(store, chain);
    expect(history.calls.getTransactions).toBe(0);
  });

  test("a wrong page from the plug-in is rejected; liteservers fill in", async () => {
    const { chain, store, source } = await setup();
    const history = new FakeHistory(chain, { corrupt: true });
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      split: false,
      history: { source: history, mode: "boost" },
    });
    await indexer.syncOnce();
    await expectComplete(store, chain);
    expect(
      indexer.metrics.get("ton_watch_errors_total", { kind: "bad_response", where: "history" }),
    ).toBeGreaterThan(0);
  });

  test("a failing plug-in never blocks liteserver fetching", async () => {
    const { chain, store, source } = await setup();
    const history = new FakeHistory(chain, { fail: true });
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      history: { source: history, mode: "boost" },
    });
    await indexer.syncOnce();
    await expectComplete(store, chain);
  });

  test("enabled: false switches it off without unwiring", async () => {
    const { chain, store, source } = await setup();
    const history = new FakeHistory(chain);
    const indexer = new Indexer({
      store,
      source,
      detect: "poll",
      history: { source: history, mode: "boost", enabled: false },
    });
    await indexer.syncOnce();
    await expectComplete(store, chain);
    expect(history.calls.getTransactions).toBe(0);
  });
});
