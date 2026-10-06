/** Request header with the payload's `id`; the same on every attempt. Deduplicate on it. */
export const IDEMPOTENCY_HEADER = "idempotency-key";

/** Request header with the payload's `type` (`transaction`), so receivers can route before parsing. */
export const EVENT_HEADER = "ton-watch-event";

/** Request header marking a replayed dead letter; its value is `1`. */
export const REPLAY_HEADER = "ton-watch-replay";
