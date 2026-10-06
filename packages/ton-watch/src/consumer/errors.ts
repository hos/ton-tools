/** Another instance holds the single-instance lock of this consumer name. */
export class ConsumerLockedError extends Error {
  override readonly name = "ConsumerLockedError";

  constructor(readonly consumer: string) {
    super(`consumer ${consumer} is running elsewhere (its lock is held)`);
  }
}

/**
 * A consumer's cursor was not where this instance last saw it: another writer moved
 * it (an instance that took over after this one lost its lock, a rewind without the
 * lock), or an earlier commit went through without this process learning so. The
 * delivery is rolled back (with a transactional store), the round ends, and the
 * consumer reloads its positions before delivering again.
 */
export class CursorConflictError extends Error {
  override readonly name = "CursorConflictError";

  constructor(
    readonly consumer: string,
    readonly address: string,
    /** Where this instance expected the cursor; null for none yet. */
    readonly expected: bigint | null,
  ) {
    super(
      `cursor of consumer ${consumer} on ${address} is no longer at ${expected ?? "(none)"}: it was moved elsewhere`,
    );
  }
}
