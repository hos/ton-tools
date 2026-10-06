import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { startHttpServer, toJson } from "../../src/service/http-server";
import { indexerProbe } from "../../src/service/probes";
import type { ServerStats } from "../../src/source/liteserver/server-pool";
import { MemoryStore } from "../../src/stores/memory/memory-store";
import { TonWatch } from "../../src/ton-watch";
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
  await watch.addAddress(A, { from: "genesis" });
  server = startHttpServer(
    indexerProbe(watch, () => stats),
    0,
    logger,
  );
  await new Promise((resolve) => server!.once("listening", resolve));
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
  test("bigints become decimal strings, nested too, pretty-printed", () => {
    expect(toJson({ lt: 123n, list: [1n, { x: -5n }], n: 1, s: "a", z: null })).toBe(
      JSON.stringify({ lt: "123", list: ["1", { x: "-5" }], n: 1, s: "a", z: null }, null, 2),
    );
    expect(toJson(2n ** 64n)).toBe('"18446744073709551616"');
  });
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
    watch.metrics.inc("my_counter_total", { kind: "x" }, 3);
    const response = await get("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4");
    const body = await response.text();
    expect(body).toBe(watch.metrics.toPrometheus());
    expect(body).toContain('my_counter_total{kind="x"} 3\n');
  });

  test("/health is 503 while not running", async () => {
    const { get } = await setup();
    const response = await get("/health");
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json");
    const health = await response.json();
    expect(health.status).toBe("down");
    expect(health.running).toBe(false);
    expect(health.reasons).toContain("not running");
  });

  test("/health is 200 once running and ticking", async () => {
    const { watch, get } = await setup();
    await watch.start();
    await until(() => watch.indexer.lastTickAt > 0);
    const response = await get("/health");
    const health = await response.json();
    expect(health.status).not.toBe("down");
    expect(response.status).toBe(200);
    expect(health.running).toBe(true);
    expect(health.addresses).toBe(1);
  });

  test("/status lists addresses with bigint fields as strings, plus server stats", async () => {
    const { watch, get } = await setup();
    await watch.start();
    await until(() => watch.status()[0]?.frontier != null);
    const response = await get("/status");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = await response.json();
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
    expect(await response.json()).toMatchObject([
      { name: "reader", order: "address", addresses: 1, failing: 0, deadLetters: 0 },
    ]);
  });

  test("/consumers is 500 with the error when the store fails", async () => {
    const lines: unknown[][] = [];
    const logger: Logger = { ...silentLogger, warn: (...args) => void lines.push(args) };
    server = startHttpServer(
      {
        metrics: () => "",
        health: () => ({ status: "ok" }),
        status: () => ({}),
        consumers: () => Promise.reject(new Error("database is gone")),
      },
      0,
      logger,
    );
    await new Promise((resolve) => server!.once("listening", resolve));
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

  test("method is not checked: HEAD and POST behave like GET", async () => {
    const { get } = await setup();
    expect((await get("/metrics", { method: "HEAD" })).status).toBe(200);
    expect((await get("/health", { method: "POST" })).status).toBe(503);
  });
});
