/**
 * Guards the public surface: adding is a conscious choice, removing or renaming is
 * a breaking change. Runtime exports are checked here; type-only exports are
 * checked by `bun run typecheck` through `PublicTypes` below.
 */
import { describe, expect, test } from "bun:test";

import pkg from "../package.json";
import type * as Api from "../src/index";
import type * as Toncenter from "../src/plugins/toncenter";

const RUNTIME_EXPORTS = [
  "Consumer",
  "Indexer",
  "LiteSource",
  "MemoryStore",
  "Metrics",
  "PgStore",
  "ServerPool",
  "SourceError",
  "TonWatch",
  "analyzeChain",
  "classifyError",
  "completeUpTo",
  "consoleLogger",
  "poolDatabase",
  "recordFromCell",
  "silentLogger",
  "toIndexedTx",
  "toRaw",
  "txIdEquals",
  "validatePage",
];

/** Fails to type-check if any type-only export disappears or is renamed. */
export type PublicTypes = [
  Api.AddAddressOptions,
  Api.AddressState,
  Api.AddressStatus,
  Api.BlockRef,
  Api.ChainAnalysis,
  Api.ChainTip,
  Api.ConsumerDeps,
  Api.ConsumerStatus,
  Api.ConsumerWakeEvents,
  Api.DetectMode,
  Api.ErrorKind,
  Api.Gap,
  Api.HandlerContext,
  Api.Health,
  Api.HistoryOptions,
  Api.HistorySource,
  Api.IndexedTx,
  Api.IndexerEventMap,
  Api.IndexerOptions,
  Api.LiteSourceOptions,
  Api.LogLevel,
  Api.Logger,
  Api.PgDatabase,
  Api.PgQueryable,
  Api.PgStoreOptions,
  Api.PoolMember<unknown>,
  Api.ProcessOptions,
  Api.ServerPoolOptions,
  Api.ServerStats,
  Api.ShardTop,
  Api.SplitOptions,
  Api.Store,
  Api.StoreAddAddressOptions,
  Api.StoreTransaction,
  Api.TonWatchOptions,
  Api.TxHandler,
  Api.TxId,
  Api.TxRecord,
  Api.TxSource,
  Toncenter.ToncenterHistoryOptions,
];

describe("public API", () => {
  test("ton-watch exports exactly these runtime names", async () => {
    const api = await import("ton-watch");
    expect(Object.keys(api).sort()).toEqual(RUNTIME_EXPORTS);
  });

  test("ton-watch/toncenter exports only the plug-in", async () => {
    const toncenter = await import("ton-watch/toncenter");
    expect(Object.keys(toncenter).sort()).toEqual(["ToncenterHistory"]);
    expect(typeof toncenter.ToncenterHistory).toBe("function");
  });

  test("the main entry does not pull in the toncenter plug-in", async () => {
    const api = await import("ton-watch");
    expect(Object.keys(api)).not.toContain("ToncenterHistory");
  });

  test("package entry points resolve to the source modules", async () => {
    expect(pkg.exports).toEqual({
      ".": "./src/index.ts",
      "./toncenter": "./src/plugins/toncenter/index.ts",
    });
    expect(pkg.main).toBe("src/index.ts");
    expect(pkg.module).toBe("src/index.ts");
    const dir = `${import.meta.dir}/..`;
    expect(Bun.resolveSync("ton-watch", dir)).toBe(Bun.resolveSync("./src/index.ts", dir));
    expect(Bun.resolveSync("ton-watch/toncenter", dir)).toBe(
      Bun.resolveSync("./src/plugins/toncenter/index.ts", dir),
    );
    expect(await Bun.file(Bun.resolveSync(`./${pkg.bin["ton-watch"]}`, dir)).exists()).toBe(true);
  });

  test("the package entry is the same module as src/index.ts", async () => {
    const [byName, byPath] = await Promise.all([import("ton-watch"), import("../src/index")]);
    expect(byName.TonWatch).toBe(byPath.TonWatch);
  });

  test("internal paths are not exported", () => {
    const dir = `${import.meta.dir}/..`;
    expect(() => Bun.resolveSync("ton-watch/src/service/cli", dir)).toThrow();
  });
});
