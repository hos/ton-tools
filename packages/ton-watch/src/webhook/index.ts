/**
 * Receiver-side helpers for the service's webhooks: signature verification and
 * the request body's types. Depends only on `node:crypto`.
 *
 * Every request is a `POST` with a JSON `WebhookPayload` body and these headers:
 * - `Idempotency-Key`: the payload's `id`, the same on every attempt;
 * - `TON-Watch-Event`: the payload's `type` (`transaction`);
 * - `TON-Watch-Signature`: `t=<unix seconds>,v1=<hex HMAC-SHA256>...`, when signed
 *   (see `verifySignature`);
 * - `TON-Watch-Replay`: `1` on a replayed dead letter.
 *
 * Receivers must ignore fields, event types and `kind` values they do not know;
 * see `types.ts` for the compatibility rules.
 *
 * @module
 */
export {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  type SignedBody,
  type VerifyOptions,
  verifySignature,
} from "../service/webhook/signature";
export { EVENT_HEADER, IDEMPOTENCY_HEADER, REPLAY_HEADER } from "./headers";
export type * from "./types";
export { WEBHOOK_PAYLOAD_VERSION } from "./types";
