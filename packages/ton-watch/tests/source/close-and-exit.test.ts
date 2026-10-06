/**
 * Subprocess tests: once `TonWatch.close()` (or a failed `LiteSource.connect()`)
 * resolved, nothing keeps the process alive.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LsConfig } from "@ton/ls";
import { closedPort, startFakeLiteserver } from "../fixtures/liteserver/fake-liteserver";
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
