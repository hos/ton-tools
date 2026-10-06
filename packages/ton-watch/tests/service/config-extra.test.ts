import { describe, expect, test } from "bun:test";

import { configFromEnv, logLevelFromEnv, parseFrom } from "../../src/service/config";

const base = { DATABASE_URL: "postgres://user@host/db" };
const A = "0:0000000000000000000000000000000000000000000000000000000000000001";
const B = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

describe("configFromEnv defaults", () => {
  test("only DATABASE_URL set", () => {
    expect(configFromEnv(base)).toEqual({
      databaseUrl: "postgres://user@host/db",
      schema: undefined,
      network: "mainnet",
      archiveNetwork: undefined,
      addresses: [],
      port: 9464,
      concurrency: 16,
      detect: "auto",
      logLevel: "info",
      history: null,
    });
  });

  test("every variable empty is the same as unset", () => {
    const empty = Object.fromEntries(
      [
        "TON_WATCH_SCHEMA",
        "TON_NETWORK",
        "TON_NETWORK_CONFIG_URL",
        "TON_ARCHIVE_CONFIG",
        "TON_WATCH_ADDRESSES",
        "TON_WATCH_PORT",
        "TON_WATCH_CONCURRENCY",
        "TON_WATCH_DETECT",
        "TON_WATCH_LOG",
        "TON_WATCH_HISTORY",
        "TON_WATCH_HISTORY_MODE",
        "TONCENTER_API_KEY",
        "TONCENTER_ENDPOINT",
      ].map((name) => [name, ""]),
    );
    expect(configFromEnv({ ...base, ...empty })).toEqual(configFromEnv(base));
  });

  test("undefined values are unset too", () => {
    expect(configFromEnv({ ...base, TON_WATCH_PORT: undefined, TON_NETWORK: undefined })).toEqual(
      configFromEnv(base),
    );
  });

  test("unrelated variables are ignored", () => {
    expect(configFromEnv({ ...base, PATH: "/bin", HOME: "/root" })).toEqual(configFromEnv(base));
  });
});

describe("configFromEnv values", () => {
  test("DATABASE_URL empty or missing is an error", () => {
    expect(() => configFromEnv({ DATABASE_URL: "" })).toThrow("DATABASE_URL is required");
    expect(() => configFromEnv({ DATABASE_URL: undefined })).toThrow("DATABASE_URL is required");
  });

  test("schema and archive config pass through", () => {
    const config = configFromEnv({
      ...base,
      TON_WATCH_SCHEMA: "indexer",
      TON_ARCHIVE_CONFIG: "https://example.org/archive.json",
    });
    expect(config.schema).toBe("indexer");
    expect(config.archiveNetwork).toBe("https://example.org/archive.json");
  });

  test("TON_NETWORK wins over its TON_NETWORK_CONFIG_URL alias", () => {
    expect(configFromEnv({ ...base, TON_NETWORK: "testnet" }).network).toBe("testnet");
    expect(configFromEnv({ ...base, TON_NETWORK_CONFIG_URL: "https://x/c.json" }).network).toBe(
      "https://x/c.json",
    );
    expect(
      configFromEnv({ ...base, TON_NETWORK: "testnet", TON_NETWORK_CONFIG_URL: "https://x" })
        .network,
    ).toBe("testnet");
    expect(
      configFromEnv({ ...base, TON_NETWORK: "", TON_NETWORK_CONFIG_URL: "https://x" }).network,
    ).toBe("https://x");
  });

  test("numbers", () => {
    const config = configFromEnv({ ...base, TON_WATCH_PORT: "8080", TON_WATCH_CONCURRENCY: "4" });
    expect(config.port).toBe(8080);
    expect(config.concurrency).toBe(4);
    expect(configFromEnv({ ...base, TON_WATCH_PORT: "0" }).port).toBe(0);
  });

  // BUG: TON_WATCH_PORT and TON_WATCH_CONCURRENCY go through bare `Number()` with no
  // validation. "abc" gives NaN: a NaN port silently disables the HTTP server
  // (`config.port > 0` is false) and a NaN/0/negative concurrency makes the walk
  // scheduler (`inFlight < concurrency`) and `mapConcurrent` never start any work,
  // so the service runs but indexes nothing.
  test.failing("non-numeric or out-of-range numbers are rejected", () => {
    expect(() => configFromEnv({ ...base, TON_WATCH_PORT: "abc" })).toThrow(/TON_WATCH_PORT/);
    expect(() => configFromEnv({ ...base, TON_WATCH_PORT: "70000" })).toThrow(/TON_WATCH_PORT/);
    expect(() => configFromEnv({ ...base, TON_WATCH_CONCURRENCY: "abc" })).toThrow(
      /TON_WATCH_CONCURRENCY/,
    );
    expect(() => configFromEnv({ ...base, TON_WATCH_CONCURRENCY: "0" })).toThrow(
      /TON_WATCH_CONCURRENCY/,
    );
    expect(() => configFromEnv({ ...base, TON_WATCH_CONCURRENCY: "1.5" })).toThrow(
      /TON_WATCH_CONCURRENCY/,
    );
  });

  test("detect modes", () => {
    for (const mode of ["poll", "blocks", "auto"] as const) {
      expect(configFromEnv({ ...base, TON_WATCH_DETECT: mode }).detect).toBe(mode);
    }
  });

  test("invalid detect mode names the variable and the options", () => {
    expect(() => configFromEnv({ ...base, TON_WATCH_DETECT: "sometimes" })).toThrow(
      "invalid TON_WATCH_DETECT: sometimes (poll | blocks | auto)",
    );
    expect(() => configFromEnv({ ...base, TON_WATCH_DETECT: "POLL" })).toThrow(
      "invalid TON_WATCH_DETECT",
    );
    expect(() => configFromEnv({ ...base, TON_WATCH_DETECT: " poll" })).toThrow(
      "invalid TON_WATCH_DETECT",
    );
  });

  test("log levels", () => {
    for (const level of ["debug", "info", "warn", "error", "silent"] as const) {
      expect(configFromEnv({ ...base, TON_WATCH_LOG: level }).logLevel).toBe(level);
      expect(logLevelFromEnv({ TON_WATCH_LOG: level })).toBe(level);
    }
    expect(logLevelFromEnv({})).toBe("info");
    expect(() => configFromEnv({ ...base, TON_WATCH_LOG: "loud" })).toThrow(
      "invalid TON_WATCH_LOG: loud",
    );
  });

  test("logLevelFromEnv does not need DATABASE_URL", () => {
    expect(logLevelFromEnv({ TON_WATCH_LOG: "warn" })).toBe("warn");
  });
});

describe("toncenter history config", () => {
  test("off unless TON_WATCH_HISTORY=toncenter", () => {
    expect(configFromEnv({ ...base, TON_WATCH_HISTORY_MODE: "boost" }).history).toBeNull();
    expect(configFromEnv({ ...base, TONCENTER_API_KEY: "k" }).history).toBeNull();
  });

  test("defaults to fallback without key or endpoint", () => {
    expect(configFromEnv({ ...base, TON_WATCH_HISTORY: "toncenter" }).history).toEqual({
      mode: "fallback",
      apiKey: undefined,
      endpoint: undefined,
    });
  });

  test("mode, key and endpoint pass through", () => {
    expect(
      configFromEnv({
        ...base,
        TON_WATCH_HISTORY: "toncenter",
        TON_WATCH_HISTORY_MODE: "boost",
        TONCENTER_API_KEY: "secret",
        TONCENTER_ENDPOINT: "http://localhost:8081/api/v2",
      }).history,
    ).toEqual({ mode: "boost", apiKey: "secret", endpoint: "http://localhost:8081/api/v2" });
  });

  test("invalid mode is rejected only when the plug-in is on", () => {
    expect(() =>
      configFromEnv({ ...base, TON_WATCH_HISTORY: "toncenter", TON_WATCH_HISTORY_MODE: "turbo" }),
    ).toThrow("invalid TON_WATCH_HISTORY_MODE: turbo (fallback | boost)");
    expect(configFromEnv({ ...base, TON_WATCH_HISTORY_MODE: "turbo" }).history).toBeNull();
  });
});

describe("TON_WATCH_ADDRESSES", () => {
  test("comma-separated, trimmed, empty entries skipped, default from now", () => {
    expect(
      configFromEnv({ ...base, TON_WATCH_ADDRESSES: ` ${A} ,, ${B}@genesis ,${A}@12345, ` })
        .addresses,
    ).toEqual([
      { address: A, from: "now" },
      { address: B, from: "genesis" },
      { address: A, from: 12345n },
    ]);
  });

  test("raw addresses keep their colon; `@now` and a trailing `@` mean now", () => {
    expect(configFromEnv({ ...base, TON_WATCH_ADDRESSES: `${A}@now,${B}@` }).addresses).toEqual([
      { address: A, from: "now" },
      { address: B, from: "now" },
    ]);
  });

  test("only separators means no addresses", () => {
    expect(configFromEnv({ ...base, TON_WATCH_ADDRESSES: " , ,," }).addresses).toEqual([]);
  });

  test("an invalid from fails the whole config", () => {
    expect(() => configFromEnv({ ...base, TON_WATCH_ADDRESSES: `${A}@yesterday` })).toThrow(
      "invalid --from value: yesterday (now | genesis | <lt>)",
    );
  });
});

describe("parseFrom", () => {
  test("now, genesis and lts", () => {
    expect(parseFrom(undefined)).toBe("now");
    expect(parseFrom("")).toBe("now");
    expect(parseFrom("now")).toBe("now");
    expect(parseFrom("genesis")).toBe("genesis");
    expect(parseFrom("0")).toBe(0n);
    expect(parseFrom("007")).toBe(7n);
    expect(parseFrom("18446744073709551615")).toBe(18446744073709551615n);
  });

  test("anything else is rejected with the accepted forms", () => {
    for (const value of [
      "-1",
      "1.5",
      "1e3",
      "0x10",
      " 5",
      "5 ",
      "5n",
      "NOW",
      "Genesis",
      "latest",
    ]) {
      expect(() => parseFrom(value)).toThrow(
        `invalid --from value: ${value} (now | genesis | <lt>)`,
      );
    }
  });
});
