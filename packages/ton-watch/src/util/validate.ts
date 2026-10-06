import { TonWatchError } from "../core/errors";

/** An `INVALID_OPTION` error about option `name`, to throw. */
export function invalidOption(name: string, message: string): TonWatchError<"INVALID_OPTION"> {
  return new TonWatchError("INVALID_OPTION", `${name} ${message}`);
}

/**
 * Throws `INVALID_OPTION` unless `value` is an integer of at least 1. `name`
 * identifies the option in the message, so a bad setting fails loudly at
 * construction instead of silently starting no work.
 */
export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw invalidOption(name, `must be a positive integer, got ${value}`);
  }
}
