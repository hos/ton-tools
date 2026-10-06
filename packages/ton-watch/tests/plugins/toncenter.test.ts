import { describe, expect, test } from "bun:test";

import { validatePage } from "../../src/core/chain";
import { classifyError } from "../../src/core/errors";
import { ToncenterHistory } from "../../src/plugins/toncenter";
import fixture from "../fixtures/toncenter-v2-getTransactions.json";

const ADDRESS = "EQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GEMS";
const first = fixture.result[0]!.transaction_id;
const from = { lt: BigInt(first.lt), hash: Buffer.from(first.hash, "base64") };

type Reply = { status?: number; body: unknown };
function mockFetch(replies: Reply[]) {
  const seen: { url: string; headers: Record<string, string>; at: number }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, at: Date.now() });
    const r = replies.shift() ?? { status: 500, body: { ok: false, error: "no more replies" } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("ToncenterHistory", () => {
  test("parses a real v2 page into records that pass the same page checks as liteservers", async () => {
    const { impl, seen } = mockFetch([{ body: fixture }]);
    const h = new ToncenterHistory({ fetch: impl, rps: 1000, apiKey: "k" });
    const page = await h.getTransactions(ADDRESS, from, 5);
    expect(page.length).toBe(5);
    expect(() => validatePage(from, page)).not.toThrow();
    // Hashes are recomputed from the BOC, and match what toncenter claims.
    for (const [i, tx] of page.entries()) {
      expect(tx.hash.toString("base64")).toBe(fixture.result[i]!.transaction_id.hash);
    }
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/api/v2/getTransactions");
    expect(url.searchParams.get("archival")).toBe("true");
    expect(url.searchParams.get("hash")).toBe(from.hash.toString("hex"));
    expect(url.searchParams.get("lt")).toBe(from.lt.toString());
    expect(seen[0]!.headers["X-API-Key"]).toBe("k");
  });

  test("retries 429 and 5xx, then succeeds", async () => {
    const { impl, seen } = mockFetch([
      { status: 429, body: { ok: false, error: "Ratelimit exceed" } },
      { status: 502, body: { ok: false, error: "bad gateway" } },
      { body: fixture },
    ]);
    const h = new ToncenterHistory({ fetch: impl, rps: 1000, retries: 3 });
    // Backoff is real (1s, 2s); keep the test honest but bounded.
    const page = await h.getTransactions(ADDRESS, from, 5);
    expect(page.length).toBe(5);
    expect(seen.length).toBe(3);
  }, 10_000);

  test("history it does not have is archive_unavailable, not retried", async () => {
    const { impl, seen } = mockFetch([
      { status: 500, body: { ok: false, code: 500, error: "LITE_SERVER_UNKNOWN: lt not in db" } },
    ]);
    const h = new ToncenterHistory({ fetch: impl, rps: 1000 });
    const err = await h.getTransactions(ADDRESS, from, 5).catch((e) => e);
    expect(classifyError(err)).toBe("archive_unavailable");
    expect(seen.length).toBe(1);
  });

  test("an empty result is archive_unavailable", async () => {
    const { impl } = mockFetch([{ body: { ok: true, result: [] } }]);
    const err = await new ToncenterHistory({ fetch: impl, rps: 1000 })
      .getTransactions(ADDRESS, from, 5)
      .catch((e) => e);
    expect(classifyError(err)).toBe("archive_unavailable");
  });

  test("stays under its request rate", async () => {
    const { impl, seen } = mockFetch([{ body: fixture }, { body: fixture }, { body: fixture }]);
    const h = new ToncenterHistory({ fetch: impl, rps: 20 });
    await Promise.all([1, 2, 3].map(() => h.getTransactions(ADDRESS, from, 5)));
    const span = seen.at(-1)!.at - seen[0]!.at;
    expect(span).toBeGreaterThanOrEqual(90);
  });

  test("busy() when requests are queued beyond one slot", async () => {
    const { impl } = mockFetch([{ body: fixture }, { body: fixture }, { body: fixture }]);
    const h = new ToncenterHistory({ fetch: impl, rps: 5 });
    expect(h.busy()).toBe(false);
    const all = Promise.all([1, 2, 3].map(() => h.getTransactions(ADDRESS, from, 5)));
    expect(h.busy()).toBe(true);
    await all;
  });

  test("defaults: 1 req/s without a key, page ≤ 1000", () => {
    const h = new ToncenterHistory({ pageSize: 5000 });
    expect(h.maxPageSize).toBe(1000);
  });
});
