/**
 * Runs `filterLiteServers()` over the `LITESERVERS` env var (JSON `LsConfig[]`) with
 * `TIMEOUT_MS`, prints the counts as one JSON line, then must exit on its own:
 * nothing may keep the process alive. Spawned by filter-exit.test.ts.
 */
import { filterLiteServers, type LsConfig } from "../../src/index.ts";

const servers = JSON.parse(process.env.LITESERVERS ?? "[]") as LsConfig[];
const result = await filterLiteServers(servers, { timeout: Number(process.env.TIMEOUT_MS) });
console.log(
  JSON.stringify({
    good: result.good.map((s) => s.lsConfig.port),
    fulfilled: result.fulfilled.length,
    rejected: result.rejected.length,
    successCount: result.good[0]?.successCount ?? 0,
    seqno: result.good[0]?.seqnos[0] ?? null,
  }),
);
