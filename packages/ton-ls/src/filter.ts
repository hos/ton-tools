import { LiteSingleEngine, LiteClient } from "ton-lite-client";
import { intToIP } from "./ip.ts";
import { delay } from "./delay.ts";

/**
 * Represents a server definition.
 * - Array of LiteServer configs.
 * - "mainnet" to get servers from the mainnet network config. [Mainnet Network Config](https://ton.org/global.config.json)
 * - "testnet" to get servers from the testnet network config. [Testnet Network Config](https://ton.org/testnet-global.config.json)
 * - URL to get servers from a custom network config.
 */
export type ServerDefinition =
  | LsConfig[]
  | "mainnet"
  | "testnet"
  | `https://${string}`
  | `http://${string}`;

/**
 * Represents a LiteServer config as it comes from the network config.
 * @param ip - The IP address of the LiteServer.
 * @param port - The port of the LiteServer.
 * @param id - The ID of the LiteServer.
 * @param id.key - The public key of the LiteServer (base64).
 */
export interface LsConfig {
  ip: number;
  port: number;
  id: {
    key: string;
  };
}

/**
 * Represents a LiteServer config with host and publicKey, ready to be used by LiteClient.
 */
export interface LsConfigResolved extends LsConfig {
  host: string;
  publicKey: Buffer;
}

/**
 * Represents the benchmark description of a LiteServer.
 */
export interface ServerBenchmark {
  fulfilled: boolean;
  successCount: number;
  errorCount: number;
  timings: number[];
  seqnos: number[];
  readyIn?: number;
  avgTiming: number;
}

/**
 * Represents the state of a LiteServer config with benchmark information.
 */
export interface LiteServerConfigState extends ServerBenchmark {
  lsConfig: LsConfigResolved;
}

/**
 * Represents the options for filtering LiteServers.
 * @param timeout - The timeout value for the benchmark, benchmark will end after this time and only the results until then will be considered.
 * @param divergeFromAvg - Milliseconds, if provided "fast" will only contain server that are at most this value away from the average.
 */
export interface FilterLiteServersOptions {
  timeout?: number;
  divergeFromAvg?: number;
  verbosity?: "info";
}

/**
 * Represents the return value of the `filterLiteServers` function.
 * @param fast - The LiteServers that are faster than the average.
 * @param good - The LiteServers that have a successCount greater than 1.
 * @param fulfilled - The LiteServers that were completed benchmarked, this doesn't mean they are good or fast,
 * or even the server was live, it just means the benchmark was completed.
 * @param rejected - The LiteServers that failed to be benchmarked, because of some unexpected error.
 * @param fastAvg - The average timing of the fast LiteServers.
 * @param goodAvg - The average timing of the good LiteServers.
 */
export interface BenchmarkLiteServersReturn {
  fast: LiteServerConfigState[];
  good: LiteServerConfigState[];
  fulfilled: LiteServerConfigState[];
  rejected: unknown[];
  fastAvg: number;
  goodAvg: number;
}

/**
 * Fetches the LiteServers based on the provided server definition.
 * @param servers - The server definition.
 * @returns A promise that resolves to an array of LiteServer configs.
 * @throws {Error} If the servers are invalid.
 */
export async function getServers(
  servers: ServerDefinition
): Promise<LsConfig[] | never> {
  if (Array.isArray(servers)) {
    return servers;
  }

  if (servers === "mainnet") {
    return fetch("https://ton.org/global.config.json")
      .then((r) => r.json())
      .then((data) => data.liteservers as LsConfig[]);
  }

  if (servers === "testnet") {
    return fetch("https://ton.org/testnet-global.config.json")
      .then((r) => r.json())
      .then((data) => data.liteservers as LsConfig[]);
  }

  if (typeof servers === "string") {
    return fetch(servers)
      .then((r) => r.json())
      .then((data) => data.liteservers as LsConfig[]);
  }

  throw new Error("Invalid servers");
}

/**
 * Filters the LiteServers based on the provided server definition and options.
 * @param serversNetworkUrl - The server definition - list, network name or URL.
 * @param options - The filtering options.
 * @returns A promise that resolves to the filtered LiteServers.
 */
export async function filterLiteServers(
  serversOrNetwork: ServerDefinition,
  options?: FilterLiteServersOptions
): Promise<BenchmarkLiteServersReturn> {
  const { timeout = 3000, divergeFromAvg, verbosity } = options || {};

  const servers = await getServers(serversOrNetwork);

  const results = await Promise.allSettled(
    servers.map(async (ls) => {
      const enhanced = {
        ...ls,
        host: `tcp://${intToIP(ls.ip)}:${ls.port}`,
        publicKey: Buffer.from(ls.id.key, "base64"),
      };

      const testResult = await benchmark(enhanced, timeout);

      const res: LiteServerConfigState = { lsConfig: enhanced, ...testResult };
      return res;
    })
  );

  const fulfilled = results
    .map((p) => (p.status === "fulfilled" ? p.value : []))
    .flat() as LiteServerConfigState[];

  const rejected = results
    .map((p) => (p.status === "rejected" ? p.reason : []))
    .flat();

  const good = fulfilled.filter((c) => c.successCount > 0);

  const goodAvg =
    good.reduce((total, c) => total + c.avgTiming, 0) / good.length;
  const fast = divergeFromAvg
    ? good.filter((c) => c.avgTiming <= goodAvg + divergeFromAvg)
    : good;
  const fastAvg =
    fast.reduce((total, c) => total + c.avgTiming, 0) / fast.length;

  if (verbosity === "info") {
    const table = fast.map((server) => ({
      host: server.lsConfig.host.replace("tcp://", ""),
      success: server.successCount,
      error: server.errorCount,
      avgTiming: server.avgTiming.toPrecision(2),
      diff: (server.avgTiming - fastAvg).toPrecision(2),
    }));

    const bySuccessCount = table.sort((a, b) => b.success - a.success);
    if (table.length > 0) {
      console.table(bySuccessCount);
    } else {
      console.warn("No servers found, or all servers failed.");
    }
  }

  return { fast, good, fulfilled, rejected, fastAvg, goodAvg };
}

/**
 * Performs benchmarking on the provided LiteServer.
 * @param ls - The LiteServer config.
 * @param timeout - The timeout value for the benchmark.
 * @returns A promise that resolves to the benchmark result.
 */
export async function benchmark(
  ls: LsConfigResolved,
  timeout: number
): Promise<ServerBenchmark> {
  return new Promise<ServerBenchmark>(async (resolve) => {
    const benchmarkStart = Date.now();
    const state: ServerBenchmark = {
      fulfilled: false,
      successCount: 0,
      errorCount: 0,
      timings: [] as number[],
      seqnos: [] as number[],
      avgTiming: 0,
    };

    setTimeout(() => {
      const avgTiming = state.timings.reduce((acc, curr) => acc + curr, 0);
      if (!state.fulfilled) {
        resolve({
          ...state,
          avgTiming: avgTiming / state.timings.length,
        });
      }
      state.fulfilled = true;
    }, timeout);

    const engine = new LiteSingleEngine({
      host: ls.host,
      publicKey: ls.publicKey,
    });

    engine.on("error", () => {});
    const lc = new LiteClient({ engine });

    for (let i = 0; i < 100; i++) {
      if (state.fulfilled) {
        return;
      }
      try {
        if (!lc.engine.isReady()) {
          state.errorCount++;
          await delay(100);
          continue;
        }

        const start = Date.now();
        state.readyIn = state.readyIn || Date.now() - benchmarkStart;
        const date = await lc.getMasterchainInfo();

        state.seqnos.push(date.last.seqno);
        state.successCount++;

        state.timings.push(Date.now() - start);
      } catch (e) {
        state.errorCount++;

        if (e instanceof Error && e.message.includes("Engine is closed")) {
          await delay(100);
          continue;
        }
      }
    }

    const avgTiming = state.timings.reduce((acc, curr) => acc + curr, 0);

    state.fulfilled = true;

    resolve({
      ...state,
      avgTiming: avgTiming / state.timings.length,
    });
  });
}
