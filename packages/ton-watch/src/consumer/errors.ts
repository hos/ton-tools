import { TonWatchError } from "../core/errors";

/** Another instance holds the single-instance lock of this consumer name. Code `CONSUMER_LOCKED`. */
export class ConsumerLockedError extends TonWatchError<"CONSUMER_LOCKED"> {
  override name = "ConsumerLockedError";
  readonly consumer: string;

  constructor(consumer: string) {
    super("CONSUMER_LOCKED", `consumer ${consumer} is running elsewhere (its lock is held)`);
    this.consumer = consumer;
  }
}

/**
 * A consumer's cursor was not where this instance last saw it: another writer moved
 * it (an instance that took over after this one lost its lock, a rewind without the
 * lock), or an earlier commit went through without this process learning so. The
 * delivery is rolled back (with a transactional store), the round ends, and the
 * consumer reloads its positions before delivering again. Code `CURSOR_CONFLICT`.
 */
export class CursorConflictError extends TonWatchError<"CURSOR_CONFLICT"> {
  override name = "CursorConflictError";
  readonly consumer: string;
  readonly address: string;
  /** Where this instance expected the cursor; null for none yet. */
  readonly expected: bigint | null;

  constructor(consumer: string, address: string, expected: bigint | null) {
    super(
      "CURSOR_CONFLICT",
      `cursor of consumer ${consumer} on ${address} is no longer at ${expected ?? "(none)"}: it was moved elsewhere`,
    );
    this.consumer = consumer;
    this.address = address;
    this.expected = expected;
  }
}
