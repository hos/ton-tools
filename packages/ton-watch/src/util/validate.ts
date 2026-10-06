/**
 * Throws unless `value` is an integer of at least 1. `name` identifies the option
 * in the message, so a bad setting fails loudly at construction instead of
 * silently starting no work.
 */
export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}
