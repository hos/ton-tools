import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Request header carrying the signature:
 * `t=<unix seconds>,v1=<hex HMAC-SHA256>[,v1=<hex HMAC-SHA256>...]`, one `v1`
 * per signing secret (several while a secret is being rotated).
 */
export const SIGNATURE_HEADER = "ton-watch-signature";

/** Default age, in seconds, beyond which `verifySignature` rejects a request as a replay. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A request body: the exact bytes sent, or their UTF-8 decoding. */
export type SignedBody = string | Uint8Array;

/**
 * The signature header value for `body` sent at `timestamp` (unix seconds): for
 * each secret, an HMAC-SHA256 over `"<timestamp>.<body>"`, so a captured request
 * cannot be replayed with a different time or body.
 */
export function signatureHeader(
  secrets: string | readonly string[],
  body: SignedBody,
  timestamp: number,
): string {
  const signatures = list(secrets).map((secret) => `v1=${hmac(secret, timestamp, body)}`);
  if (signatures.length === 0) throw new Error("signatureHeader needs at least one secret");
  return [`t=${timestamp}`, ...signatures].join(",");
}

export interface VerifyOptions {
  /** Maximum age (and clock skew) accepted, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Current unix time in seconds; for tests. */
  now?: number;
}

/**
 * Whether `header` is a valid signature of `body` (the exact raw request body,
 * before any JSON parsing) within the tolerance window: true if any of its `v1`
 * signatures was made with any of `secrets`. Pass several secrets while rotating
 * on the receiving side; the sender signs with several while rotating on its side.
 * Unknown header fields (other schemes than `v1`) are ignored.
 */
export function verifySignature(
  secrets: string | readonly string[],
  body: SignedBody,
  header: string | null | undefined,
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now() / 1000 }: VerifyOptions = {},
): boolean {
  const timestamps: string[] = [];
  const signatures: Buffer[] = [];
  for (const part of (header ?? "").split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamps.push(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(Buffer.from(value, "hex"));
    }
  }
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0]!)) return false;
  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }
  let valid = false;
  // Every comparison runs, so timing does not reveal which secret matched.
  for (const secret of list(secrets)) {
    const expected = Buffer.from(hmac(secret, timestamp, body), "hex");
    for (const signature of signatures) {
      if (timingSafeEqual(signature, expected)) valid = true;
    }
  }
  return valid;
}

function hmac(secret: string, timestamp: number, body: SignedBody): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

const list = (secrets: string | readonly string[]): readonly string[] =>
  typeof secrets === "string" ? [secrets] : secrets;
