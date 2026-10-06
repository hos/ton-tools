import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { signatureHeader } from "../../../src/service/webhook/signature";
import { DEFAULT_TOLERANCE_SECONDS, verifySignature } from "../../../src/webhook";

const SECRET = "whsec_test";
const BODY = '{"id":"0:ab:1:ff","lt":"1"}';
const T = 1_700_000_000;

/**
 * Golden vectors pinning the scheme. Computed independently of this code with
 * `printf '%s' '<t>.<body>' | openssl dgst -sha256 -hmac <secret>`.
 */
const VECTORS = {
  test: "36dca9edd4bf98e2f94988b010aae3a1e3f5ca045c06e353c09d14bc0636ef28",
  old: "98de501ce3bf852565de385cd3ca336ad5201216adc086c0a2c3b750daa99d7d",
  /** Body bytes ff 00 01 (not UTF-8). */
  binary: "b7a855e4ec3a279370018dc3c887b53ae1e1c62d08a18bf196fae795f8ca303f",
  /** Body `{"text":"héllo ✓"}`, UTF-8. */
  unicode: "2ecfc69f86517f5889bc0548822726d2b9a98dd1654c4af81c82f7955583efd6",
};
const BINARY = new Uint8Array([0xff, 0x00, 0x01]);
const UNICODE = '{"text":"héllo ✓"}';

describe("signatureHeader", () => {
  test("is t=<timestamp>,v1=<hex HMAC-SHA256 of '<t>.<body>'>", () => {
    const expected = createHmac("sha256", SECRET).update(`${T}.${BODY}`).digest("hex");
    expect(signatureHeader(SECRET, BODY, T)).toBe(`t=${T},v1=${expected}`);
  });

  test("golden vectors", () => {
    expect(signatureHeader(SECRET, BODY, T)).toBe(`t=1700000000,v1=${VECTORS.test}`);
    expect(signatureHeader(SECRET, BINARY, T)).toBe(`t=1700000000,v1=${VECTORS.binary}`);
    expect(signatureHeader(SECRET, UNICODE, T)).toBe(`t=1700000000,v1=${VECTORS.unicode}`);
    expect(signatureHeader(SECRET, new TextEncoder().encode(UNICODE), T)).toBe(
      `t=1700000000,v1=${VECTORS.unicode}`,
    );
  });

  test("several secrets give one v1 each, in order", () => {
    expect(signatureHeader([SECRET, "whsec_old"], BODY, T)).toBe(
      `t=1700000000,v1=${VECTORS.test},v1=${VECTORS.old}`,
    );
  });

  test("needs at least one secret", () => {
    expect(() => signatureHeader([], BODY, T)).toThrow("at least one secret");
  });
});

describe("verifySignature with rotation", () => {
  const both = `t=${T},v1=${VECTORS.test},v1=${VECTORS.old}`;

  test("passes if any v1 matches any secret", () => {
    expect(verifySignature(SECRET, BODY, both, { now: T })).toBe(true);
    expect(verifySignature("whsec_old", BODY, both, { now: T })).toBe(true);
    expect(verifySignature(["whsec_new", "whsec_old"], BODY, both, { now: T })).toBe(true);
    expect(
      verifySignature(["whsec_new", SECRET], BODY, `t=${T},v1=${VECTORS.test}`, { now: T }),
    ).toBe(true);
    expect(verifySignature(["a", "b"], BODY, both, { now: T })).toBe(false);
    expect(verifySignature([], BODY, both, { now: T })).toBe(false);
  });

  test("ignores unknown schemes and invalid v1 values next to a valid one", () => {
    const header = `t=${T},v0=deadbeef,v1=zz,v1=${VECTORS.test},v2=${"0".repeat(64)}`;
    expect(verifySignature(SECRET, BODY, header, { now: T })).toBe(true);
  });

  test("rejects a header with two timestamps", () => {
    expect(verifySignature(SECRET, BODY, `t=${T},t=${T},v1=${VECTORS.test}`, { now: T })).toBe(
      false,
    );
  });

  test("accepts the body as bytes or as a string", () => {
    expect(verifySignature(SECRET, BINARY, `t=${T},v1=${VECTORS.binary}`, { now: T })).toBe(true);
    expect(
      verifySignature(SECRET, Buffer.from(UNICODE), `t=${T},v1=${VECTORS.unicode}`, { now: T }),
    ).toBe(true);
    expect(verifySignature(SECRET, UNICODE, `t=${T},v1=${VECTORS.unicode}`, { now: T })).toBe(true);
  });

  test("the default tolerance is 300 seconds", () => {
    const header = `t=${T},v1=${VECTORS.test}`;
    expect(verifySignature(SECRET, BODY, header, { now: T + DEFAULT_TOLERANCE_SECONDS })).toBe(
      true,
    );
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
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
