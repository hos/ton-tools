/**
 * The `ton-watch` CLI in-process, with Postgres replaced by PGlite and the liteserver
 * connection by a `FakeSource` (both mocked at the module level), plus the real
 * binary as a subprocess for startup failures that happen before any connection.
 */
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import * as pg from "pg";

import { errorMessage } from "../../src/core/errors";
import { main } from "../../src/service/cli";
import { LiteSource } from "../../src/source/liteserver/lite-source";
import { FakeChain, FakeSource, fakeAddress } from "../fixtures/fake-chain";

const BIN = `${import.meta.dir}/../../src/bin/ton-watch.ts`;
const A = fakeAddress(1);
const B = fakeAddress(2);

let db: PGlite;
let chain: FakeChain;
let poolSpy: Mock<(...args: unknown[]) => unknown>;
let connectSpy: Mock<(options?: unknown) => Promise<unknown>>;
let exitSpy: Mock<(code?: number) => never>;
let logSpy: Mock<(...args: unknown[]) => void>;
let infoSpy: Mock<(...args: unknown[]) => void>;
const restore: { mockRestore(): void }[] = [];

const env = (extra: Record<string, string> = {}) => ({
  DATABASE_URL: "postgres://test/db",
  TON_WATCH_LOG: "silent",
  TON_WATCH_PORT: "0",
  ...extra,
});

const until = async (cond: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Runs `list` and returns the parsed JSON it printed. */
async function list(): Promise<{ address: string; startLt: string }[]> {
  logSpy.mockClear();
  await main(["list"], env());
  return JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
}

beforeEach(async () => {
  db = await PGlite.create();
  chain = new FakeChain();
  chain.grow([A, B], 10);
  const fakePool = {
    query: (text: string, params?: unknown[]) => db.query(text, params),
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => db.transaction(fn),
    on: () => {},
    end: async () => {},
  };
  // Replaces the pg.Pool constructor; a class spy is typed for `new`, hence the cast.
  poolSpy = spyOn(pg, "Pool") as unknown as typeof poolSpy;
  poolSpy.mockImplementation(() => fakePool);
  const source = Object.assign(new FakeSource(chain), { pool: { stats: () => [] } });
  connectSpy = spyOn(LiteSource, "connect") as unknown as typeof connectSpy;
  connectSpy.mockResolvedValue(source);
  // process.exit must not end the test run.
  exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  infoSpy = spyOn(console, "info").mockImplementation(() => {});
  restore.push(poolSpy, connectSpy, exitSpy, logSpy, infoSpy);
});

afterEach(async () => {
  for (const spy of restore.splice(0)) spy.mockRestore();
  await db.close();
});

describe("ton-watch CLI commands", () => {
  test("connects with the configured database, schema and network", async () => {
    await main(["list"], env({ TON_NETWORK: "testnet", TON_ARCHIVE_CONFIG: "https://a/c.json" }));
    expect(poolSpy).toHaveBeenCalledWith({ connectionString: "postgres://test/db", max: 20 });
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy.mock.calls[0]?.[0]).toMatchObject({
      servers: "testnet",
      archiveServers: "https://a/c.json",
    });
    const tables = await db.query<{ table_schema: string }>(
      "select distinct table_schema from information_schema.tables where table_schema = 'ton_watch'",
    );
    expect(tables.rows).toEqual([{ table_schema: "ton_watch" }]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test("TON_WATCH_SCHEMA picks the Postgres schema", async () => {
    await main(["list"], env({ TON_WATCH_SCHEMA: "custom_schema" }));
    const tables = await db.query(
      "select 1 from information_schema.tables where table_schema = 'custom_schema'",
    );
    expect(tables.rows.length).toBeGreaterThan(0);
  });

  test("list on an empty database prints []", async () => {
    expect(await list()).toEqual([]);
  });

  test("add: --from genesis, --from <lt>, and now by default", async () => {
    await main(["add", A, "--from", "genesis"], env());
    await main(["add", B, "--from", "12345"], env());
    expect(exitSpy).toHaveBeenCalledTimes(2);
    let states = await list();
    expect(states.map((s) => [s.address, s.startLt])).toEqual([
      [A, "0"],
      [B, "12345"],
    ]);

    const C = fakeAddress(3);
    chain.grow([C], 3);
    await main(["add", C], env());
    states = await list();
    const lastLt = chain.txs(C).at(-1)!.lt;
    expect(states.find((s) => s.address === C)?.startLt).toBe(lastLt.toString());
  });

  test("add logs the raw address it watches", async () => {
    await main(["add", A], env({ TON_WATCH_LOG: "info" }));
    expect(infoSpy.mock.calls).toContainEqual(["[ton-watch]", `watching ${A}`]);
  });

  test("add without an address or with a bad --from fails with usage", async () => {
    await expect(main(["add"], env())).rejects.toThrow(
      "usage: ton-watch add <address> [--from now|genesis|<lt>]",
    );
    await expect(main(["add", A, "--from", "soon"], env())).rejects.toThrow(
      "invalid --from value: soon",
    );
  });

  test("remove, with and without --purge", async () => {
    await main(["add", A, "--from", "genesis"], env());
    await main(["add", B, "--from", "genesis"], env());
    await main(["remove", A], env());
    await main(["remove", B, "--purge"], env());
    expect(await list()).toEqual([]);
  });

  test("remove without an address fails with usage", async () => {
    await expect(main(["remove"], env())).rejects.toThrow(
      "usage: ton-watch remove <address> [--purge]",
    );
  });

  test("an unknown command is rejected", async () => {
    await expect(main(["frobnicate"], env())).rejects.toThrow("unknown command: frobnicate");
  });

  test("bad configuration fails before connecting to anything", async () => {
    await expect(main(["list"], { TON_WATCH_LOG: "silent" })).rejects.toThrow(
      "DATABASE_URL is required",
    );
    await expect(main(["list"], env({ TON_WATCH_DETECT: "x" }))).rejects.toThrow(
      "invalid TON_WATCH_DETECT",
    );
    expect(poolSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  test("TON_WATCH_HISTORY=toncenter loads the plug-in", async () => {
    await main(
      ["list"],
      env({
        TON_WATCH_LOG: "info",
        TON_WATCH_HISTORY: "toncenter",
        TON_WATCH_HISTORY_MODE: "boost",
      }),
    );
    expect(infoSpy.mock.calls).toContainEqual([
      "[ton-watch]",
      "history plug-in: toncenter (boost, experimental)",
    ]);
  });
});

describe("ton-watch run", () => {
  const signalListeners = () => ({
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
  });
  let before: ReturnType<typeof signalListeners>;
  beforeEach(() => {
    before = signalListeners();
  });
  afterEach(() => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.off(signal, listener);
      }
    }
  });

  const freePort = () =>
    new Promise<number>((resolve) => {
      const probe = createServer().listen(0, () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });

  test("is the default command: ensures addresses, serves HTTP, stops on SIGTERM", async () => {
    await main(["add", A, "--from", "genesis"], env());
    exitSpy.mockClear();
    const port = await freePort();
    await main(
      [],
      env({ TON_WATCH_PORT: String(port), TON_WATCH_ADDRESSES: `${A}@now,${B}@genesis` }),
    );

    // A was already watched (from genesis) and is kept as is; B is added.
    expect((await list()).map((s) => [s.address, s.startLt])).toEqual([
      [A, "0"],
      [B, "0"],
    ]);
    exitSpy.mockClear();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect([200, 503]).toContain(health.status);
    expect((await health.json()).running).toBe(true);
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    expect(status.servers).toEqual([]);
    expect(status.addresses).toHaveLength(2);

    process.emit("SIGTERM");
    process.emit("SIGTERM"); // a second signal while stopping is ignored
    await until(() => exitSpy.mock.calls.length > 0);
    expect(exitSpy.mock.calls).toEqual([[0]]);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  test("SIGINT stops too; port 0 serves nothing", async () => {
    await main(["run"], env({ TON_WATCH_ADDRESSES: A }));
    process.emit("SIGINT");
    await until(() => exitSpy.mock.calls.length > 0);
    expect(exitSpy.mock.calls).toEqual([[0]]);
  });
});

describe("ton-watch startup errors", () => {
  test("an unreachable database produces a readable message", async () => {
    poolSpy.mockRestore();
    const error = await main(["list"], env({ DATABASE_URL: "postgres://u@localhost:1/db" })).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(errorMessage(error)).toContain("ECONNREFUSED");
  });
});

describe("ton-watch binary", () => {
  const run = (env: Record<string, string>) => {
    // Run outside the package so bun does not load the package's local `.env`.
    const result = Bun.spawnSync(["bun", BIN, "list"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };

  test("exits 1 with a prefixed message when DATABASE_URL is missing", () => {
    const { code, stderr } = run({});
    expect(code).toBe(1);
    expect(stderr).toContain("[ton-watch] DATABASE_URL is required");
  });

  test("exits 1 on an invalid variable", () => {
    const { code, stderr } = run({ DATABASE_URL: "postgres://x", TON_WATCH_LOG: "loud" });
    expect(code).toBe(1);
    expect(stderr).toContain("invalid TON_WATCH_LOG: loud");
  });

  test("exits 1 on an invalid address list", () => {
    const { code, stderr } = run({ DATABASE_URL: "postgres://x", TON_WATCH_ADDRESSES: `${A}@x` });
    expect(code).toBe(1);
    expect(stderr).toContain("invalid --from value: x");
  });
});
