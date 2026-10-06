import { createHmac, timingSafeEqual } from "node:crypto";

/** Request header carrying the signature: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const SIGNATURE_HEADER = "ton-watch-signature";

/** Default age, in seconds, beyond which `verifySignature` rejects a request as a replay. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * The signature header value for `body` sent at `timestamp` (unix seconds): an
 * HMAC-SHA256 over `"<timestamp>.<body>"`, so a captured request cannot be
 * replayed with a different time or body.
 */
export function signatureHeader(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

export interface VerifyOptions {
  /** Maximum age (and clock skew) accepted, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Current unix time in seconds; for tests. */
  now?: number;
}

/**
 * Whether `header` is a valid signature of `body` (the exact raw request body)
 * made with `secret` within the tolerance window. The receiver-side check, also
 * shown in the README.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now() / 1000 }: VerifyOptions = {},
): boolean {
  const fields = new Map(
    (header ?? "").split(",").map((part) => {
      const [key = "", ...rest] = part.trim().split("=");
      return [key, rest.join("=")] as const;
    }),
  );
  const timestamp = Number(fields.get("t"));
  const signature = fields.get("v1");
  if (!Number.isInteger(timestamp) || !signature) return false;
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(hmac(secret, timestamp, body), "hex");
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
