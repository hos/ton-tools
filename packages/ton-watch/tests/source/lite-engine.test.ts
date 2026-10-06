import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import type { LsConfig } from "@ton/ls";
import { LiteClient } from "ton-lite-client";
import { Functions } from "ton-lite-client/dist/schema.js";
import { LiteConnection } from "../../src/source/liteserver/lite-engine";
import { closedPort, startFakeLiteserver } from "../fixtures/liteserver/fake-liteserver";
import mainnet from "../fixtures/liteserver/mainnet.json";
import { runCloseAndExit } from "../fixtures/liteserver/run-close-and-exit";

const LOCALHOST = 0x7f000001;
/** Upper bound for the process to exit once `close()` resolved. */
const EXIT_WITHIN_MS = 2_000;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fakeServer(options?: Parameters<typeof startFakeLiteserver>[0]) {
  const server = await startFakeLiteserver(options);
  cleanup.push(() => server.close());
  return server;
}

function connectTo(server: { port: number; publicKey: string }, reconnectMs?: number) {
  const engine = new LiteConnection({
    host: `tcp://127.0.0.1:${server.port}`,
    publicKey: Buffer.from(server.publicKey, "base64"),
    reconnectMs,
  });
  cleanup.push(() => engine.close());
  return engine;
}

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

const getTime = (engine: LiteConnection, timeout?: number) =>
  engine.query(Functions.liteServer_getTime, { kind: "liteServer.getTime" }, { timeout });

/** Accepts connections and drops them at once, counting them. */
async function droppingServer(): Promise<{ port: number; accepted: () => number }> {
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return { port: (server.address() as net.AddressInfo).port, accepted: () => accepted };
}

describe("LiteConnection", () => {
  test("handshakes and decodes answers", async () => {
    const engine = connectTo(await fakeServer());
    await until(() => engine.isReady());
    const info = await new LiteClient({ engine }).getMasterchainInfoExt();
    expect(info.last.seqno).toBe(mainnet.tip.last.seqno);
  });

  test("a liteServer.error rejects with its message", async () => {
    const engine = connectTo(await fakeServer({ errorMessage: "cannot load block" }));
    await until(() => engine.isReady());
    await expect(getTime(engine)).rejects.toThrow("cannot load block");
  });

  test("queries made before the connection is ready are sent once it is", async () => {
    const engine = connectTo(await fakeServer());
    expect(engine.isReady()).toBe(false);
    const info = await new LiteClient({ engine }).getMasterchainInfoExt();
    expect(info.last.seqno).toBe(mainnet.tip.last.seqno);
  });

  test("an unanswered query times out", async () => {
    const engine = connectTo(await fakeServer());
    await until(() => engine.isReady());
    await expect(getTime(engine, 50)).rejects.toThrow("Timeout");
  });

  test("close() rejects pending queries, and later ones", async () => {
    const server = await fakeServer();
    const engine = connectTo(server);
    await until(() => engine.isReady());
    const pending = getTime(engine, 60_000);
    engine.close();
    await expect(pending).rejects.toThrow("Engine is closed");
    await expect(getTime(engine)).rejects.toThrow("Engine is closed");
    expect(engine.isClosed()).toBe(true);
    expect(engine.isReady()).toBe(false);
    await until(() => server.connections === 0);
  });

  test("close() destroys a socket stuck in the handshake", async () => {
    const server = await fakeServer({ silent: true });
    const engine = connectTo(server);
    await until(() => server.connections === 1);
    engine.close();
    await until(() => server.connections === 0);
  });

  test("reconnects after the connection drops, never after close()", async () => {
    const server = await droppingServer();
    // Any valid Ed25519 key: the connection is dropped before the handshake matters.
    const { publicKey } = await fakeServer();
    const engine = connectTo({ port: server.port, publicKey }, 10);
    await until(() => server.accepted() >= 3);
    engine.close();
    const accepted = server.accepted();
    await Bun.sleep(100);
    expect(server.accepted()).toBe(accepted);
  });
});

describe("process exit after close()", () => {
  const config = (server: { port: number; publicKey: string }): LsConfig => ({
    ip: LOCALHOST,
    port: server.port,
    id: { key: server.publicKey },
  });

  test("a TonWatch over a LiteSource lets the process exit at once", async () => {
    // Answers tip queries and hangs on the rest, so calls are pending at close;
    // plus a server that never handshakes and one that refuses connections.
    const servers = [
      config(await fakeServer()),
      config(await fakeServer({ silent: true })),
      config({ port: await closedPort(), publicKey: Buffer.alloc(32, 1).toString("base64") }),
    ];
    const result = await runCloseAndExit(
      { LITESERVERS: JSON.stringify(servers), RUN_MS: "1000" },
      30_000,
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.exitMsAfterClose).not.toBeNull();
    expect(result.exitMsAfterClose!).toBeLessThan(EXIT_WITHIN_MS);
  }, 40_000);

  test("a failed LiteSource.connect() lets the process exit at once", async () => {
    const servers = [
      config(await fakeServer({ silent: true })),
      config({ port: await closedPort(), publicKey: Buffer.alloc(32, 1).toString("base64") }),
    ];
    const result = await runCloseAndExit(
      { LITESERVERS: JSON.stringify(servers), EXPECT_CONNECT_FAILURE: "1" },
      30_000,
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.exitMsAfterClose!).toBeLessThan(EXIT_WITHIN_MS);
  }, 40_000);
});
