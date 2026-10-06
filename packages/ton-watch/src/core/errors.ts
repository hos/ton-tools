/**
 * Every error ton-watch throws on purpose carries one of these codes. The codes
 * are the stable contract: match on them (with `isTonWatchError`), not on
 * messages or class identity — messages may change in any release, a code is only
 * removed or repurposed in a major one.
 *
 * - `INVALID_OPTION`: an option or argument has a value that cannot work.
 * - `INVALID_ADDRESS`: an address is neither a valid friendly nor raw address.
 * - `UNKNOWN_ADDRESS`: the address is not tracked by the store.
 * - `UNKNOWN_CONSUMER`: no consumer of that name (in the store, or registered in
 *   this process where the operation needs a local one).
 * - `CONSUMER_REGISTERED`: a consumer of that name is already registered in this
 *   `TonWatch`.
 * - `CONSUMER_LOCKED`: another instance holds the consumer's lock (`ConsumerLockedError`).
 * - `CURSOR_CONFLICT`: a consumer's cursor was moved by someone else (`CursorConflictError`).
 * - `DEAD_LETTER_NOT_FOUND`: no such dead letter (any more).
 * - `TRANSACTION_NOT_FOUND`: the transaction is no longer stored.
 * - `CLOSED`: the `TonWatch` was closed.
 * - `PG_POOL_TOO_SMALL`: a `pg.Pool` has too few connections for the running consumers.
 * - `MIGRATION_MODIFIED`, `MIGRATION_TOO_NEW`, `MIGRATION_DIVERGED`: `migrate()`
 *   refused the schema (`MigrationError`).
 * - `SOURCE_*`: a chain request failed (`SourceError`); the suffix is its `ErrorKind`.
 */
export type TonWatchErrorCode =
  | "INVALID_OPTION"
  | "INVALID_ADDRESS"
  | "UNKNOWN_ADDRESS"
  | "UNKNOWN_CONSUMER"
  | "CONSUMER_REGISTERED"
  | "CONSUMER_LOCKED"
  | "CURSOR_CONFLICT"
  | "DEAD_LETTER_NOT_FOUND"
  | "TRANSACTION_NOT_FOUND"
  | "CLOSED"
  | "PG_POOL_TOO_SMALL"
  | "MIGRATION_MODIFIED"
  | "MIGRATION_TOO_NEW"
  | "MIGRATION_DIVERGED"
  | SourceErrorCode;

/**
 * Marks ton-watch errors. A registered symbol, so `isTonWatchError` also
 * recognizes errors from another copy of the package in the same process.
 */
const BRAND: unique symbol = Symbol.for("ton-watch.error");

/**
 * Base class of every error ton-watch throws on purpose. Check `code` (see
 * `TonWatchErrorCode`) through `isTonWatchError`, which unlike `instanceof` also
 * works when two copies of ton-watch are loaded. The underlying error, if any, is
 * the standard `cause`.
 */
export class TonWatchError<Code extends TonWatchErrorCode = TonWatchErrorCode> extends Error {
  override name = "TonWatchError";
  readonly code: Code;

  constructor(code: Code, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
Object.defineProperty(TonWatchError.prototype, BRAND, { value: true });

/**
 * Whether `error` was thrown by ton-watch (any copy of it) and, if given, has
 * `code`.
 *
 * ```ts
 * if (isTonWatchError(error, "CONSUMER_LOCKED")) { … }
 * ```
 */
export function isTonWatchError<Code extends TonWatchErrorCode = TonWatchErrorCode>(
  error: unknown,
  code?: Code,
): error is TonWatchError<Code> {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { [BRAND]?: unknown })[BRAND] !== true) return false;
  return code === undefined || (error as { code?: unknown }).code === code;
}

/** What went wrong with a chain request, as far as retry policy is concerned. */
export type ErrorKind =
  | "rate_limit"
  | "timeout"
  | "archive_unavailable"
  | "not_ready"
  | "bad_response"
  | "network"
  | "unknown";

/** `SourceError` codes: `SOURCE_` plus the upper-cased `ErrorKind`. */
export type SourceErrorCode = `SOURCE_${Uppercase<ErrorKind>}`;

/** An error from a transaction source, already classified (`kind`, and `code` derived from it). */
export class SourceError extends TonWatchError<SourceErrorCode> {
  override name = "SourceError";
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string, cause?: unknown) {
    super(`SOURCE_${kind.toUpperCase()}` as SourceErrorCode, message, { cause });
    this.kind = kind;
  }
}

/** Message patterns of liteserver and transport errors, checked in order. */
const ERROR_PATTERNS: readonly (readonly [ErrorKind, RegExp])[] = [
  ["rate_limit", /too many|rate.?limit|ratelimit|\b429\b|overload|flood/i],
  ["timeout", /timeout|timed out/i],
  // A lagging server that has not seen a recent block yet.
  [
    "not_ready",
    /possibly out of sync|block not found|not ready|not applied|unknown block|seqno not in db/i,
  ],
  [
    "archive_unavailable",
    /cannot locate transaction|not in db|gc'?d|garbage|state already|cannot load (block|state)|archive|too old/i,
  ],
  ["network", /engine is closed|socket|econn|ehostunreach|epipe|closed|reset|connect/i],
];

/** Maps a liteserver / transport error to a kind the retry policy understands. */
export function classifyError(error: unknown): ErrorKind {
  // By code, not `instanceof`: the error may come from another copy of ton-watch.
  if (isTonWatchError(error) && error.code.startsWith("SOURCE_")) {
    return (error as SourceError).kind;
  }
  const message = errorMessage(error);
  for (const [kind, pattern] of ERROR_PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return "unknown";
}

/**
 * The message of anything thrown: `Error`s, plain objects with a `message`, or other
 * values. An empty message falls back to the inner errors of an `AggregateError`
 * (what `pg` throws when every address of a host refuses), then to the error `code`.
 */
export function errorMessage(error: unknown): string {
  const { message, code, errors } = (error ?? {}) as {
    message?: unknown;
    code?: unknown;
    errors?: unknown;
  };
  if (message === undefined || message === null) return String(error);
  if (message !== "") return String(message);
  if (Array.isArray(errors) && errors.length > 0) {
    return [...new Set(errors.map(errorMessage))].join("; ");
  }
  if (code !== undefined) return String(code);
  return String(error);
}
