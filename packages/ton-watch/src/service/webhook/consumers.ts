import type { ProcessOptions, TxHandler } from "../../consumer/types";
import type { WebhookTarget } from "./config";
import { type SenderOptions, WebhookError, webhookHandler } from "./sender";

/** What it takes to run one target as a consumer, with `TonWatch.process` or `new Consumer`. */
export interface WebhookConsumerSpec {
  name: string;
  handler: TxHandler;
  options: ProcessOptions;
}

/** Consumer name (and stored cursor) of a target. */
export const webhookConsumerName = (target: WebhookTarget) => `webhook:${target.name}`;

export function webhookConsumerSpec(
  target: WebhookTarget,
  senderOptions: SenderOptions,
): WebhookConsumerSpec {
  return {
    name: webhookConsumerName(target),
    handler: webhookHandler(target, senderOptions),
    options: {
      from: target.from,
      order: target.order,
      addresses: target.addresses ?? undefined,
      retryMinMs: target.retryMinMs,
      retryMaxMs: target.retryMaxMs,
      onError: target.onError,
      maxAttempts: target.maxAttempts,
      isRetryable,
      // The HTTP call is the side effect; holding a database transaction open
      // across it would gain nothing. The cursor commits after a 2xx.
      transactional: false,
    },
  };
}

/** A receiver's rejection (3xx, 4xx other than 408 and 429) is final; anything else may pass later. */
function isRetryable(error: unknown): boolean {
  return !(error instanceof WebhookError) || error.retryable;
}
