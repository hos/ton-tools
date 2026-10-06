import { describe, expect, test } from "bun:test";

import { classifyError, type ErrorKind, errorMessage } from "../../src/core/errors";

describe("error classification", () => {
  test.each([
    ["LITE_SERVER_UNKNOWN: too many requests", "rate_limit"],
    ["cannot locate transaction in block with specified logical time", "archive_unavailable"],
    [
      "block (0,8000000000000000,1) is not in db (possibly out of sync: shard_client_seqno=1)",
      "not_ready",
    ],
    ["Timeout", "timeout"],
    ["Engine is closed", "network"],
    ["something else", "unknown"],
  ])("%s → %s", (msg, kind) => {
    expect(classifyError(new Error(msg))).toBe(kind as ErrorKind);
  });
});

describe("errorMessage", () => {
  test("messages, plain objects and other values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage({ message: "plain" })).toBe("plain");
    expect(errorMessage("text")).toBe("text");
    expect(errorMessage(null)).toBe("null");
  });

  test("an empty AggregateError lists its distinct inner messages", () => {
    const refused = (host: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${host}:5432`), { code: "ECONNREFUSED" });
    const error = new AggregateError([refused("::1"), refused("127.0.0.1"), refused("::1")]);
    expect(errorMessage(error)).toBe(
      "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432",
    );
  });

  test("an empty message falls back to the error code", () => {
    expect(errorMessage(Object.assign(new Error(""), { code: "ECONNRESET" }))).toBe("ECONNRESET");
  });
});
