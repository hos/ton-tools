/**
 * Runs a `TonWatch` over a `LiteSource`, closes it and prints `closed`; nothing else
 * may keep the process alive afterwards. Spawned by tests that time the exit.
 *
 * - `LITESERVERS`: JSON `LsConfig[]` (default: the mainnet global config).
 * - `ADDRESS`: address to index from its earliest transaction.
 * - `RUN_MS`: how long to index before closing.
 * - `EXPECT_CONNECT_FAILURE=1`: only `LiteSource.connect()`, which must fail.
 */
import type { LsConfig } from "@ton/ls";
import { LiteSource, MemoryStore, TonWatch } from "../../../src/index";
import { silentLogger } from "../../../src/util/logger";

const servers = process.env.LITESERVERS
  ? (JSON.parse(process.env.LITESERVERS) as LsConfig[])
  : "mainnet";
const address = process.env.ADDRESS ?? "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";
const runMs = Number(process.env.RUN_MS ?? 1_000);

if (process.env.EXPECT_CONNECT_FAILURE === "1") {
  const error = await LiteSource.connect({ servers, connectTimeoutMs: 300 }).then(
    () => null,
    (e: unknown) => e,
  );
  if (!error) throw new Error("connect() was expected to fail");
} else {
  const source = await LiteSource.connect({ servers, timeoutMs: 1_000, maxAttempts: 2 });
  const watch = new TonWatch({ store: new MemoryStore(), source, logger: silentLogger });
  await watch.addAddress(address, { from: "earliest" });
  await watch.start();
  await new Promise((resolve) => setTimeout(resolve, runMs));
  await watch.close();
}
console.log("closed");
