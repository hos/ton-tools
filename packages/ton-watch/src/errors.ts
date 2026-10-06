export type ErrorKind =
  | "rate_limit"
  | "timeout"
  | "archive_unavailable"
  | "not_ready"
  | "bad_response"
  | "network"
  | "unknown";

export class SourceError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

const patterns: [ErrorKind, RegExp][] = [
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
  const message = String((error as { message?: unknown })?.message ?? error);
  for (const [kind, re] of patterns) {
    if (re.test(message)) return kind;
  }
  return "unknown";
}
