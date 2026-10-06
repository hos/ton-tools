/** `minMs` after the first failure, doubling with each further one, capped at `maxMs`. */
export function exponentialBackoff(failures: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, minMs * 2 ** (failures - 1));
}

/** A uniformly random delay in `[delayMs / 2, delayMs)`, so retries do not line up. */
export function withJitter(delayMs: number): number {
  return delayMs / 2 + Math.random() * (delayMs / 2);
}
