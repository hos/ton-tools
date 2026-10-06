import { describe, expect, spyOn, test } from "bun:test";

import { beginCell, Cell, loadTransaction, storeTransaction } from "@ton/core";

import { recordFromCell } from "../../src/core/transaction";
import type { TxId, TxRecord } from "../../src/core/types";
import { Indexer } from "../../src/indexer/indexer";
import type { IndexerOptions } from "../../src/indexer/options";
import type { Walk } from "../../src/indexer/walk";
import { WalkScheduler } from "../../src/indexer/walk-scheduler";
import { Metrics } from "../../src/metrics/metrics";
import type { HistorySource } from "../../src/source/history";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { FakeChain, FakeHistory, FakeSource, fakeAddress, rng } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const B = fakeAddress(2);
const ADDRESSES = [A, B];

/** Turns the honest page for `from` into a wrong one. */
type Lie = (page: TxRecord[], ctx: { chain: FakeChain; address: string; from: TxId }) => TxRecord[];

function tamper(tx: TxRecord): TxRecord {
  const parsed = loadTransaction(Cell.fromBoc(tx.boc)[0]!.beginParse());
  parsed.now += 1;
  return recordFromCell(beginCell().store(storeTransaction(parsed)).endCell(), tx.address);
}

const other = (address: string) => (address === A ? B : A);

/** Wrong answers a source can give that are all derived from real cells (or crude field edits). */
const LIES: Record<string, Lie> = {
  empty: () => [],
  reversed: (p) => (p.length > 1 ? [...p].reverse() : []),
  duplicated: (p) => [p[0]!, ...p],
  skipsOne: (p) => (p.length > 2 ? [p[0]!, ...p.slice(2)] : []),
  swapped: (p) => (p.length > 2 ? [p[0]!, p[2]!, p[1]!, ...p.slice(3)] : []),
  startsOlder: (p) => p.slice(1),
  startsNewer: (p, { chain, address, from }) => {
    const newer = chain.txs(address).find((t) => t.lt > from.lt);
    return newer ? [newer, ...p] : [];
  },
  otherAddress: (p, { chain, address }) => {
    const theirs = chain.txs(other(address));
    return theirs.slice(-p.length).reverse();
  },
  foreignTxInside: (p, { chain, address }) =>
    p.length > 1 ? [p[0]!, chain.txs(other(address))[0]!, ...p.slice(2)] : [],
  tamperedCursor: (p) => [tamper(p[0]!), ...p.slice(1)],
  tamperedInside: (p) => (p.length > 1 ? [p[0]!, tamper(p[1]!), ...p.slice(2)] : []),
  wrongHash: (p) => [{ ...p[0]!, hash: Buffer.alloc(32, 0x42) }, ...p.slice(1)],
  hugeLt: (p) => [{ ...p[0]!, lt: p[0]!.lt + (1n << 64n) }, ...p.slice(1)],
  forgedPrevLt: (p) => [{ ...p[0]!, prevLt: p[0]!.prevLt + 1n }, ...p.slice(1)],
};

/** `FakeSource` whose `getTransactions` lies with probability `rate`. */
class LyingSource extends FakeSource {
  lies = 0;
  private readonly roll: () => number;
  constructor(
    chain: FakeChain,
    public lie: Lie,
    public rate: number,
    seed = 7,
  ) {
    super(chain);
    this.roll = rng(seed);
  }
  override async getTransactions(address: string, from: TxId, count: number) {
    const page = await super.getTransactions(address, from, count);
    if (this.roll() >= this.rate) return page;
    this.lies++;
    return this.lie(page, { chain: this.chain, address, from });
  }
}

/** History plug-in over `FakeHistory` that lies with probability `rate`. */
class LyingHistory implements HistorySource {
  readonly name = "lying-history";
  readonly inner: FakeHistory;
  lies = 0;
  private readonly roll: () => number;
  constructor(
    readonly chain: FakeChain,
    public lie: Lie,
    public rate: number,
    readonly maxPageSize = 50,
  ) {
    this.inner = new FakeHistory(chain, { pageSize: maxPageSize });
    this.roll = rng(11);
  }
  get calls() {
    return this.inner.calls.getTransactions;
  }
  async getTransactions(address: string, from: TxId, count: number) {
    const page = await this.inner.getTransactions(address, from, count);
    if (this.roll() >= this.rate) return page;
    this.lies++;
    return this.lie(page, { chain: this.chain, address, from });
  }
}

/** A store that records every write that differs from the true chain. */
class AuditedStore extends MemoryStore {
  readonly violations: string[] = [];
  constructor(private readonly chain: FakeChain) {
    super();
  }
  override async write(address: string, txs: TxRecord[]): Promise<number> {
    for (const tx of txs) {
      const real = this.chain.txs(address).find((t) => t.lt === tx.lt);
      const same =
        real?.hash.equals(tx.hash) === true &&
        real.prevLt === tx.prevLt &&
        real.prevHash.equals(tx.prevHash) &&
        real.boc.equals(tx.boc) &&
        real.utime === tx.utime;
      if (!same) this.violations.push(`${address} lt ${tx.lt}`);
    }
    return super.write(address, txs);
  }
}

async function setup(perAccount = 80) {
  const chain = new FakeChain();
  chain.grow(ADDRESSES, perAccount, 3);
  const store = new AuditedStore(chain);
  for (const a of ADDRESSES) await store.addAddress(a, { startLt: 0n });
  return { chain, store };
}

function indexer(options: Omit<IndexerOptions, "detect">) {
  // Retry delays well above a pump() pass: see the WalkScheduler test at the bottom.
  return new Indexer({ detect: "poll", split: false, retryMinMs: 10, retryMaxMs: 20, ...options });
}

async function expectTrueChain(store: AuditedStore, chain: FakeChain) {
  expect(store.violations).toEqual([]);
  for (const a of ADDRESSES) {
    const stored = await store.read(a, 0n, 1n << 70n, 1_000_000);
    expect(stored.map((t) => t.lt)).toEqual(chain.txs(a).map((t) => t.lt));
    expect((await store.getAddress(a))?.frontier?.lt).toBe(chain.txs(a).at(-1)!.lt);
  }
}

async function until(done: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for convergence");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const badResponses = (ix: Indexer, where: string) =>
  ix.metrics.get("ton_watch_errors_total", { kind: "bad_response", where });

describe("indexer against a lying liteserver source", () => {
  test.each(Object.keys(LIES))(
    "%s: rejected every time, converges to the true chain",
    async (name) => {
      const { chain, store } = await setup();
      const source = new LyingSource(chain, LIES[name]!, 0.5);
      const ix = indexer({ store, source });
      await ix.syncOnce();
      await expectTrueChain(store, chain);
      expect(source.lies).toBeGreaterThan(0);
      // Under load the exact count varies with page timing (seen ~1 run in 3 in the
      // full suite); what matters is that lies are caught and none is stored.
      expect(badResponses(ix, "walk")).toBeGreaterThan(0);
      expect(badResponses(ix, "walk")).toBeLessThanOrEqual(source.lies);
    },
  );

  test("a mix of all lies with parallel split walks still converges", async () => {
    const { chain, store } = await setup(300);
    const lies = Object.values(LIES);
    const pick = rng(3);
    const source = new LyingSource(
      chain,
      (p, ctx) => lies[Math.floor(pick() * lies.length)]!(p, ctx),
      0.3,
    );
    const ix = new Indexer({
      store,
      source,
      detect: "poll",
      retryMinMs: 10,
      retryMaxMs: 20,
      split: { minTxs: 50, targetTxs: 40 },
    });
    await ix.syncOnce();
    await expectTrueChain(store, chain);
    expect(source.lies).toBeGreaterThan(10);
  });

  test("a source that always lies stores nothing; the honest path then fills everything", async () => {
    const { chain, store } = await setup(40);
    const source = new LyingSource(chain, LIES.skipsOne!, 1);
    const ix = indexer({ store, source, tickMs: 10 });
    ix.start();
    await new Promise((r) => setTimeout(r, 200));
    await ix.stop();
    expect(store.size).toBe(0);
    expect(store.violations).toEqual([]);
    for (const a of ADDRESSES) expect((await store.getAddress(a))?.frontier).toBeNull();
    expect(source.lies).toBeGreaterThan(2);

    // Walks with 5+ failures no longer hold up drain(), so let the running loop retry them.
    source.rate = 0;
    ix.start();
    await until(
      async () =>
        (await store.getAddress(A))?.frontier !== null &&
        (await store.getAddress(B))?.frontier !== null,
    );
    await ix.stop();
    await expectTrueChain(store, chain);
  });

  test("short honest pages (one tx each) are not lies and converge", async () => {
    const { chain, store } = await setup(30);
    const source = new LyingSource(chain, (p) => p.slice(0, 1), 1);
    const ix = indexer({ store, source });
    await ix.syncOnce();
    await expectTrueChain(store, chain);
    expect(badResponses(ix, "walk")).toBe(0);
    expect(source.calls.getTransactions).toBe(60);
  });

  test("new transactions arriving while the source lies are picked up", async () => {
    const { chain, store } = await setup(30);
    const source = new LyingSource(chain, LIES.otherAddress!, 0.5);
    const ix = indexer({ store, source });
    await ix.syncOnce();
    chain.grow(ADDRESSES, 25, 2);
    await ix.syncOnce();
    await expectTrueChain(store, chain);
  });
});

describe("indexer against a lying history plug-in", () => {
  test.each(Object.keys(LIES))("boost, %s: rejected, liteservers fill in", async (name) => {
    const { chain, store } = await setup();
    const source = new FakeSource(chain);
    const history = new LyingHistory(chain, LIES[name]!, 1);
    const ix = indexer({ store, source, history: { source: history, mode: "boost" } });
    await ix.syncOnce();
    await expectTrueChain(store, chain);
    expect(badResponses(ix, "history")).toBe(history.calls);
    expect(
      ix.metrics.get("ton_watch_history_pages_total", { source: history.name, why: "boost" }),
    ).toBe(0);
  });

  test("boost, intermittent lies: honest history pages are used, lying ones replaced", async () => {
    const { chain, store } = await setup(300);
    const source = new FakeSource(chain);
    const history = new LyingHistory(chain, LIES.skipsOne!, 0.5);
    const ix = indexer({ store, source, history: { source: history, mode: "boost" } });
    await ix.syncOnce();
    await expectTrueChain(store, chain);
    const used = ix.metrics.get("ton_watch_history_pages_total", {
      source: history.name,
      why: "boost",
    });
    expect(used + history.lies).toBe(history.calls);
    expect(used).toBeGreaterThan(0);
    expect(badResponses(ix, "history")).toBe(history.lies);
  });

  test.each(["skipsOne", "tamperedCursor", "otherAddress", "empty"])(
    "fallback, %s: pruned history stays missing rather than wrong, then fills from an honest plug-in",
    async (name) => {
      const { chain, store } = await setup();
      const source = new FakeSource(chain, { archiveFloorLt: chain.txs(A)[40]!.lt });
      const history = new LyingHistory(chain, LIES[name]!, 1);
      const ix = indexer({
        store,
        source,
        tickMs: 5,
        archiveRetryMs: 1,
        history: { source: history },
      });
      await ix.syncOnce(30);
      expect(store.violations).toEqual([]);
      expect(history.lies).toBeGreaterThan(0);
      for (const a of ADDRESSES) {
        expect((await store.getAddress(a))?.frontier).toBeNull();
        // Only the recent part liteservers still serve, and exactly the chain's tail.
        const stored = await store.read(a, 0n, 1n << 70n, 1_000_000);
        const truth = chain.txs(a).map((t) => t.lt);
        expect(stored.length).toBeLessThan(truth.length);
        expect(stored.map((t) => t.lt)).toEqual(truth.slice(-stored.length));
      }

      // Parked walks are retried on their own timer (syncOnce returns once all are parked).
      history.rate = 0;
      ix.start();
      await until(
        async () =>
          (await store.getAddress(A))?.frontier !== null &&
          (await store.getAddress(B))?.frontier !== null,
      );
      await ix.stop();
      await expectTrueChain(store, chain);
    },
  );

  // BUG: PageFetcher/validatePage trust a page's lt/hash/prev fields and never derive
  // them from the BOC. A HistorySource returning a record with the right fields but
  // another transaction's BOC gets that BOC stored, contradicting the HistorySource
  // contract ("cannot change what gets stored", src/source/history.ts).
  test.failing("boost: a record whose BOC does not match its hash is never stored", async () => {
    const { chain, store } = await setup(40);
    const swapBoc: Lie = (p) => (p.length > 1 ? [{ ...p[0]!, boc: p[1]!.boc }, ...p.slice(1)] : p);
    const history = new LyingHistory(chain, swapBoc, 1);
    const ix = indexer({
      store,
      source: new FakeSource(chain),
      history: { source: history, mode: "boost" },
    });
    await ix.syncOnce();
    expect(store.violations).toEqual([]);
  });

  // BUG (same root cause): forged prev fields let a page skip a transaction; the
  // indexer stores the page, links it, and reports a frontier past a transaction it
  // never stored, so consumers silently miss it.
  test.failing("boost: forged prev links cannot make the indexer skip a transaction", async () => {
    const { chain, store } = await setup(40);
    const skip: Lie = (p) =>
      p.length > 2 ? [{ ...p[0]!, prevLt: p[2]!.lt, prevHash: p[2]!.hash }, ...p.slice(2)] : p;
    const history = new LyingHistory(chain, skip, 1);
    const ix = indexer({
      store,
      source: new FakeSource(chain),
      history: { source: history, mode: "boost" },
    });
    await ix.syncOnce();
    await expectTrueChain(store, chain);
  });
});

describe("WalkScheduler retry timing", () => {
  // BUG: src/indexer/walk-scheduler.ts, pump(): nextReady() skips a walk whose
  // notBefore is still in the future at its own Date.now(), then armWakeTimer()
  // re-reads Date.now() and only arms a timer for walks with notBefore > now. If
  // the retry delay elapses between those two reads, the walk is neither started
  // nor timed: it waits for the next external pump(). Under start() that is the
  // next tick (up to tickMs late); under syncOnce() drain() polls
  // hasPendingWork() without pumping, so it loops forever. Seen as a rare hang of
  // syncOnce() with retryMinMs: 1 (roughly 1 run in 300 here).
  test.failing("a retry whose delay elapses during pump() still runs", async () => {
    const realNow = Date.now.bind(Date);
    let runs = 0;
    let restore = () => {};
    const scheduler = new WalkScheduler(
      1,
      async (walk: Walk) => {
        runs++;
        if (runs > 1) {
          scheduler.remove(walk);
          return;
        }
        // Fail and retry 1ms later; time "jumps" 10ms during the pump() that follows.
        const base = realNow();
        walk.notBefore = base + 1;
        let calls = 0;
        const spy = spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? base : base + 10));
        restore = () => spy.mockRestore();
      },
      new Metrics(),
    );
    scheduler.add({
      address: A,
      kind: "gap",
      cursor: { lt: 1n, hash: Buffer.alloc(32) },
      floorLt: 0n,
      topLt: 1n,
    });
    await new Promise((r) => setTimeout(r, 0));
    restore();
    await new Promise((r) => setTimeout(r, 100));
    scheduler.stop();
    expect(runs).toBe(2);
  });
});
