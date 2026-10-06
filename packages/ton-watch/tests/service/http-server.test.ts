import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConsumerStatus } from "../../src/consumer/types";
import { Metrics } from "../../src/metrics/metrics";
import { startHttpServer } from "../../src/service/http-server";
import {
  type ConsumersResponse,
  deliverStatusResponse,
  type HealthResponse,
  healthResponse,
  toJson,
} from "../../src/service/output";
import { deliveryProbe, indexerProbe } from "../../src/service/probes";
import type { ServerStats } from "../../src/source/liteserver/server-pool";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { type Health, TonWatch } from "../../src/ton-watch";
import type { Logger } from "../../src/util/logger";
import { silentLogger } from "../../src/util/logger";
import { FakeChain, FakeSource, fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);

const stats: ServerStats[] = [
  {
    id: "1.2.3.4:5",
    archive: false,
    ready: true,
    inFlight: 0,
    latencyMs: 12,
    calls: 3,
    coolingDownMs: 0,
    errors: {},
  },
];

let server: Server | undefined;
let watch: TonWatch | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  await watch?.stop();
  watch = undefined;
});

async function setup(logger: Logger = silentLogger) {
  const chain = new FakeChain();
  chain.grow([A], 5);
  watch = new TonWatch({
    store: new MemoryStore(),
    source: new FakeSource(chain),
    tickMs: 10,
    maxIdlePollMs: 0,
    logger: silentLogger,
  });
  await watch.addAddress(A, { from: "earliest" });
  server = await startHttpServer(
    indexerProbe(watch, () => stats),
    0,
    logger,
  );
  const { port } = server.address() as AddressInfo;
  const get = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  return { watch, get, port };
}

const until = async (cond: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("toJson", () => {
  test("pretty-prints, and refuses a bigint that escaped the output types", () => {
    expect(toJson({ lt: "123", n: 1 })).toBe('{\n  "lt": "123",\n  "n": 1\n}');
    expect(() => toJson({ lt: 1n })).toThrow();
  });
});

/** A probe answering fixed values, for tests of the server alone. */
const staticProbe = (consumers: () => Promise<ConsumersResponse>) => ({
  metrics: () => "",
  health: (): HealthResponse => healthResponse(null, []),
  status: () => deliverStatusResponse([]),
  consumers,
});

describe("startHttpServer", () => {
  test("logs where it listens", async () => {
    const lines: unknown[][] = [];
    const logger: Logger = { ...silentLogger, info: (...args) => void lines.push(args) };
    await setup(logger);
    expect(lines).toEqual([["health on :0/health, metrics on :0/metrics"]]);
  });

  test("/metrics serves the Prometheus text of the watch's metrics", async () => {
    const { watch, get } = await setup();
    watch.metrics.inc("ton_watch_consumer_delivered_total", { consumer: "x" }, 3);
    const response = await get("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4");
    const body = await response.text();
    expect(body).toBe(watch.metrics.toPrometheus());
    expect(body).toContain('ton_watch_consumer_delivered_total{consumer="x"} 3\n');
    expect(body).toContain("# TYPE ton_watch_consumer_delivered_total counter\n");
  });

  test("/health is 503 while not running", async () => {
    const { get } = await setup();
    const response = await get("/health");
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json");
    const health: HealthResponse = await response.json();
    expect(health.version).toBe(1);
    expect(health.status).toBe("down");
    expect(health.components.indexer?.running).toBe(false);
    expect(health.components.indexer?.reasons).toContain("not running");
    expect(health.reasons).toContain("indexer: not running");
  });

  test("/health is 200 once running and ticking", async () => {
    const { watch, get } = await setup();
    await watch.start();
    await until(() => watch.health().status !== "down"); // ticked once
    const response = await get("/health");
    const health: HealthResponse = await response.json();
    expect(health.status).not.toBe("down");
    expect(response.status).toBe(200);
    expect(health.components.indexer?.running).toBe(true);
    expect(health.components.indexer?.addresses).toBe(1);
  });

  test("/status lists addresses with bigint fields as strings, plus server stats", async () => {
    const { watch, get } = await setup();
    await watch.start();
    await until(() => watch.status()[0]?.frontier != null);
    const response = await get("/status");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = await response.json();
    expect(body.mode).toBe("run");
    expect(body.servers).toEqual(stats);
    expect(body.webhooks).toEqual([]);
    expect(body.addresses).toHaveLength(1);
    expect(body.addresses[0].address).toBe(A);
    expect(typeof body.addresses[0].syncedLt).toBe("string");
    expect(typeof body.addresses[0].frontier).toBe("string");
  });

  test("/consumers lists the store's consumers with lag and dead letters", async () => {
    const { watch, get } = await setup();
    const reader = watch.process("reader", () => {}, { addresses: [A] });
    await watch.start();
    await until(() => reader.status().delivered === 5);
    const response = await get("/consumers");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      version: 1,
      consumers: [{ name: "reader", order: "address", addresses: 1, failing: 0, deadLetters: 0 }],
    });
  });

  test("/consumers is 500 with the error when the store fails", async () => {
    const lines: unknown[][] = [];
    const logger: Logger = { ...silentLogger, warn: (...args) => void lines.push(args) };
    server = await startHttpServer(
      staticProbe(() => Promise.reject(new Error("database is gone"))),
      0,
      logger,
    );
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/consumers`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "database is gone" });
    expect(lines).toEqual([["/consumers failed:", "database is gone"]]);
  });

  test("unknown paths are 404 with an empty body", async () => {
    const { get } = await setup();
    for (const path of ["/", "/metric", "/health/", "/STATUS", "/nope"]) {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  test("the query string is ignored", async () => {
    const { get } = await setup();
    expect((await get("/health?verbose=1")).status).toBe(503);
    expect((await get("/metrics?x")).status).toBe(200);
    expect((await get("/nope?x")).status).toBe(404);
  });

  test("HEAD is GET without a body; other methods are 405 with Allow", async () => {
    const { get } = await setup();
    const head = await get("/metrics", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await get("/health", { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  test("rejects, closing the server, when the port is in use", async () => {
    const { port } = await setup();
    const lines: unknown[][] = [];
    const logger: Logger = { ...silentLogger, info: (...args) => void lines.push(args) };
    const probe = staticProbe(async () => ({ version: 1, consumers: [] }));
    await expect(startHttpServer(probe, port, logger)).rejects.toThrow(
      `cannot serve HTTP on port ${port}`,
    );
    expect(lines).toEqual([]);
  });
});

describe("run health", () => {
  const webhook = (running: boolean, halted: boolean): ConsumerStatus => ({
    name: "webhook:a",
    running,
    waitingForLock: false,
    delivered: 0,
    lag: null,
    addresses: [
      { address: A, cursor: null, halted, failures: halted ? 1 : 0, lastError: "HTTP 500" },
    ],
  });
  const indexer: Health = {
    status: "ok",
    running: true,
    tip: null,
    addresses: 1,
    maxLagSeconds: 0,
    gapsOpen: 0,
    stuckRanges: 0,
    txWrittenPerSecond: 0,
    reasons: [],
  };

  test("is the worst of the components, with every reason prefixed by its component", () => {
    expect(healthResponse(indexer, [])).toMatchObject({ status: "ok", reasons: [] });
    expect(healthResponse(indexer, [webhook(true, true)])).toMatchObject({
      status: "degraded",
      reasons: [`webhook:a: retrying ${A}: HTTP 500`],
      components: { webhooks: [{ name: "webhook:a", status: "degraded", retrying: 1 }] },
    });
    expect(healthResponse(indexer, [webhook(false, false)])).toMatchObject({
      status: "down",
      reasons: ["webhook:a: not running"],
    });
    const down: Health = { ...indexer, status: "down", reasons: ["not running"] };
    expect(healthResponse(down, [webhook(true, true)])).toMatchObject({
      status: "down",
      reasons: ["indexer: not running", `webhook:a: retrying ${A}: HTTP 500`],
    });
  });

  test("deliver has the same shape, without an indexer component", () => {
    expect(healthResponse(null, [webhook(true, false)])).toEqual({
      version: 1,
      status: "ok",
      reasons: [],
      components: {
        indexer: null,
        webhooks: [
          {
            name: "webhook:a",
            status: "ok",
            reasons: [],
            running: true,
            waitingForLock: false,
            retrying: 0,
          },
        ],
      },
    });
  });

  test("/health under deliver is 503 while a consumer is not running", async () => {
    const store = new MemoryStore();
    const chain = new FakeChain();
    watch = new TonWatch({ store, source: new FakeSource(chain), logger: silentLogger });
    const hook = watch.process("webhook:a", () => {});
    server = await startHttpServer(deliveryProbe(new Metrics(), [hook], store), 0, silentLogger);
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(503);
    const health: HealthResponse = await response.json();
    expect(health.components.indexer).toBeNull();
    expect(health.reasons).toEqual(["webhook:a: not running"]);
  });

  test("/health under run reports a halted webhook consumer", async () => {
    const { watch } = await setup();
    const hook = watch.process("webhook:a", () => {
      throw new Error("receiver down");
    });
    server?.close();
    server = await startHttpServer(
      indexerProbe(watch, () => stats, [hook]),
      0,
      silentLogger,
    );
    const { port } = server.address() as AddressInfo;
    await watch.start();
    await until(() => hook.status().addresses.some((lane) => lane.halted));
    await until(() => watch.health().status !== "down"); // ticked once
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const health: HealthResponse = await response.json();
    expect(health.components.webhooks).toHaveLength(1);
    expect(health.status).not.toBe("ok");
    expect(health.reasons.join("\n")).toContain("webhook:a: retrying");
  });
});
