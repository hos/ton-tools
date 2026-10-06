/** What went wrong with a chain request, as far as retry policy is concerned. */
export type ErrorKind =
  | "rate_limit"
  | "timeout"
  | "archive_unavailable"
  | "not_ready"
  | "bad_response"
  | "network"
  | "unknown";

/** An error from a transaction source, already classified. */
export class SourceError extends Error {
  override readonly name = "SourceError";

  constructor(
    readonly kind: ErrorKind,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
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
  if (error instanceof SourceError) return error.kind;
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
