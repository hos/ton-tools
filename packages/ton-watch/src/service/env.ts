/** Environment variables as read by the service; `process.env` satisfies it. */
export type Env = Record<string, string | undefined>;

/** An empty variable (`TON_WATCH_LOG=` in compose/k8s) means "unset", not an invalid value. */
export const withoutEmpty = (env: Env): Env =>
  Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));

/** A decimal integer in `[min, max]`, or `fallback` when the variable is unset. */
export function integerInRange(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min && parsed <= max)) {
    throw new Error(`invalid ${name}: ${value} (an integer from ${min} to ${max})`);
  }
  return parsed;
}

/** `value` if it is one of `allowed`; otherwise throws naming the variable and the options. */
export function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid ${name}: ${value} (${allowed.join(" | ")})`);
  }
  return value as T;
}
