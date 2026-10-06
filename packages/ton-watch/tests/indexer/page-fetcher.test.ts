import { describe, expect, spyOn, test } from "bun:test";

import { SourceError } from "../../src/core/errors";
import type { TxId } from "../../src/core/types";
import { PageFetcher } from "../../src/indexer/page-fetcher";
import { Metrics } from "../../src/metrics/metrics";
import type { HistoryOptions } from "../../src/source/history";
import { FakeChain, FakeHistory, FakeSource, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);

function setup(
  opts: {
    faults?: ConstructorParameters<typeof FakeSource>[1];
    history?: ConstructorParameters<typeof FakeHistory>[1];
    mode?: "fallback" | "boost";
  } = {},
) {
  const chain = new FakeChain();
  chain.grow([A], 50, 4);
  const source = new FakeSource(chain, opts.faults);
  const history = opts.history ? new FakeHistory(chain, opts.history) : null;
  const metrics = new Metrics();
  const settings: Required<HistoryOptions> | null = history
    ? { source: history, mode: opts.mode ?? "fallback", enabled: true }
    : null;
  const fetcher = new PageFetcher(source, settings, metrics);
  const txs = chain.txs(A);
  const at = (i: number): TxId => ({ lt: txs[i]!.lt, hash: txs[i]!.hash });
  const walk = (i = 49) => ({ address: A, cursor: at(i) });
  const historyPages = (why: string) =>
    metrics.get("ton_watch_history_pages_total", { source: "fake-history", why });
  return { chain, source, history, metrics, fetcher, txs, walk, historyPages };
}

const ARCHIVE_MISS = (s: ReturnType<typeof setup>) => s.txs[45]!.lt;

describe("PageFetcher without a history plug-in", () => {
  test("returns a validated page from the cursor down, at the source's page size", async () => {
    const s = setup();
    const spy = spyOn(s.source, "getTransactions");
    const page = await s.fetcher.fetch(s.walk(40));
    expect(page.map((tx) => tx.lt)).toEqual(
      s.txs
        .slice(25, 41)
        .reverse()
        .map((tx) => tx.lt),
    );
    expect(spy).toHaveBeenCalledWith(A, s.walk(40).cursor, 16, { signal: undefined });
  });

  test("rejects a page with a broken link as bad_response", async () => {
    const s = setup({ faults: { badResponse: 1 } });
    const error = await s.fetcher.fetch(s.walk()).catch((e) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error.kind).toBe("bad_response");
  });

  test("rejects a page that does not start at the cursor", async () => {
    const s = setup();
    s.source.getTransactions = async () => s.txs.slice(0, 3).reverse();
    const error = await s.fetcher.fetch(s.walk()).catch((e) => e);
    expect(error.kind).toBe("bad_response");
  });

  test("rejects an empty page", async () => {
    const s = setup();
    s.source.getTransactions = async () => [];
    const error = await s.fetcher.fetch(s.walk()).catch((e) => e);
    expect(error.kind).toBe("bad_response");
  });

  test("an archive miss is thrown as is", async () => {
    const s = setup();
    s.source.faults = { archiveFloorLt: ARCHIVE_MISS(s) };
    const error = await s.fetcher.fetch(s.walk(10)).catch((e) => e);
    expect(error.message).toContain("cannot locate transaction");
  });
});

describe("PageFetcher fallback mode", () => {
  test("serves archive misses from the history plug-in at its own page size", async () => {
    const s = setup({ history: { pageSize: 30 } });
    s.source.faults = { archiveFloorLt: ARCHIVE_MISS(s) };
    const spy = spyOn(s.history!, "getTransactions");
    const page = await s.fetcher.fetch(s.walk(40));
    expect(page.length).toBe(30);
    expect(page[0]!.lt).toBe(s.txs[40]!.lt);
    expect(spy).toHaveBeenCalledWith(A, s.walk(40).cursor, 30, { signal: undefined });
    expect(s.historyPages("fallback")).toBe(1);
    expect(s.historyPages("boost")).toBe(0);
  });

  test("uses liteservers while they can serve the range", async () => {
    const s = setup({ history: {} });
    const page = await s.fetcher.fetch(s.walk());
    expect(page.length).toBe(16);
    expect(s.history!.calls.getTransactions).toBe(0);
  });

  test("other liteserver errors are not sent to the plug-in", async () => {
    const s = setup({ history: {}, faults: { rateLimit: 1 } });
    const error = await s.fetcher.fetch(s.walk()).catch((e) => e);
    expect(error.message).toContain("too many requests");
    expect(s.history!.calls.getTransactions).toBe(0);
  });

  test("a failing plug-in rethrows the original archive miss and counts its own error", async () => {
    const s = setup({ history: { fail: true } });
    s.source.faults = { archiveFloorLt: ARCHIVE_MISS(s) };
    const error = await s.fetcher.fetch(s.walk(10)).catch((e) => e);
    expect(error.message).toContain("cannot locate transaction");
    expect(s.metrics.get("ton_watch_errors_total", { kind: "network", where: "history" })).toBe(1);
    expect(s.historyPages("fallback")).toBe(0);
  });

  test("a corrupt plug-in page is rejected, never returned", async () => {
    const s = setup({ history: { corrupt: true } });
    s.source.faults = { archiveFloorLt: ARCHIVE_MISS(s) };
    const error = await s.fetcher.fetch(s.walk(30)).catch((e) => e);
    expect(error.message).toContain("cannot locate transaction");
    expect(
      s.metrics.get("ton_watch_errors_total", { kind: "bad_response", where: "history" }),
    ).toBe(1);
  });
});

describe("PageFetcher boost mode", () => {
  test("prefers the plug-in, without touching liteservers", async () => {
    const s = setup({ history: {}, mode: "boost" });
    const page = await s.fetcher.fetch(s.walk());
    expect(page.length).toBe(50);
    expect(s.source.calls.getTransactions).toBeUndefined();
    expect(s.historyPages("boost")).toBe(1);
  });

  test("uses liteservers while the plug-in is busy", async () => {
    const s = setup({ history: { busy: true }, mode: "boost" });
    const page = await s.fetcher.fetch(s.walk());
    expect(page.length).toBe(16);
    expect(s.history!.calls.getTransactions).toBe(0);
  });

  test("falls back to liteservers when the plug-in fails or serves a bad page", async () => {
    for (const fault of [{ fail: true }, { corrupt: true }]) {
      const s = setup({ history: fault, mode: "boost" });
      const page = await s.fetcher.fetch(s.walk());
      expect(page.length).toBe(16);
      expect(s.history!.calls.getTransactions).toBe(1);
      expect(s.metrics.sum("ton_watch_errors_total")).toBe(1);
    }
  });

  test("a range neither side has fails with the liteserver error", async () => {
    const s = setup({ history: { fail: true }, mode: "boost" });
    s.source.faults = { archiveFloorLt: ARCHIVE_MISS(s) };
    const error = await s.fetcher.fetch(s.walk(10)).catch((e) => e);
    expect(error.message).toContain("cannot locate transaction");
    expect(s.history!.calls.getTransactions).toBe(2); // boost attempt + fallback attempt
  });
});
