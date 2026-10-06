import { describe, expect, test } from "bun:test";

import { abbreviateAddress, toRawAddress, workchainOf } from "../../src/core/address";

const RAW = "0:584ee61b2dff0837116d0fcb5078d93964bcbe9c05fd6a141b1bfca5d6a43e18";
const ELECTOR = `-1:${"33".repeat(32)}`;

describe("toRawAddress", () => {
  test.each([
    ["raw", RAW],
    ["raw, uppercase hex", RAW.toUpperCase()],
    ["bounceable, url-safe", "EQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GEMS"],
    ["bounceable, standard base64", "EQBYTuYbLf8INxFtD8tQeNk5ZLy+nAX9ahQbG/yl1qQ+GEMS"],
    ["non-bounceable", "UQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GB7X"],
    ["testnet bounceable", "kQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GPiY"],
    ["testnet non-bounceable", "0QBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GKVd"],
  ])("%s normalizes to the same raw form", (_, input) => {
    expect(toRawAddress(input)).toBe(RAW);
  });

  test("masterchain addresses keep workchain -1", () => {
    expect(toRawAddress(ELECTOR.toUpperCase())).toBe(ELECTOR);
    expect(workchainOf(toRawAddress(ELECTOR))).toBe(-1);
  });

  test.each([
    ["empty", ""],
    ["non-hex account", "0:xyz"],
    ["63 hex digits", `0:${"a".repeat(63)}`],
    ["66 hex digits", `0:${"0".repeat(66)}`],
    ["bad checksum", "EQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GEMT"],
    ["truncated friendly", "EQBYTuYbLf8INxFtD8tQeNk5ZLy"],
    ["no workchain", "584ee61b2dff0837116d0fcb5078d93964bcbe9c05fd6a141b1bfca5d6a43e18"],
  ])("rejects %s", (_, input) => {
    expect(() => toRawAddress(input)).toThrow();
  });
});

describe("workchainOf", () => {
  test("reads the workchain of raw addresses", () => {
    expect(workchainOf(RAW)).toBe(0);
    expect(workchainOf(ELECTOR)).toBe(-1);
  });
});

describe("abbreviateAddress", () => {
  test("keeps the first and last four characters", () => {
    expect(abbreviateAddress(RAW)).toBe("0:58...3e18");
    expect(abbreviateAddress(ELECTOR)).toBe("-1:3...3333");
  });

  test("short inputs do not throw", () => {
    expect(abbreviateAddress("abc")).toBe("abc...abc");
    expect(abbreviateAddress("")).toBe("...");
  });
});
