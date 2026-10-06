import { describe, expect, test } from "bun:test";

import { beginCell, Cell, loadTransaction, storeTransaction } from "@ton/core";

import { validatePage } from "../../src/core/chain";
import { classifyError, type ErrorKind, SourceError } from "../../src/core/errors";
import { ToncenterHistory, type ToncenterHistoryOptions } from "../../src/plugins/toncenter";
import fixture from "../fixtures/toncenter-v2-getTransactions.json";

const ADDRESS = "EQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GEMS";
const RAW = "0:584ee61b2dff0837116d0fcb5078d93964bcbe9c05fd6a141b1bfca5d6a43e18";
const first = fixture.result[0]!.transaction_id;
const from = { lt: BigInt(first.lt), hash: Buffer.from(first.hash, "base64") };

/** A canned HTTP answer: JSON-encoded unless `text` is given. */
type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
type Seen = { url: URL; headers: Record<string, string>; at: number };

/** Fake fetch: replies in order; `"hang"` never answers but honors the abort signal. */
function mockFetch(replies: (Reply | "hang" | Error)[]) {
  const seen: Seen[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    seen.push({
      url: new URL(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      at: Date.now(),
    });
    const r = replies.shift() ?? { status: 599, body: { ok: false, error: "no more replies" } };
    if (r === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }
    if (r instanceof Error) throw r;
    const text = r.text ?? JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function history(impl: typeof fetch, options: Partial<ToncenterHistoryOptions> = {}) {
  return new ToncenterHistory({ fetch: impl, rps: 1000, retries: 0, ...options });
}

async function failure(h: ToncenterHistory, count = 5): Promise<SourceError> {
  const error = await h.getTransactions(ADDRESS, from, count).then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
  return error as SourceError;
}

const withData = (data: unknown[]) => ({
  ok: true,
  result: data.map((d, i) => ({ ...fixture.result[i % fixture.result.length]!, data: d })),
});

describe("toncenter: malformed and hostile bodies", () => {
  test.each<[string, Reply, ErrorKind, RegExp]>([
    [
      "HTML error page with 200",
      { text: "<html><body>Bad Gateway</body></html>" },
      "unknown",
      /^toncenter 200: <html>/,
    ],
    [
      "HTML error page with 502",
      { status: 502, text: "<html>502 Bad Gateway</html>" },
      "network",
      /^toncenter 502: <html>/,
    ],
    [
      "truncated JSON",
      { text: '{"ok":true,"result":[{"data":"te6' },
      "unknown",
      /^toncenter 200: \{"ok":true/,
    ],
    ["empty body", { text: "" }, "unknown", /^toncenter 200: $/],
    [
      "ok:false with 200",
      { body: { ok: false, error: "Incorrect address" } },
      "unknown",
      /^toncenter 200: Incorrect address$/,
    ],
    [
      "ok:false, lt not in db",
      { body: { ok: false, error: "LITE_SERVER_UNKNOWN: lt not in db" } },
      "archive_unavailable",
      /lt not in db/,
    ],
    [
      "401 bad api key",
      { status: 401, body: { ok: false, error: "API key does not exist" } },
      "unknown",
      /^toncenter 401: API key/,
    ],
    [
      "416 with cannot locate",
      { status: 416, body: { ok: false, error: "cannot locate transaction" } },
      "archive_unavailable",
      /^toncenter 416/,
    ],
    [
      "504 with lt not in db",
      { status: 504, body: { ok: false, error: "lt not in db" } },
      "archive_unavailable",
      /^toncenter 504/,
    ],
    [
      "ok:false, error only in result",
      { status: 400, body: { ok: false, result: "bad request" } },
      "unknown",
      /^toncenter 400: bad request$/,
    ],
    ["JSON array body", { text: "[]" }, "unknown", /^toncenter 200: \[\]$/],
    [
      "result is an object",
      { body: { ok: true, result: { transactions: [] } } },
      "bad_response",
      /not a list/,
    ],
    ["result is a string", { body: { ok: true, result: "[]" } }, "bad_response", /not a list/],
    ["result missing", { body: { ok: true } }, "bad_response", /not a list/],
    ["result null", { body: { ok: true, result: null } }, "bad_response", /not a list/],
    [
      "empty result",
      { body: { ok: true, result: [] } },
      "archive_unavailable",
      /no transaction at lt/,
    ],
  ])(
    "%s",
    async (_, reply, kind, message) => {
      const { impl, seen } = mockFetch([reply, reply]);
      const error = await failure(history(impl, { retries: 1 }));
      expect(error).toBeInstanceOf(SourceError);
      expect(error.kind).toBe(kind);
      expect(error.message).toMatch(message);
      // Only rate limits and transport errors are retried.
      expect(seen.length).toBe(kind === "network" ? 2 : 1);
    },
    10_000,
  );

  test("non-JSON error bodies are cut to 200 characters in the message", async () => {
    const { impl } = mockFetch([{ text: `<html>${"x".repeat(5000)}` }]);
    const error = await failure(history(impl));
    expect(error.message).toBe(`toncenter 200: <html>${"x".repeat(194)}`);
  });

  test.each<[string, unknown[]]>([
    ["base64 garbage", ["!!!not base64 <html>"]],
    ["empty data", [""]],
    ["valid base64, not a BOC", [Buffer.from("hello world").toString("base64")]],
    [
      "BOC of a non-transaction cell",
      [beginCell().storeUint(1, 8).endCell().toBoc().toString("base64")],
    ],
    ["data is a number", [123]],
    ["data is null", [null]],
    ["data is an object", [{ boc: fixture.result[0]!.data }]],
    ["good first tx, garbage second", [fixture.result[0]!.data, "AAAA"]],
  ])("rejects a page with %s and does not retry it", async (_, data) => {
    const { impl, seen } = mockFetch([{ body: withData(data) }]);
    const h = history(impl, { retries: 3 });
    await expect(h.getTransactions(ADDRESS, from, 5)).rejects.toThrow();
    expect(seen.length).toBe(1);
  });

  test("an entry without data is rejected", async () => {
    const { impl } = mockFetch([{ body: { ok: true, result: [{ transaction_id: first }] } }]);
    await expect(history(impl).getTransactions(ADDRESS, from, 5)).rejects.toThrow();
  });

  // BUG: a 200 response whose body is the JSON literal `null` crashes on `body.ok`
  // (src/plugins/toncenter/toncenter-history.ts, fetchOnce: `if (response.ok && body.ok)`).
  // The TypeError is then treated as a transport failure: classified "network" and
  // retried with backoff, instead of a non-retried bad/unknown response.
  test.failing("a `null` JSON body is a bad response, not a retried network error", async () => {
    const { impl, seen } = mockFetch([{ text: "null" }, { text: "null" }]);
    const error = await failure(history(impl, { retries: 1 }));
    expect(error.kind).not.toBe("network");
    expect(seen.length).toBe(1);
  }, 10_000);
});

describe("toncenter: lying but well-formed pages", () => {
  const data = fixture.result.map((t) => t.data);

  test("claimed transaction ids are ignored; hashes come from the BOC", async () => {
    const lying = {
      ok: true,
      result: fixture.result.map((t) => ({
        ...t,
        transaction_id: { lt: "1", hash: Buffer.alloc(32, 9).toString("base64") },
      })),
    };
    const { impl } = mockFetch([{ body: lying }]);
    const page = await history(impl).getTransactions(ADDRESS, from, 5);
    expect(page.map((t) => t.hash.toString("base64"))).toEqual(
      fixture.result.map((t) => t.transaction_id.hash),
    );
    expect(() => validatePage(from, page)).not.toThrow();
  });

  test("records always carry the requested raw address", async () => {
    const { impl } = mockFetch([{ body: fixture }]);
    const page = await history(impl).getTransactions(ADDRESS, from, 5);
    expect(page.map((t) => t.address)).toEqual(Array(5).fill(RAW));
  });

  test.each<[string, string[]]>([
    ["reversed", [...data].reverse()],
    ["one skipped", [data[0]!, ...data.slice(2)]],
    ["duplicated", [data[0]!, ...data]],
    ["starts one older", data.slice(1)],
    ["swapped pair", [data[0]!, data[2]!, data[1]!, ...data.slice(3)]],
  ])("%s page parses but fails the chain check", async (_, order) => {
    const { impl } = mockFetch([{ body: withData(order) }]);
    const page = await history(impl).getTransactions(ADDRESS, from, 5);
    expect(() => validatePage(from, page)).toThrow(SourceError);
  });

  test("a tampered BOC re-hashes to something else and fails the chain check", async () => {
    const cell = Cell.fromBoc(Buffer.from(data[0]!, "base64"))[0]!;
    const tx = loadTransaction(cell.beginParse());
    tx.now += 1;
    const forged = beginCell().store(storeTransaction(tx)).endCell().toBoc().toString("base64");
    const { impl } = mockFetch([{ body: withData([forged, ...data.slice(1)]) }]);
    const page = await history(impl).getTransactions(ADDRESS, from, 5);
    expect(page[0]!.hash.equals(from.hash)).toBe(false);
    expect(page[0]!.lt).toBe(from.lt);
    expect(() => validatePage(from, page)).toThrow(/page starts at/);
  });
});

describe("toncenter: transport failures", () => {
  test("a request that never answers times out", async () => {
    const { impl, seen } = mockFetch(["hang"]);
    const started = Date.now();
    const error = await failure(history(impl, { timeoutMs: 30 }));
    expect(error.kind).toBe("timeout");
    expect(classifyError(error)).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(seen.length).toBe(1);
  });

  test("timeouts are retried, then the last error is thrown", async () => {
    const { impl, seen } = mockFetch(["hang", "hang"]);
    const error = await failure(history(impl, { timeoutMs: 20, retries: 1 }));
    expect(error.kind).toBe("timeout");
    expect(seen.length).toBe(2);
  }, 10_000);

  test("a timeout followed by a good answer succeeds", async () => {
    const { impl, seen } = mockFetch(["hang", { body: fixture }]);
    const page = await history(impl, { timeoutMs: 20, retries: 1 }).getTransactions(
      ADDRESS,
      from,
      5,
    );
    expect(page.length).toBe(5);
    expect(seen.length).toBe(2);
  }, 10_000);

  test("a rejected fetch is a network error, keeping the cause", async () => {
    const cause = new TypeError("fetch failed");
    const { impl } = mockFetch([cause]);
    const error = await failure(history(impl));
    expect(error.kind).toBe("network");
    expect(error.message).toBe("fetch failed");
    expect(error.cause).toBe(cause);
  });

  test("an AbortError is a timeout", async () => {
    const { impl } = mockFetch([new DOMException("The operation was aborted.", "AbortError")]);
    expect((await failure(history(impl))).kind).toBe("timeout");
  });

  test("a 5xx storm gives up after `retries` with the last error", async () => {
    const { impl, seen } = mockFetch([
      { status: 502, body: { ok: false, error: "bad gateway" } },
      { status: 503, text: "Service Unavailable" },
    ]);
    const error = await failure(history(impl, { retries: 1 }));
    expect(error.kind).toBe("network");
    expect(error.message).toBe("toncenter 503: Service Unavailable");
    expect(seen.length).toBe(2);
    // Exponential backoff: the retry waits the 1s minimum.
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(990);
  }, 10_000);

  test("429 is retried with backoff whether or not Retry-After is sent", async () => {
    const { impl, seen } = mockFetch([
      {
        status: 429,
        headers: { "Retry-After": "0" },
        body: { ok: false, error: "Ratelimit exceed" },
      },
      { body: fixture },
    ]);
    const page = await history(impl, { retries: 1 }).getTransactions(ADDRESS, from, 5);
    expect(page.length).toBe(5);
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(990);
  }, 10_000);

  test("429 without retries left is a rate_limit error", async () => {
    const { impl } = mockFetch([{ status: 429, text: "Too Many Requests" }]);
    const error = await failure(history(impl));
    expect(error.kind).toBe("rate_limit");
    expect(error.message).toBe("toncenter 429: Too Many Requests");
  });

  test("a rate-limit answer makes the plug-in busy so boost mode yields to liteservers", async () => {
    const { impl } = mockFetch([{ status: 429, body: { ok: false, error: "Ratelimit exceed" } }]);
    const h = history(impl);
    expect(h.busy()).toBe(false);
    await failure(h);
    expect(h.busy()).toBe(true);
  });
});

describe("toncenter: request building", () => {
  test("query string, raw address, limit and no key header", async () => {
    const { impl, seen } = mockFetch([{ body: fixture }]);
    await new ToncenterHistory({ fetch: impl, rps: 1000 }).getTransactions(ADDRESS, from, 7);
    const { url, headers } = seen[0]!;
    expect(url.origin + url.pathname).toBe("https://toncenter.com/api/v2/getTransactions");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      address: RAW,
      lt: from.lt.toString(),
      hash: from.hash.toString("hex"),
      limit: "7",
      archival: "true",
    });
    expect(headers).toEqual({});
  });

  test("a custom endpoint with a trailing slash and an API key", async () => {
    const { impl, seen } = mockFetch([{ body: fixture }]);
    const h = new ToncenterHistory({
      fetch: impl,
      rps: 1000,
      apiKey: "secret&key=1",
      endpoint: "https://testnet.toncenter.com/api/v2/",
    });
    await h.getTransactions(ADDRESS, from, 5);
    expect(
      seen[0]!.url.href.startsWith("https://testnet.toncenter.com/api/v2/getTransactions?"),
    ).toBe(true);
    expect(seen[0]!.headers).toEqual({ "X-API-Key": "secret&key=1" });
    // The key travels in a header only, never in the URL.
    expect(seen[0]!.url.href).not.toContain("secret");
  });

  test.each([
    [{}, 2000, "256"],
    [{ pageSize: 50 }, 2000, "50"],
    [{ pageSize: 50 }, 3, "3"],
    [{ pageSize: 1000 }, 5000, "1000"],
    [{ pageSize: 1001 }, 5000, "1000"],
  ])("pageSize %p, count %p -> limit %p", async (options, count, limit) => {
    const { impl, seen } = mockFetch([{ body: fixture }]);
    await history(impl, options).getTransactions(ADDRESS, from, count);
    expect(seen[0]!.url.searchParams.get("limit")).toBe(limit);
  });

  test("a friendly testnet or raw uppercase address is sent raw", async () => {
    const { impl, seen } = mockFetch([{ body: fixture }, { body: fixture }]);
    const h = history(impl);
    await h.getTransactions("kQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GPiY", from, 5);
    await h.getTransactions(RAW.toUpperCase(), from, 5);
    expect(seen.map((s) => s.url.searchParams.get("address"))).toEqual([RAW, RAW]);
  });

  test("an invalid address throws before any request", async () => {
    const { impl, seen } = mockFetch([]);
    await expect(history(impl).getTransactions("not-an-address", from, 5)).rejects.toThrow();
    expect(seen.length).toBe(0);
  });

  test("a hash with leading zero bytes keeps them in hex", async () => {
    const { impl, seen } = mockFetch([{ body: { ok: true, result: [] } }]);
    const hash = Buffer.concat([Buffer.alloc(3), Buffer.alloc(29, 0xab)]);
    await history(impl)
      .getTransactions(ADDRESS, { lt: 1n << 63n, hash }, 5)
      .catch(() => {});
    const last = seen.at(-1)!.url.searchParams;
    expect(last.get("hash")).toBe(`000000${"ab".repeat(29)}`);
    expect(last.get("lt")).toBe("9223372036854775808");
  });
});

describe("toncenter: rate limiter", () => {
  test("default 10 req/s with a key: concurrent requests are spaced 100ms apart", async () => {
    const { impl, seen } = mockFetch([{ body: fixture }, { body: fixture }, { body: fixture }]);
    const h = new ToncenterHistory({ fetch: impl, apiKey: "k" });
    // Measured from the call: the limiter delays slots, it does not guarantee gaps
    // between when two delayed callbacks happen to run.
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => h.getTransactions(ADDRESS, from, 5)));
    expect(seen[1]!.at - t0).toBeGreaterThanOrEqual(99);
    expect(seen[2]!.at - t0).toBeGreaterThanOrEqual(199);
  });

  test("a failed request still consumes its slot", async () => {
    const { impl, seen } = mockFetch([
      { status: 400, body: { ok: false, error: "x" } },
      { body: fixture },
    ]);
    const h = new ToncenterHistory({ fetch: impl, rps: 20, retries: 0 });
    const t0 = Date.now();
    await Promise.all([
      h.getTransactions(ADDRESS, from, 5).catch(() => null),
      h.getTransactions(ADDRESS, from, 5),
    ]);
    expect(seen[1]!.at - t0).toBeGreaterThanOrEqual(49);
  });
});
