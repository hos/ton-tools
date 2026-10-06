/**
 * Webhook delivery end to end: the CLI in-process (PGlite, `FakeSource`) posting
 * to a real HTTP receiver on an ephemeral port.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Address } from "@ton/core";
import type { Server } from "bun";

import { ConsumerLockedError } from "../../../src/consumer/errors";
import type { TxRecord } from "../../../src/core/types";
import { main } from "../../../src/service/cli";
import { verifySignature } from "../../../src/service/webhook/signature";
import { PgStore } from "../../../src/stores/pg/pg-store";
import { TonWatch } from "../../../src/ton-watch";
import { silentLogger } from "../../../src/util/logger";
import type { WebhookPayload } from "../../../src/webhook";
import { FakeSource, fakeAddress } from "../../fixtures/fake-chain";
import { type ServiceHarness, setupService, until } from "../harness";

const A = fakeAddress(1);
const B = fakeAddress(2);
const SECRET = "whsec_test";

interface Received {
  path: string;
  id: string;
  idempotencyKey: string | null;
  payload: WebhookPayload;
  signed: boolean;
  /** The `TON-Watch-Replay` header. */
  replayHeader: string | null;
  /** Status the receiver answered. */
  status: number;
}

type Respond = (request: Received, attempt: number) => number | Promise<number>;

/** A real HTTP server recording every request; `respond` picks the status. */
function startReceiver(respond: Respond = () => 204) {
  const requests: Received[] = [];
  const server: Server<undefined> = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const payload = JSON.parse(body) as WebhookPayload;
      const received: Received = {
        path: new URL(request.url).pathname,
        id: payload.id,
        idempotencyKey: request.headers.get("idempotency-key"),
        payload,
        signed: verifySignature(SECRET, body, request.headers.get("ton-watch-signature")),
        replayHeader: request.headers.get("ton-watch-replay"),
        status: 0,
      };
      const attempt = requests.filter((r) => r.id === received.id && r.path === received.path);
      received.status = await respond(received, attempt.length + 1);
      requests.push(received);
      return new Response(null, { status: received.status });
    },
  });
  const accepted = (path?: string) =>
    requests.filter((r) => r.status < 300 && (path === undefined || r.path === path));
  return { url: `http://127.0.0.1:${server.port}`, requests, accepted, server };
}

let h: ServiceHarness;
let receiver: ReturnType<typeof startReceiver> | undefined;
/** A `run` or `deliver` is running and must be stopped before the database closes. */
let running = false;

beforeEach(async () => {
  h = await setupService();
});

afterEach(async () => {
  if (running) await stopService();
  await receiver?.server.stop(true);
  receiver = undefined;
  await h.teardown();
});

const env = (extra: Record<string, string> = {}) => ({
  TON_WATCH_DATABASE_URL: "postgres://test/db",
  TON_WATCH_LOG: "silent",
  TON_WATCH_PORT: "0",
  TON_WATCH_WEBHOOK_SECRET: SECRET,
  TON_WATCH_WEBHOOK_RETRY_MIN_MS: "10",
  TON_WATCH_WEBHOOK_RETRY_MAX_MS: "20",
  ...extra,
});

/**
 * Indexes `addresses` from the earliest transaction, as a separate indexer process would, until
 * every one is complete up to the newest transaction among them (so global order
 * can release all of them).
 */
async function indexAll(addresses: string[]) {
  const watch = new TonWatch({
    store: new PgStore(h.fakePool as never),
    source: new FakeSource(h.chain),
    tickMs: 10,
    maxIdlePollMs: 0,
    logger: silentLogger,
  });
  for (const address of addresses) await watch.addAddress(address, { from: "earliest" });
  await watch.start();
  const newest = addresses
    .map((address) => h.chain.txs(address).at(-1)?.lt ?? 0n)
    .reduce((max, lt) => (lt > max ? lt : max));
  await until(async () => ((await watch.watermark(addresses)) ?? -1n) >= newest);
  await watch.stop();
}

const idOf = (tx: TxRecord) => `${tx.address}:${tx.lt}:${tx.hash.toString("hex")}`;
const idsOf = (address: string) => h.chain.txs(address).map(idOf);
async function startService(command: "run" | "deliver", serviceEnv: Record<string, string>) {
  await main([command], serviceEnv);
  running = true;
}

async function stopService() {
  h.exitSpy.mockClear();
  process.emit("SIGTERM");
  await until(() => h.exitSpy.mock.calls.length > 0);
  running = false;
  expect(h.exitSpy.mock.calls).toEqual([[0]]);
}

describe("ton-watch run with a webhook", () => {
  test("delivers every transaction in order, signed, exactly once across a restart", async () => {
    h.chain.grow([A], 6);
    receiver = startReceiver();
    const runEnv = env({
      TON_WATCH_ADDRESSES: `${A}@earliest`,
      TON_WATCH_WEBHOOK_URL: `${receiver.url}/hook`,
    });
    await startService("run", runEnv);
    await until(() => receiver!.accepted().length === 6);
    await stopService();

    h.chain.grow([A], 4);
    await startService("run", runEnv);
    await until(() => receiver!.accepted().length === 10);
    await new Promise((resolve) => setTimeout(resolve, 100)); // nothing more arrives

    const requests = receiver.requests;
    expect(requests.map((r) => r.id)).toEqual(idsOf(A));
    expect(requests.every((r) => r.signed && r.idempotencyKey === r.id && r.path === "/hook")).toBe(
      true,
    );
    const [first, second] = requests;
    expect(first!.payload).toMatchObject({
      version: 1,
      type: "transaction",
      webhook: "default",
      address: A,
      prev: null,
    });
    expect(second!.payload.prev?.lt).toBe(first!.payload.lt);
  });
});

describe("ton-watch deliver", () => {
  test("needs a webhook and fails before connecting", async () => {
    await expect(main(["deliver"], env())).rejects.toThrow(
      "deliver needs TON_WATCH_WEBHOOK_URL or TON_WATCH_WEBHOOKS",
    );
    expect(h.poolSpy).not.toHaveBeenCalled();
  });

  test("retries 5xx and timeouts until accepted; nothing is skipped or reordered", async () => {
    h.chain.grow([A], 5);
    await indexAll([A]);
    const [, second, third] = idsOf(A);
    receiver = startReceiver(async (request, attempt) => {
      if (request.id === second && attempt <= 2) return 500;
      if (request.id === third && attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 300)); // past the timeout
        return 503;
      }
      return 200;
    });
    await startService(
      "deliver",
      env({ TON_WATCH_WEBHOOK_URL: receiver.url, TON_WATCH_WEBHOOK_TIMEOUT_MS: "100" }),
    );
    await until(() => receiver!.accepted().length === 5);

    expect(h.connectSpy).not.toHaveBeenCalled();
    expect(receiver.accepted().map((r) => r.id)).toEqual(idsOf(A));
    expect(receiver.requests.filter((r) => r.id === second).map((r) => r.status)).toEqual([
      500, 500, 200,
    ]);
    // The timed-out attempt reached the receiver too: at-least-once over HTTP.
    expect(receiver.requests.filter((r) => r.id === third).length).toBe(2);
  });

  test("a 4xx halts only that address at that transaction until the receiver accepts it", async () => {
    h.chain.grow([A, B], 4);
    await indexAll([A, B]);
    const rejected = idsOf(A)[1];
    let rejecting = true;
    receiver = startReceiver((request) => (rejecting && request.id === rejected ? 422 : 204));
    const port = await freePort();
    await startService(
      "deliver",
      env({ TON_WATCH_WEBHOOK_URL: receiver.url, TON_WATCH_PORT: String(port) }),
    );
    await until(
      () =>
        receiver!.accepted().filter((r) => r.payload.address === B).length === 4 &&
        receiver!.requests.filter((r) => r.id === rejected).length >= 3,
    );
    const acceptedA = () =>
      receiver!
        .accepted()
        .filter((r) => r.payload.address === A)
        .map((r) => r.id);
    expect(acceptedA()).toEqual(idsOf(A).slice(0, 1));

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.status).toBe("degraded");
    expect(health.reasons.join()).toContain("webhook:default: retrying");
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    const laneA = status.webhooks[0].addresses.find(
      (lane: { address: string }) => lane.address === A,
    );
    expect(laneA.lastError).toContain("HTTP 422");

    rejecting = false;
    await until(() => acceptedA().length === 4);
    expect(acceptedA()).toEqual(idsOf(A));
  });

  test("several targets: address filter, global order, per-target secrets", async () => {
    h.chain.grow([A, B], 5);
    await indexAll([A, B]);
    receiver = startReceiver();
    await startService(
      "deliver",
      env({
        TON_WATCH_WEBHOOKS: JSON.stringify([
          { name: "only-a", url: `${receiver.url}/a`, addresses: [Address.parse(A).toString()] },
          { name: "all", url: `${receiver.url}/all`, order: "global" },
          { name: "unsigned", url: `${receiver.url}/other`, secret: "different", addresses: [B] },
        ]),
      }),
    );
    await until(
      () =>
        receiver!.accepted("/a").length === 5 &&
        receiver!.accepted("/all").length === 10 &&
        receiver!.accepted("/other").length === 5,
    );

    expect(receiver.accepted("/a").map((r) => r.id)).toEqual(idsOf(A));
    const global = receiver.accepted("/all").map((r) => r.payload);
    const sorted = [...global].sort(
      (x, y) => Number(BigInt(x.lt) - BigInt(y.lt)) || x.address.localeCompare(y.address),
    );
    expect(global).toEqual(sorted);
    expect(new Set(global.map((p) => p.webhook))).toEqual(new Set(["all"]));
    expect(receiver.accepted("/other").every((r) => !r.signed && r.payload.address === B)).toBe(
      true,
    );
    expect(receiver.accepted("/a").every((r) => r.signed)).toBe(true);
  });

  test("from now: skips what is indexed, then delivers what the indexer writes later", async () => {
    h.chain.grow([A], 3);
    await indexAll([A]);
    receiver = startReceiver();
    await startService(
      "deliver",
      env({ TON_WATCH_WEBHOOK_URL: receiver.url, TON_WATCH_WEBHOOK_FROM: "now" }),
    );
    await until(async () => {
      const cursors = await h.db.query("select 1 from ton_watch.cursors where consumer = $1", [
        "webhook:default",
      ]);
      return cursors.rows.length === 1;
    });

    h.chain.grow([A], 2);
    await indexAll([A]);
    await until(() => receiver!.accepted().length === 2);
    expect(receiver.accepted().map((r) => r.id)).toEqual(idsOf(A).slice(3));
  });
});

describe("webhook failure policy", () => {
  test("dead-letter: a 4xx at once, a 5xx after maxAttempts; replay re-sends it flagged", async () => {
    h.chain.grow([A], 6);
    await indexAll([A]);
    const ids = idsOf(A);
    const [rejectedId, failingId] = [ids[1]!, ids[3]!];
    let healed = false;
    receiver = startReceiver((request) => {
      if (healed) return 204;
      if (request.id === rejectedId) return 422;
      if (request.id === failingId) return 503;
      return 204;
    });
    const port = await freePort();
    const deliverEnv = env({
      TON_WATCH_WEBHOOK_URL: receiver.url,
      TON_WATCH_WEBHOOK_ON_ERROR: "dead-letter",
      TON_WATCH_WEBHOOK_MAX_ATTEMPTS: "3",
      TON_WATCH_PORT: String(port),
    });
    await startService("deliver", deliverEnv);
    await until(() => receiver!.accepted().length === 4);

    const attempts = (id?: string) => receiver!.requests.filter((r) => r.id === id).length;
    expect(attempts(rejectedId)).toBe(1);
    expect(attempts(failingId)).toBe(3);
    expect(receiver.accepted().map((r) => r.id)).toEqual(
      ids.filter((id) => id !== rejectedId && id !== failingId),
    );
    expect(receiver.requests.every((r) => r.payload.replay === false && !r.replayHeader)).toBe(
      true,
    );
    const store = new PgStore(h.fakePool as never);
    const letters = await store.listDeadLetters({ consumer: "webhook:default" });
    expect(letters.map((l) => [l.lt, l.attempts])).toEqual([
      [h.chain.txs(A)[1]!.lt, 1],
      [h.chain.txs(A)[3]!.lt, 3],
    ]);
    expect(letters[0]!.error).toContain("HTTP 422");

    const consumers = await (await fetch(`http://127.0.0.1:${port}/consumers`)).json();
    expect(consumers).toMatchObject({
      version: 1,
      consumers: [{ name: "webhook:default", deadLetters: 2, lag: { transactions: 0 } }],
    });
    await stopService();

    healed = true;
    receiver.requests.length = 0;
    const lt = h.chain.txs(A)[1]!.lt;
    await main(["replay", "webhook:default", A, String(lt)], deliverEnv);
    expect(
      receiver.requests.map((r) => [r.id, r.payload.replay, r.replayHeader, r.signed]),
    ).toEqual([[rejectedId, true, "1", true]]);
    expect((await store.listDeadLetters()).map((l) => l.lt)).toEqual([h.chain.txs(A)[3]!.lt]);
  });

  test("skip, per target: moves past without a dead letter", async () => {
    h.chain.grow([A], 4);
    await indexAll([A]);
    const rejected = idsOf(A)[2];
    receiver = startReceiver((request) => (request.id === rejected ? 400 : 204));
    await startService(
      "deliver",
      env({
        TON_WATCH_WEBHOOKS: JSON.stringify([
          { name: "lenient", url: receiver.url, onError: "skip", maxAttempts: 2 },
        ]),
      }),
    );
    await until(() => receiver!.accepted().length === 3);
    expect(receiver.requests.filter((r) => r.id === rejected).length).toBe(1);
    expect(await new PgStore(h.fakePool as never).listDeadLetters()).toEqual([]);
  });
});

describe("ton-watch deliver and the consumer lock", () => {
  test("fails with ConsumerLockedError when a target runs elsewhere, releasing the others", async () => {
    h.chain.grow([A], 3);
    await indexAll([A]);
    receiver = startReceiver();
    const store = new PgStore(h.fakePool as never);
    const elsewhere = await store.lockConsumer("webhook:b");
    expect(elsewhere).not.toBeNull();

    const error = await main(
      ["deliver"],
      env({
        TON_WATCH_WEBHOOKS: JSON.stringify([
          { name: "a", url: `${receiver.url}/a` },
          { name: "b", url: `${receiver.url}/b` },
        ]),
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConsumerLockedError);
    expect((error as ConsumerLockedError).consumer).toBe("webhook:b");
    expect(h.exitSpy).not.toHaveBeenCalled();
    expect(receiver.accepted("/b")).toEqual([]);

    // "a" was stopped and its lock released.
    const lockA = await store.lockConsumer("webhook:a");
    expect(lockA).not.toBeNull();
    await lockA?.release();
    await elsewhere?.release();
  });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const { port } = probe;
    probe.stop(true);
    resolve(port);
  });
