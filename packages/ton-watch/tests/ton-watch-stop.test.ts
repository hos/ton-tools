/**
 * `stop()` and `close()` from the client's side: they never wait on the chain for
 * more than `stopTimeoutMs`, but a consumer handler in progress always finishes
 * and its cursor is committed.
 */

import { describe, expect, test } from "bun:test";

import type { IndexedTx } from "../src/core/types";
import { MemoryStore } from "../src/stores/memory/memory-store";
import { TonWatch } from "../src/ton-watch";
import { silentLogger } from "../src/util/logger";
import { FakeChain, FakeSource, fakeAddress } from "./fixtures/fake-chain";

const A = fakeAddress(1);
const EPSILON_MS = 400;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => {});

const until = async (cond: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
};

function make(chain: FakeChain, store = new MemoryStore()) {
  const source = new FakeSource(chain);
  let closed = 0;
  Object.assign(source, {
    close: async () => {
      closed++;
    },
  });
  const watch = new TonWatch({
    store,
    source,
    tickMs: 10,
    maxIdlePollMs: 0,
    stopTimeoutMs: 100,
    logger: silentLogger,
  });
  return { watch, source, store, sourceClosed: () => closed };
}

describe("TonWatch.close()", () => {
  test("resolves within stopTimeoutMs while the source never answers, and closes it", async () => {
    const chain = new FakeChain();
    chain.grow([A], 200, 8);
    const { watch, source, sourceClosed } = make(chain);
    let calls = 0;
    source.getTransactions = () => {
      calls++;
      return never();
    };
    await watch.addAddress(A, { from: "earliest" });
    await watch.start();
    await until(() => calls > 0);

    const startedAt = performance.now();
    await watch.close();
    expect(performance.now() - startedAt).toBeLessThan(100 + EPSILON_MS);
    expect(sourceClosed()).toBe(1);
  });

  test("waits for a handler call in progress past stopTimeoutMs; its cursor is committed", async () => {
    const chain = new FakeChain();
    chain.grow([A], 20, 4);
    const store = new MemoryStore();
    const { watch } = make(chain, store);
    await watch.addAddress(A, { from: "earliest" });
    let entered: IndexedTx | null = null;
    let finished = false;
    watch.process(
      "slow",
      async (tx) => {
        entered = tx;
        await sleep(400);
        finished = true;
      },
      { pollMs: 10 },
    );
    await watch.start();
    await until(() => entered !== null);

    const startedAt = performance.now();
    await watch.close();
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(finished).toBe(true);
    expect(await store.getCursor("slow", A)).toBe(entered!.lt);
  });
});
