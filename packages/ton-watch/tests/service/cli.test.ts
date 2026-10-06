/**
 * The `ton-watch` CLI in-process, with Postgres replaced by PGlite and the liteserver
 * connection by a `FakeSource` (both mocked at the module level), plus the real
 * binary as a subprocess for startup failures that happen before any connection.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:net";
import { tmpdir } from "node:os";

import { errorMessage } from "../../src/core/errors";
import { main } from "../../src/service/cli";
import type { AddressJson, AddressListResponse } from "../../src/service/output";
import { TonWatch } from "../../src/ton-watch";
import { fakeAddress } from "../fixtures/fake-chain";
import { type ServiceHarness, setupService, until } from "./harness";

const BIN = `${import.meta.dir}/../../src/bin/ton-watch.ts`;
const A = fakeAddress(1);
const B = fakeAddress(2);

let h: ServiceHarness;

const env = (extra: Record<string, string> = {}) => ({
  TON_WATCH_DATABASE_URL: "postgres://test/db",
  TON_WATCH_LOG: "silent",
  TON_WATCH_PORT: "0",
  ...extra,
});

/** Runs `list` and returns the addresses it printed. */
async function list(): Promise<AddressJson[]> {
  h.logSpy.mockClear();
  await main(["list"], env());
  const output: AddressListResponse = JSON.parse(String(h.logSpy.mock.calls.at(-1)?.[0]));
  expect(output.version).toBe(1);
  return output.addresses;
}

beforeEach(async () => {
  h = await setupService();
  h.chain.grow([A, B], 10);
});

afterEach(() => h.teardown());

describe("ton-watch CLI commands", () => {
  test("connects with the configured database, schema and network", async () => {
    await main(
      ["list"],
      env({ TON_WATCH_NETWORK: "testnet", TON_WATCH_ARCHIVE_NETWORK: "https://a/c.json" }),
    );
    expect(h.poolSpy).toHaveBeenCalledWith({ connectionString: "postgres://test/db", max: 20 });
    expect(h.connectSpy).toHaveBeenCalledTimes(1);
    expect(h.connectSpy.mock.calls[0]?.[0]).toMatchObject({
      servers: "testnet",
      archiveServers: "https://a/c.json",
    });
    const tables = await h.db.query<{ table_schema: string }>(
      "select distinct table_schema from information_schema.tables where table_schema = 'ton_watch'",
    );
    expect(tables.rows).toEqual([{ table_schema: "ton_watch" }]);
    expect(h.exitSpy).toHaveBeenCalledWith(0);
  });

  test("TON_WATCH_SCHEMA picks the Postgres schema", async () => {
    await main(["list"], env({ TON_WATCH_SCHEMA: "custom_schema" }));
    const tables = await h.db.query(
      "select 1 from information_schema.tables where table_schema = 'custom_schema'",
    );
    expect(tables.rows.length).toBeGreaterThan(0);
  });

  test("list on an empty database prints no addresses", async () => {
    expect(await list()).toEqual([]);
  });

  test("list prints head and frontier hashes as hex, not Buffer JSON", async () => {
    await main(["run"], env({ TON_WATCH_ADDRESSES: `${A}@earliest` }));
    let text = "";
    await until(async () => {
      h.logSpy.mockClear();
      await main(["list"], env());
      text = String(h.logSpy.mock.calls.at(-1)?.[0]);
      return (JSON.parse(text) as AddressListResponse).addresses[0]?.frontier != null;
    });
    process.emit("SIGTERM");
    expect(text).not.toContain("Buffer");
    const [state] = (JSON.parse(text) as AddressListResponse).addresses;
    expect(state!.head?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state!.frontier).toEqual({
      lt: expect.stringMatching(/^\d+$/),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("add: --from earliest, --from <lt>, and now by default", async () => {
    await main(["add", A, "--from", "earliest"], env());
    await main(["add", B, "--from", "12345"], env());
    expect(h.exitSpy).toHaveBeenCalledTimes(2);
    let states = await list();
    expect(states.map((s) => [s.address, s.startLt])).toEqual([
      [A, "0"],
      [B, "12345"],
    ]);

    const C = fakeAddress(3);
    h.chain.grow([C], 3);
    await main(["add", C], env());
    states = await list();
    const lastLt = h.chain.txs(C).at(-1)!.lt;
    expect(states.find((s) => s.address === C)?.startLt).toBe(lastLt.toString());
  });

  test("add logs the raw address it watches", async () => {
    await main(["add", A], env({ TON_WATCH_LOG: "info" }));
    expect(h.infoSpy.mock.calls).toContainEqual(["[ton-watch]", `watching ${A}`]);
  });

  test("add without an address or with a bad --from fails with usage", async () => {
    await expect(main(["add"], env())).rejects.toThrow(
      "usage: ton-watch add <address> [--from now|earliest|<lt>]",
    );
    await expect(main(["add", A, "--from", "soon"], env())).rejects.toThrow(
      "invalid --from value: soon",
    );
  });

  test("remove, with and without --purge", async () => {
    await main(["add", A, "--from", "earliest"], env());
    await main(["add", B, "--from", "earliest"], env());
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
      "TON_WATCH_DATABASE_URL (or DATABASE_URL) is required",
    );
    await expect(main(["list"], env({ TON_WATCH_DETECT: "x" }))).rejects.toThrow(
      "invalid TON_WATCH_DETECT",
    );
    expect(h.poolSpy).not.toHaveBeenCalled();
    expect(h.connectSpy).not.toHaveBeenCalled();
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
    expect(h.infoSpy.mock.calls).toContainEqual([
      "[ton-watch]",
      "history plug-in: toncenter (boost, experimental)",
    ]);
  });
});

describe("ton-watch run", () => {
  const freePort = () =>
    new Promise<number>((resolve) => {
      const probe = createServer().listen(0, () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });

  test("is the default command: ensures addresses, serves HTTP, stops on SIGTERM", async () => {
    await main(["add", A, "--from", "earliest"], env());
    h.exitSpy.mockClear();
    const port = await freePort();
    await main(
      [],
      env({ TON_WATCH_PORT: String(port), TON_WATCH_ADDRESSES: `${A}@now,${B}@earliest` }),
    );

    // A was already watched (from earliest) and is kept as is; B is added.
    expect((await list()).map((s) => [s.address, s.startLt])).toEqual([
      [A, "0"],
      [B, "0"],
    ]);
    h.exitSpy.mockClear();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect([200, 503]).toContain(health.status);
    expect((await health.json()).components.indexer.running).toBe(true);
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    expect(status.servers).toEqual([]);
    expect(status.addresses).toHaveLength(2);

    process.emit("SIGTERM");
    await until(() => h.exitSpy.mock.calls.length > 0);
    expect(h.exitSpy.mock.calls).toEqual([[0]]);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  test("a second signal while stopping exits 1 at once", async () => {
    await main(["run"], env({ TON_WATCH_ADDRESSES: A }));
    process.emit("SIGTERM");
    process.emit("SIGINT");
    expect(h.exitSpy.mock.calls[0]).toEqual([1]);
    await until(() => h.exitSpy.mock.calls.length > 1); // the graceful stop still finishes
  });

  test("a failing stop is logged and exits 1", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const stop = spyOn(TonWatch.prototype, "stop").mockRejectedValueOnce(new Error("db gone"));
    try {
      await main(["run"], env({ TON_WATCH_ADDRESSES: A, TON_WATCH_LOG: "error" }));
      process.emit("SIGTERM");
      await until(() => h.exitSpy.mock.calls.length > 0);
      expect(h.exitSpy.mock.calls).toEqual([[1]]);
      expect(errors.mock.calls).toContainEqual(["[ton-watch]", "stop failed:", "db gone"]);
    } finally {
      stop.mockRestore();
      errors.mockRestore();
    }
  });

  test("a port in use fails before any work starts, releasing what it opened", async () => {
    const taken = createServer();
    const port = await new Promise<number>((resolve) =>
      taken.listen(0, () => resolve((taken.address() as { port: number }).port)),
    );
    const start = spyOn(TonWatch.prototype, "start");
    const stop = spyOn(TonWatch.prototype, "stop");
    const signalListeners = process.listenerCount("SIGTERM");
    try {
      await expect(
        main(["run"], env({ TON_WATCH_PORT: String(port), TON_WATCH_ADDRESSES: A })),
      ).rejects.toThrow(`cannot serve HTTP on port ${port}`);
      expect(start).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(process.listenerCount("SIGTERM")).toBe(signalListeners);
    } finally {
      start.mockRestore();
      stop.mockRestore();
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  test("an invalid TON_WATCH_ADDRESSES entry fails before connecting", async () => {
    await expect(main(["run"], env({ TON_WATCH_ADDRESSES: `${A},nope@earliest` }))).rejects.toThrow(
      "invalid TON_WATCH_ADDRESSES: nope is not an address",
    );
    expect(h.poolSpy).not.toHaveBeenCalled();
    expect(h.connectSpy).not.toHaveBeenCalled();
  });

  test("SIGINT stops too; port 0 serves nothing", async () => {
    await main(["run"], env({ TON_WATCH_ADDRESSES: A }));
    process.emit("SIGINT");
    await until(() => h.exitSpy.mock.calls.length > 0);
    expect(h.exitSpy.mock.calls).toEqual([[0]]);
  });
});

describe("ton-watch startup errors", () => {
  test("an unreachable database produces a readable message", async () => {
    h.poolSpy.mockRestore();
    const error = await main(
      ["list"],
      env({ TON_WATCH_DATABASE_URL: "postgres://u@localhost:1/db" }),
    ).then(
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

  test("exits 1 with a prefixed message when the database URL is missing", () => {
    const { code, stderr } = run({});
    expect(code).toBe(1);
    expect(stderr).toContain("[ton-watch] TON_WATCH_DATABASE_URL (or DATABASE_URL) is required");
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
