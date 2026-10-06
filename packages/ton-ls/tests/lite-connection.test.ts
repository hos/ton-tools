import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { LiteClient } from "ton-lite-client";
import { Functions } from "ton-lite-client/dist/schema.js";
import { LiteConnection } from "../src/lite-connection.ts";
import { startFakeLiteserver, TIP } from "./fixtures/fake-liteserver.ts";

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
    expect(info.last.seqno).toBe(TIP.seqno);
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
    expect(info.last.seqno).toBe(TIP.seqno);
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
