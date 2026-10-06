/**
 * `filterLiteServers()` (and `benchmark()` under it) must close every connection it
 * opened: run in a subprocess, the process exits right after the result is printed,
 * also when some servers never answer or refuse connections.
 */
import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { LsConfig } from "../src/index.ts";
import { closedPort, startFakeLiteserver, TIP } from "./fixtures/fake-liteserver.ts";

const SCRIPT = fileURLToPath(new URL("./fixtures/filter-and-exit.ts", import.meta.url));
const LOCALHOST = 0x7f000001;
/** Upper bound for the process to exit once the result was printed. */
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

const config = (server: { port: number; publicKey: string }): LsConfig => ({
  ip: LOCALHOST,
  port: server.port,
  id: { key: server.publicKey },
});

/** Runs the script; times from its output line to the process exit. Killed after 30s. */
async function run(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", SCRIPT], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => proc.kill(), 30_000);
  let printedAt: number | null = null;
  let stdout = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      stdout += decoder.decode(chunk);
      if (printedAt === null && stdout.includes("\n")) printedAt = performance.now();
    }
  })();
  const stderr = new Response(proc.stderr).text();
  try {
    const exitCode = await proc.exited;
    const exitedAt = performance.now();
    await reading;
    return {
      exitCode,
      exitMsAfterResult: printedAt === null ? null : exitedAt - printedAt,
      result: printedAt === null ? null : JSON.parse(stdout),
      stderr: await stderr,
    };
  } finally {
    clearTimeout(deadline);
    proc.kill();
  }
}

test("the process exits once filterLiteServers() resolved", async () => {
  const good = await fakeServer();
  const servers = [
    config(good),
    // Never completes the handshake: still connecting at the timeout.
    config(await fakeServer({ silent: true })),
    // Refuses connections: reconnects are pending at the timeout.
    config({ port: await closedPort(), publicKey: Buffer.alloc(32, 1).toString("base64") }),
  ];
  const { exitCode, exitMsAfterResult, result, stderr } = await run({
    LITESERVERS: JSON.stringify(servers),
    TIMEOUT_MS: "1000",
  });
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(result).toMatchObject({ good: [good.port], fulfilled: 3, rejected: 0, seqno: TIP.seqno });
  expect(result.successCount).toBeGreaterThan(0);
  expect(exitMsAfterResult).not.toBeNull();
  expect(exitMsAfterResult!).toBeLessThan(EXIT_WITHIN_MS);
}, 40_000);
