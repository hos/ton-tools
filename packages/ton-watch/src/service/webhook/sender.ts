import type { TxHandler } from "../../consumer/types";
import { errorMessage } from "../../core/errors";
import { VERSION } from "../../version";
import { EVENT_HEADER, IDEMPOTENCY_HEADER, REPLAY_HEADER } from "../../webhook/headers";
import type { WebhookTarget } from "./config";
import { webhookPayload } from "./payload";
import { SIGNATURE_HEADER, signatureHeader } from "./signature";

/** Longest piece of a failed response body quoted in the error. */
const MAX_ERROR_BODY_CHARS = 200;
const USER_AGENT = `ton-watch/${VERSION}`;

/**
 * A request that did not get a 2xx. `retryable` failures (network errors,
 * timeouts, 408, 429, 5xx) are expected to succeed later; the others (3xx, other
 * 4xx) are the receiver rejecting the request and need someone to look at it.
 */
export class WebhookError extends Error {
  override readonly name = "WebhookError";

  constructor(
    message: string,
    /** HTTP status; null when no response arrived. */
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Whether a non-2xx status is worth retrying unchanged. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface SenderOptions {
  /** For tests. Default the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * A consumer handler that POSTs each transaction to `target` and resolves once the
 * receiver answered 2xx. Anything else throws a `WebhookError`, which the
 * consumer retries with backoff or gives up on, as `target.onError` says.
 */
export function webhookHandler(target: WebhookTarget, options: SenderOptions = {}): TxHandler {
  const send = options.fetch ?? fetch;
  return async (tx, { replay }) => {
    const payload = webhookPayload(tx, { webhook: target.name, replay });
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      [IDEMPOTENCY_HEADER]: payload.id,
      [EVENT_HEADER]: payload.type,
    };
    if (replay) headers[REPLAY_HEADER] = "1";
    if (target.secrets.length > 0) {
      // Signed per attempt, so a retry carries a fresh timestamp.
      headers[SIGNATURE_HEADER] = signatureHeader(
        target.secrets,
        body,
        Math.floor(Date.now() / 1000),
      );
    }

    let response: Response;
    try {
      response = await send(target.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(target.timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof DOMException && error.name === "TimeoutError"
          ? `timed out after ${target.timeoutMs}ms`
          : errorMessage(error);
      throw new WebhookError(`webhook ${target.name}: ${reason}`, null, true);
    }
    const text = await response.text().catch(() => "");
    if (response.ok) return;
    const snippet = text.slice(0, MAX_ERROR_BODY_CHARS);
    throw new WebhookError(
      `webhook ${target.name}: HTTP ${response.status}${snippet ? ` ${snippet}` : ""}`,
      response.status,
      isRetryableStatus(response.status),
    );
  };
}
