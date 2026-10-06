/**
 * Per-call options every `TxSource` and `HistorySource` method accepts.
 *
 * @experimental Exported from `@ton/watch/advanced`, with `TxSource`.
 */
export interface SourceCallOptions {
  /**
   * Abandons the call: once aborted, it makes no further attempt (no retry, no
   * other server, no further sub-request) and rejects promptly with
   * `signal.reason`, whether or not a request is still on the wire. The indexer
   * aborts it when a stop's grace period (`stopTimeoutMs`) is over.
   */
  signal?: AbortSignal;
}
