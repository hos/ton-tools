import { describe, expect, test } from "bun:test";

import type { HandlerContext } from "../../../src/consumer/types";
import { toIndexedTx } from "../../../src/core/types";
import type { WebhookTarget } from "../../../src/service/webhook/config";
import {
  isRetryableStatus,
  WebhookError,
  webhookHandler,
} from "../../../src/service/webhook/sender";
import { VERSION } from "../../../src/version";
import { verifySignature } from "../../../src/webhook";
import { FakeChain, fakeAddress } from "../../fixtures/fake-chain";

const A = fakeAddress(1);
const ctx: HandlerContext = { consumer: "webhook:t", address: A, replay: false };

const target = (overrides: Partial<WebhookTarget> = {}): WebhookTarget => ({
  name: "t",
  url: "http://receiver.test/hook",
  secrets: ["s"],
  addresses: null,
  order: "address",
  from: "earliest",
  timeoutMs: 1_000,
  retryMinMs: 1,
  retryMaxMs: 1,
  onError: "retry",
  maxAttempts: 5,
  ...overrides,
});

function tx() {
  const chain = new FakeChain();
  chain.grow([A], 1);
  return toIndexedTx(chain.txs(A)[0]!);
}

/** A handler whose fetch answers with `respond` and records each request. */
function handlerWith(respond: () => Response | Promise<Response>, overrides = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  const handler = webhookHandler(target(overrides), { fetch: fakeFetch });
  const send = (context: HandlerContext = ctx) => handler(tx(), context);
  return { requests, send };
}

const failure = async (promise: Promise<unknown> | unknown) => {
  try {
    await promise;
  } catch (error) {
    return error as WebhookError;
  }
  throw new Error("expected a failure");
};

describe("webhookHandler", () => {
  test("POSTs signed JSON with an idempotency key; 2xx resolves", async () => {
    const { requests, send } = handlerWith(() => new Response(null, { status: 204 }));
    await send();
    const [{ url, init }] = requests as [(typeof requests)[0]];
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    expect(url).toBe("http://receiver.test/hook");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["idempotency-key"]).toBe(JSON.parse(body).id);
    expect(headers["ton-watch-event"]).toBe("transaction");
    expect(headers["user-agent"]).toBe(`ton-watch/${VERSION}`);
    expect(verifySignature("s", body, headers["ton-watch-signature"])).toBe(true);
  });

  test("signs with every secret while rotating", async () => {
    const { requests, send } = handlerWith(() => new Response("ok"), { secrets: ["new", "old"] });
    await send();
    const headers = requests[0]!.init.headers as Record<string, string>;
    const body = String(requests[0]!.init.body);
    expect(headers["ton-watch-signature"]!.match(/v1=/g)).toHaveLength(2);
    expect(verifySignature("old", body, headers["ton-watch-signature"])).toBe(true);
    expect(verifySignature("new", body, headers["ton-watch-signature"])).toBe(true);
  });

  test("a replay is flagged in the body and the TON-Watch-Replay header", async () => {
    const { requests, send } = handlerWith(() => new Response(null, { status: 204 }));
    await send();
    await send({ ...ctx, replay: true });
    const [live, replay] = requests.map(({ init }) => ({
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    }));
    expect(live!.body.replay).toBe(false);
    expect(live!.headers).not.toHaveProperty("ton-watch-replay");
    expect(replay!.body.replay).toBe(true);
    expect(replay!.headers["ton-watch-replay"]).toBe("1");
    expect(replay!.headers["idempotency-key"]).toBe(live!.headers["idempotency-key"]);
  });

  test("no secret, no signature header", async () => {
    const { requests, send } = handlerWith(() => new Response("ok"), { secrets: [] });
    await send();
    expect(requests[0]!.init.headers).not.toHaveProperty("ton-watch-signature");
  });

  test.each([
    [500, true],
    [503, true],
    [408, true],
    [429, true],
    [400, false],
    [401, false],
    [404, false],
    [410, false],
    [301, false],
  ])("HTTP %d throws a WebhookError, retryable: %p", async (status, retryable) => {
    const { send } = handlerWith(() => new Response("nope from receiver", { status }));
    const error = await failure(send());
    expect(error).toBeInstanceOf(WebhookError);
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
    expect(error.message).toBe(`webhook t: HTTP ${status} nope from receiver`);
  });

  test("a network error is retryable with no status", async () => {
    const { send } = handlerWith(() => {
      throw new TypeError("fetch failed");
    });
    const error = await failure(send());
    expect(error).toMatchObject({ status: null, retryable: true });
    expect(error.message).toBe("webhook t: fetch failed");
  });

  test("a timeout aborts the request and is retryable", async () => {
    const handler = webhookHandler(target({ timeoutMs: 20 }), {
      fetch: ((_: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        )) as unknown as typeof fetch,
    });
    const error = await failure(handler(tx(), ctx));
    expect(error).toMatchObject({ status: null, retryable: true });
    expect(error.message).toBe("webhook t: timed out after 20ms");
  });

  test("long error bodies are truncated", async () => {
    const { send } = handlerWith(() => new Response("x".repeat(1000), { status: 500 }));
    expect((await failure(send())).message.length).toBeLessThan(250);
  });

  test("isRetryableStatus", () => {
    expect([200, 302, 400, 408, 429, 499, 500, 599].map(isRetryableStatus)).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      true,
      true,
    ]);
  });
});
