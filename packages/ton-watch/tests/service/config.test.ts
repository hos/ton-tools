import { describe, expect, test } from "bun:test";

import { configFromEnv, logLevelFromEnv } from "../../src/service/config";

const base = { DATABASE_URL: "postgres://x" };

describe("service config", () => {
  test("empty variables mean unset, as compose/k8s often leave them", () => {
    const config = configFromEnv({
      ...base,
      TON_WATCH_DETECT: "",
      TON_WATCH_HISTORY: "toncenter",
      TON_WATCH_HISTORY_MODE: "",
      TON_WATCH_PORT: "",
    });
    expect(config.detect).toBe("auto");
    expect(config.history?.mode).toBe("fallback");
    expect(config.port).toBe(9464);
    expect(logLevelFromEnv({ TON_WATCH_LOG: "" })).toBe("info");
  });

  test("unknown values are rejected", () => {
    expect(() => configFromEnv({ ...base, TON_WATCH_DETECT: "sometimes" })).toThrow();
    expect(() => logLevelFromEnv({ TON_WATCH_LOG: "loud" })).toThrow();
  });

  test("DATABASE_URL is required", () => {
    expect(() => configFromEnv({})).toThrow(/DATABASE_URL/);
  });
});
