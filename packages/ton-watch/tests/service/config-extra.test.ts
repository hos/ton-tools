import { describe, expect, test } from "bun:test";

import { configFromEnv, logLevelFromEnv, parseFrom } from "../../src/service/config";
import { ENV_VARS } from "../../src/service/env";

const base = { TON_WATCH_DATABASE_URL: "postgres://user@host/db" };
const A = "0:0000000000000000000000000000000000000000000000000000000000000001";
const B = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const B_RAW = "0:0000000000000000000000000000000000000000000000000000000000000000";

describe("configFromEnv defaults", () => {
  test("only TON_WATCH_DATABASE_URL set", () => {
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
      addressMetrics: false,
      history: null,
      webhooks: [],
    });
  });

  test("every variable empty is the same as unset", () => {
    const empty = Object.fromEntries(
      ENV_VARS.filter(({ name }) => !name.endsWith("DATABASE_URL")).map(({ name }) => [name, ""]),
    );
    expect(configFromEnv({ ...base, ...empty })).toEqual(configFromEnv(base));
  });

  test("undefined values are unset too", () => {
    expect(
      configFromEnv({ ...base, TON_WATCH_PORT: undefined, TON_WATCH_NETWORK: undefined }),
    ).toEqual(configFromEnv(base));
  });

  test("unrelated variables are ignored", () => {
    expect(configFromEnv({ ...base, PATH: "/bin", HOME: "/root" })).toEqual(configFromEnv(base));
  });
});

describe("configFromEnv values", () => {
  test("the database URL empty or missing is an error", () => {
    const message = "TON_WATCH_DATABASE_URL (or DATABASE_URL) is required";
    expect(() => configFromEnv({ TON_WATCH_DATABASE_URL: "" })).toThrow(message);
    expect(() => configFromEnv({ DATABASE_URL: undefined })).toThrow(message);
  });

  test("DATABASE_URL is the fallback for TON_WATCH_DATABASE_URL", () => {
    expect(configFromEnv({ DATABASE_URL: "postgres://a" }).databaseUrl).toBe("postgres://a");
    expect(
      configFromEnv({ DATABASE_URL: "postgres://a", TON_WATCH_DATABASE_URL: "postgres://b" })
        .databaseUrl,
    ).toBe("postgres://b");
    expect(
      configFromEnv({ DATABASE_URL: "postgres://a", TON_WATCH_DATABASE_URL: "" }).databaseUrl,
    ).toBe("postgres://a");
  });

  test("schema, network and archive network pass through", () => {
    const config = configFromEnv({
      ...base,
      TON_WATCH_SCHEMA: "indexer",
      TON_WATCH_NETWORK: "testnet",
      TON_WATCH_ARCHIVE_NETWORK: "https://example.org/archive.json",
    });
    expect(config.schema).toBe("indexer");
    expect(config.network).toBe("testnet");
    expect(config.archiveNetwork).toBe("https://example.org/archive.json");
  });

  test("the old unprefixed names are not read", () => {
    const old = configFromEnv({
      ...base,
      TON_NETWORK: "testnet",
      TON_NETWORK_CONFIG_URL: "https://x/c.json",
      TON_ARCHIVE_CONFIG: "https://x/a.json",
      TONCENTER_API_KEY: "k",
      TON_WATCH_HISTORY: "toncenter",
    });
    expect(old.network).toBe("mainnet");
    expect(old.archiveNetwork).toBeUndefined();
    expect(old.history?.apiKey).toBeUndefined();
  });

  test("TON_WATCH_ADDRESS_METRICS is true or false", () => {
    expect(configFromEnv({ ...base, TON_WATCH_ADDRESS_METRICS: "true" }).addressMetrics).toBe(true);
    expect(configFromEnv({ ...base, TON_WATCH_ADDRESS_METRICS: "false" }).addressMetrics).toBe(
      false,
    );
    expect(() => configFromEnv({ ...base, TON_WATCH_ADDRESS_METRICS: "yes" })).toThrow(
      "invalid TON_WATCH_ADDRESS_METRICS: yes (true | false)",
    );
  });

  test("numbers", () => {
    const config = configFromEnv({ ...base, TON_WATCH_PORT: "8080", TON_WATCH_CONCURRENCY: "4" });
    expect(config.port).toBe(8080);
    expect(config.concurrency).toBe(4);
    expect(configFromEnv({ ...base, TON_WATCH_PORT: "0" }).port).toBe(0);
  });

  test("non-numeric or out-of-range numbers are rejected", () => {
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

  test("logLevelFromEnv does not need a database URL", () => {
    expect(logLevelFromEnv({ TON_WATCH_LOG: "warn" })).toBe("warn");
  });
});

describe("toncenter history config", () => {
  test("off unless TON_WATCH_HISTORY=toncenter", () => {
    expect(configFromEnv({ ...base, TON_WATCH_HISTORY_MODE: "boost" }).history).toBeNull();
    expect(configFromEnv({ ...base, TON_WATCH_TONCENTER_API_KEY: "k" }).history).toBeNull();
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
        TON_WATCH_TONCENTER_API_KEY: "secret",
        TON_WATCH_TONCENTER_ENDPOINT: "http://localhost:8081/api/v2",
      }).history,
    ).toEqual({ mode: "boost", apiKey: "secret", endpoint: "http://localhost:8081/api/v2" });
  });

  test("invalid mode is rejected only when the plug-in is on", () => {
    expect(() =>
      configFromEnv({ ...base, TON_WATCH_HISTORY: "toncenter", TON_WATCH_HISTORY_MODE: "turbo" }),
    ).toThrow("invalid TON_WATCH_HISTORY_MODE: turbo (fallback | boost)");
    expect(configFromEnv({ ...base, TON_WATCH_HISTORY_MODE: "turbo" }).history).toBeNull();
  });

  test("an unknown history source is rejected", () => {
    expect(() => configFromEnv({ ...base, TON_WATCH_HISTORY: "tonapi" })).toThrow(
      "invalid TON_WATCH_HISTORY: tonapi (toncenter)",
    );
  });
});

describe("TON_WATCH_ADDRESSES", () => {
  test("comma-separated, trimmed, empty entries skipped, default from now", () => {
    expect(
      configFromEnv({ ...base, TON_WATCH_ADDRESSES: ` ${A} ,, ${B}@earliest ,${A}@12345, ` })
        .addresses,
    ).toEqual([
      { address: A, from: "now" },
      { address: B_RAW, from: "earliest" },
      { address: A, from: 12345n },
    ]);
  });

  test("addresses come out raw; `@now` and a trailing `@` mean now", () => {
    expect(configFromEnv({ ...base, TON_WATCH_ADDRESSES: `${A}@now,${B}@` }).addresses).toEqual([
      { address: A, from: "now" },
      { address: B_RAW, from: "now" },
    ]);
  });

  test("an invalid address fails the whole config", () => {
    for (const [list, bad] of [
      [`${A},nope`, "nope"],
      [`${A},@earliest`, "(empty)"],
      [`${B.slice(0, -1)}x@now`, `${B.slice(0, -1)}x`],
    ]) {
      expect(() => configFromEnv({ ...base, TON_WATCH_ADDRESSES: list })).toThrow(
        `invalid TON_WATCH_ADDRESSES: ${bad} is not an address`,
      );
    }
  });

  test("only separators means no addresses", () => {
    expect(configFromEnv({ ...base, TON_WATCH_ADDRESSES: " , ,," }).addresses).toEqual([]);
  });

  test("an invalid from fails the whole config", () => {
    expect(() => configFromEnv({ ...base, TON_WATCH_ADDRESSES: `${A}@yesterday` })).toThrow(
      "invalid --from value: yesterday (now | earliest | <lt>)",
    );
  });
});

describe("parseFrom", () => {
  test("now, earliest and lts", () => {
    expect(parseFrom(undefined)).toBe("now");
    expect(parseFrom("")).toBe("now");
    expect(parseFrom("now")).toBe("now");
    expect(parseFrom("earliest")).toBe("earliest");
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
        `invalid --from value: ${value} (now | earliest | <lt>)`,
      );
    }
  });
});
