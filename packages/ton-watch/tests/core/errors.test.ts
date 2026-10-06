import { describe, expect, test } from "bun:test";

import { classifyError, type ErrorKind } from "../../src/core/errors";

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
