/** Another instance holds the single-instance lock of this consumer name. */
export class ConsumerLockedError extends Error {
  override readonly name = "ConsumerLockedError";

  constructor(readonly consumer: string) {
    super(`consumer ${consumer} is running elsewhere (its lock is held)`);
  }
}
