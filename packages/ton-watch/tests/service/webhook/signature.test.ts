import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { signatureHeader, verifySignature } from "../../../src/service/webhook/signature";

const SECRET = "whsec_test";
const BODY = '{"id":"0:ab:1:ff","lt":"1"}';
const T = 1_700_000_000;

describe("signatureHeader", () => {
  test("is t=<timestamp>,v1=<hex HMAC-SHA256 of '<t>.<body>'>", () => {
    const expected = createHmac("sha256", SECRET).update(`${T}.${BODY}`).digest("hex");
    expect(signatureHeader(SECRET, BODY, T)).toBe(`t=${T},v1=${expected}`);
  });
});

describe("verifySignature", () => {
  const header = signatureHeader(SECRET, BODY, T);

  test("accepts its own signature within the window", () => {
    expect(verifySignature(SECRET, BODY, header, { now: T })).toBe(true);
    expect(verifySignature(SECRET, BODY, header, { now: T + 300 })).toBe(true);
    expect(verifySignature(SECRET, BODY, ` ${header.replace(",", " , ")}`, { now: T })).toBe(true);
  });

  test("rejects a changed body, another secret, or another timestamp", () => {
    expect(verifySignature(SECRET, `${BODY} `, header, { now: T })).toBe(false);
    expect(verifySignature("other", BODY, header, { now: T })).toBe(false);
    expect(verifySignature(SECRET, BODY, header.replace(`t=${T}`, `t=${T + 1}`), { now: T })).toBe(
      false,
    );
  });

  test("rejects replays outside the tolerance, in either direction", () => {
    expect(verifySignature(SECRET, BODY, header, { now: T + 301 })).toBe(false);
    expect(verifySignature(SECRET, BODY, header, { now: T - 301 })).toBe(false);
    expect(verifySignature(SECRET, BODY, header, { now: T + 3600, toleranceSeconds: 3600 })).toBe(
      true,
    );
  });

  test.each([
    [null],
    [""],
    ["garbage"],
    [`t=${T}`],
    ["v1=abcd"],
    [`t=abc,v1=${"0".repeat(64)}`],
    [`t=${T},v1=zz`],
    [`t=${T},v1=${"0".repeat(64)}`],
  ])("rejects malformed header %p", (value) => {
    expect(verifySignature(SECRET, BODY, value, { now: T })).toBe(false);
  });
});
