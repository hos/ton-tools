import { describe, expect, test } from "bun:test";
import { Address } from "@ton/core";

import { configFromEnv } from "../../../src/service/config";
import { webhooksFromEnv } from "../../../src/service/webhook/config";

const A = "0:0000000000000000000000000000000000000000000000000000000000000001";
const A_FRIENDLY = Address.parse(A).toString();

const defaults = {
  secret: null,
  addresses: null,
  order: "address",
  from: "start",
  timeoutMs: 10_000,
  retryMinMs: 1_000,
  retryMaxMs: 60_000,
  onError: "retry",
  maxAttempts: 5,
};

describe("webhooksFromEnv", () => {
  test("none configured", () => {
    expect(webhooksFromEnv({})).toEqual([]);
  });

  test("TON_WATCH_WEBHOOK_URL is one target named default, with defaults", () => {
    expect(webhooksFromEnv({ TON_WATCH_WEBHOOK_URL: "https://example.com/hook" })).toEqual([
      { ...defaults, name: "default", url: "https://example.com/hook" } as never,
    ]);
  });

  test("TON_WATCH_WEBHOOK_* variables set the defaults of every target", () => {
    const [target] = webhooksFromEnv({
      TON_WATCH_WEBHOOK_URL: "http://localhost:8080/",
      TON_WATCH_WEBHOOK_SECRET: "s3cret",
      TON_WATCH_WEBHOOK_ORDER: "global",
      TON_WATCH_WEBHOOK_FROM: "now",
      TON_WATCH_WEBHOOK_TIMEOUT_MS: "2500",
      TON_WATCH_WEBHOOK_RETRY_MIN_MS: "100",
      TON_WATCH_WEBHOOK_RETRY_MAX_MS: "5000",
      TON_WATCH_WEBHOOK_ON_ERROR: "dead-letter",
      TON_WATCH_WEBHOOK_MAX_ATTEMPTS: "3",
    });
    expect(target).toMatchObject({
      secret: "s3cret",
      order: "global",
      from: "now",
      timeoutMs: 2500,
      retryMinMs: 100,
      retryMaxMs: 5000,
      onError: "dead-letter",
      maxAttempts: 3,
    });
    expect(
      webhooksFromEnv({ TON_WATCH_WEBHOOK_URL: "http://h/", TON_WATCH_WEBHOOK_FROM: "42" }),
    ).toMatchObject([{ from: 42n }]);
  });

  test("TON_WATCH_WEBHOOKS: named targets with per-target overrides and raw addresses", () => {
    const targets = webhooksFromEnv({
      TON_WATCH_WEBHOOK_URL: "https://a.example/",
      TON_WATCH_WEBHOOK_SECRET: "shared",
      TON_WATCH_WEBHOOKS: JSON.stringify([
        { name: "billing", url: "https://b.example/in", addresses: [A_FRIENDLY], order: "global" },
        { name: "audit.v2", url: "https://c.example/", secret: "own", from: "now", timeoutMs: 50 },
      ]),
    });
    expect(
      targets.map((t) => [t.name, t.secret, t.addresses, t.order, t.from, t.timeoutMs]),
    ).toEqual([
      ["default", "shared", null, "address", "start", 10_000],
      ["billing", "shared", [A], "global", "start", 10_000],
      ["audit.v2", "own", null, "address", "now", 50],
    ]);
  });

  test("a TON_WATCH_WEBHOOKS entry overrides the failure policy", () => {
    const targets = webhooksFromEnv({
      TON_WATCH_WEBHOOK_ON_ERROR: "skip",
      TON_WATCH_WEBHOOK_MAX_ATTEMPTS: "7",
      TON_WATCH_WEBHOOKS: JSON.stringify([
        { name: "a", url: "http://h/" },
        { name: "b", url: "http://h/", onError: "dead-letter", maxAttempts: 2 },
        { name: "c", url: "http://h/", onError: "retry" },
      ]),
    });
    expect(targets.map((t) => [t.name, t.onError, t.maxAttempts])).toEqual([
      ["a", "skip", 7],
      ["b", "dead-letter", 2],
      ["c", "retry", 7],
    ]);
  });

  test.each([
    ["TON_WATCH_WEBHOOK_ON_ERROR", "ignore", "invalid TON_WATCH_WEBHOOK_ON_ERROR: ignore"],
    ["TON_WATCH_WEBHOOK_MAX_ATTEMPTS", "0", "invalid TON_WATCH_WEBHOOK_MAX_ATTEMPTS: 0"],
    ["TON_WATCH_WEBHOOK_MAX_ATTEMPTS", "2.5", "invalid TON_WATCH_WEBHOOK_MAX_ATTEMPTS: 2.5"],
    ["TON_WATCH_WEBHOOK_URL", "not a url", "invalid TON_WATCH_WEBHOOK_URL: not a URL"],
    ["TON_WATCH_WEBHOOK_URL", "ftp://x/", "only http and https URLs are supported"],
    ["TON_WATCH_WEBHOOK_ORDER", "random", "invalid TON_WATCH_WEBHOOK_ORDER: random"],
    ["TON_WATCH_WEBHOOK_FROM", "genesis", "invalid TON_WATCH_WEBHOOK_FROM: genesis"],
    ["TON_WATCH_WEBHOOK_TIMEOUT_MS", "0", "invalid TON_WATCH_WEBHOOK_TIMEOUT_MS: 0"],
    ["TON_WATCH_WEBHOOKS", "{", "invalid TON_WATCH_WEBHOOKS: not JSON"],
    ["TON_WATCH_WEBHOOKS", "{}", "invalid TON_WATCH_WEBHOOKS: expected an array"],
  ])("%s=%p is rejected", (name, value, message) => {
    expect(() => webhooksFromEnv({ TON_WATCH_WEBHOOK_URL: "http://h/", [name]: value })).toThrow(
      message,
    );
  });

  test.each([
    [[1], "TON_WATCH_WEBHOOKS[0]: expected an object"],
    [[{ url: "http://h/" }], "TON_WATCH_WEBHOOKS[0].name: required"],
    [[{ name: "a b", url: "http://h/" }], "TON_WATCH_WEBHOOKS[0].name"],
    [[{ name: "a" }], "TON_WATCH_WEBHOOKS[0].url: required"],
    [[{ name: "a", url: 5 }], "TON_WATCH_WEBHOOKS[0].url: expected a string"],
    [[{ name: "a", url: "http://h/", extra: 1 }], 'unknown key "extra"'],
    [[{ name: "a", url: "http://h/", addresses: [] }], "expected a non-empty array"],
    [[{ name: "a", url: "http://h/", addresses: ["nope"] }], "nope is not an address"],
    [[{ name: "a", url: "http://h/", order: "lt" }], "invalid TON_WATCH_WEBHOOKS[0].order: lt"],
    [[{ name: "a", url: "http://h/", timeoutMs: "5" }], "TON_WATCH_WEBHOOKS[0].timeoutMs"],
    [[{ name: "a", url: "http://h/", retryMinMs: 0 }], "TON_WATCH_WEBHOOKS[0].retryMinMs"],
    [[{ name: "a", url: "http://h/", onError: "drop" }], "invalid TON_WATCH_WEBHOOKS[0].onError"],
    [[{ name: "a", url: "http://h/", maxAttempts: 0 }], "TON_WATCH_WEBHOOKS[0].maxAttempts"],
    [[{ name: "a", url: "http://h/", maxAttempts: "3" }], "TON_WATCH_WEBHOOKS[0].maxAttempts"],
    [
      [
        { name: "a", url: "http://h/" },
        { name: "a", url: "http://i/" },
      ],
      "duplicate webhook name: a",
    ],
  ])("TON_WATCH_WEBHOOKS=%j is rejected", (entries, message) => {
    expect(() => webhooksFromEnv({ TON_WATCH_WEBHOOKS: JSON.stringify(entries) })).toThrow(message);
  });

  test("a JSON target named default collides with TON_WATCH_WEBHOOK_URL", () => {
    expect(() =>
      webhooksFromEnv({
        TON_WATCH_WEBHOOK_URL: "http://h/",
        TON_WATCH_WEBHOOKS: JSON.stringify([{ name: "default", url: "http://i/" }]),
      }),
    ).toThrow("duplicate webhook name: default");
  });

  test("the URL is not echoed in errors (it may carry a token)", () => {
    expect(() => webhooksFromEnv({ TON_WATCH_WEBHOOK_URL: "token-abc" })).not.toThrow(/token-abc/);
  });

  test("configFromEnv includes them; empty variables are unset", () => {
    const base = { DATABASE_URL: "postgres://x" };
    expect(configFromEnv({ ...base, TON_WATCH_WEBHOOK_URL: "http://h/" }).webhooks).toHaveLength(1);
    expect(
      configFromEnv({ ...base, TON_WATCH_WEBHOOK_URL: "", TON_WATCH_WEBHOOKS: "" }).webhooks,
    ).toEqual([]);
  });
});
