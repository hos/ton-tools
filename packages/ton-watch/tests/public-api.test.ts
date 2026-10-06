/**
 * Guards the public surface: adding is a conscious choice, removing or renaming is
 * a breaking change. Runtime exports are checked here; types are checked by the
 * declaration snapshot in `api-snapshot.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import pkg from "../package.json";

const RUNTIME_EXPORTS = [
  "ConsumerLockedError",
  "CursorConflictError",
  "LiteSource",
  "MemoryStore",
  "Metrics",
  "MigrationError",
  "PgStore",
  "SourceError",
  "TonWatch",
  "TonWatchError",
  "consoleLogger",
  "isTonWatchError",
  "silentLogger",
  "toRawAddress",
];

const ADVANCED_EXPORTS = [
  "Consumer",
  "Indexer",
  "analyzeChain",
  "classifyError",
  "recordFromCell",
  "validatePage",
];

describe("public API", () => {
  test("ton-watch exports exactly these runtime names", async () => {
    const api = await import("ton-watch");
    expect(Object.keys(api).sort()).toEqual(RUNTIME_EXPORTS);
  });

  test("ton-watch/advanced exports the building blocks", async () => {
    const advanced = await import("ton-watch/advanced");
    expect(Object.keys(advanced).sort()).toEqual(ADVANCED_EXPORTS);
  });

  test("internal helpers are exported from no entry point", async () => {
    const entries = await Promise.all([import("ton-watch"), import("ton-watch/advanced")]);
    const names = entries.flatMap((entry) => Object.keys(entry));
    for (const internal of [
      "ServerPool",
      "serverPoolOf",
      "poolDatabase",
      "toIndexedTx",
      "txIdEquals",
      "completeUpTo",
    ]) {
      expect(names).not.toContain(internal);
    }
  });

  test("ton-watch/toncenter exports only the plug-in", async () => {
    const toncenter = await import("ton-watch/toncenter");
    expect(Object.keys(toncenter).sort()).toEqual(["ToncenterHistory"]);
    expect(typeof toncenter.ToncenterHistory).toBe("function");
  });

  test("ton-watch/parse exports the transaction parsers", async () => {
    const parse = await import("ton-watch/parse");
    expect(Object.keys(parse).sort()).toEqual([
      "Op",
      "incomingJettonTransfer",
      "incomingPayment",
      "parseMessage",
      "parseMessageBody",
      "parseTransaction",
    ]);
  });

  test("ton-watch/webhook exports the receiver side: headers, signature check, payload version", async () => {
    const webhook = await import("ton-watch/webhook");
    expect(Object.keys(webhook).sort()).toEqual([
      "DEFAULT_TOLERANCE_SECONDS",
      "EVENT_HEADER",
      "IDEMPOTENCY_HEADER",
      "REPLAY_HEADER",
      "SIGNATURE_HEADER",
      "WEBHOOK_PAYLOAD_VERSION",
      "verifySignature",
    ]);
    expect(webhook.SIGNATURE_HEADER).toBe("ton-watch-signature");
    expect(webhook.EVENT_HEADER).toBe("ton-watch-event");
    expect(webhook.WEBHOOK_PAYLOAD_VERSION).toBe(1);
  });

  test("the main entry does not pull in the toncenter plug-in", async () => {
    const api = await import("ton-watch");
    expect(Object.keys(api)).not.toContain("ToncenterHistory");
  });

  test("package entry points resolve to the source modules", async () => {
    expect(pkg.exports).toEqual({
      ".": "./src/index.ts",
      "./advanced": "./src/advanced.ts",
      "./toncenter": "./src/plugins/toncenter/index.ts",
      "./parse": "./src/parse/index.ts",
      "./webhook": "./src/webhook/index.ts",
      "./package.json": "./package.json",
    });
    expect(pkg.main).toBe("src/index.ts");
    expect(pkg.module).toBe("src/index.ts");
    const dir = `${import.meta.dir}/..`;
    expect(Bun.resolveSync("ton-watch", dir)).toBe(Bun.resolveSync("./src/index.ts", dir));
    expect(Bun.resolveSync("ton-watch/advanced", dir)).toBe(
      Bun.resolveSync("./src/advanced.ts", dir),
    );
    expect(Bun.resolveSync("ton-watch/toncenter", dir)).toBe(
      Bun.resolveSync("./src/plugins/toncenter/index.ts", dir),
    );
    expect(Bun.resolveSync("ton-watch/parse", dir)).toBe(
      Bun.resolveSync("./src/parse/index.ts", dir),
    );
    expect(Bun.resolveSync("ton-watch/webhook", dir)).toBe(
      Bun.resolveSync("./src/webhook/index.ts", dir),
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
