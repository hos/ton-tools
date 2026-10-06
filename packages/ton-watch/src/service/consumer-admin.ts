import { Consumer } from "../consumer/consumer";
import { rewindCursors } from "../consumer/cursors";
import { measureLag } from "../consumer/lag";
import { withConsumerLock } from "../consumer/lock";
import type { Store } from "../stores/store";
import type { Logger } from "../util/logger";
import type { ConsumerCommand } from "./commands";
import { type ConsumerSummary, consumersResponse, deadLettersResponse, toJson } from "./output";
import type { WebhookConsumerSpec } from "./webhook/consumers";

/** Every consumer the store knows, with its lag and dead-letter count. */
export async function consumerSummaries(store: Store): Promise<ConsumerSummary[]> {
  const [consumers, letters] = await Promise.all([store.listConsumers(), store.listDeadLetters()]);
  const deadLetters = new Map<string, number>();
  for (const { consumer } of letters) {
    deadLetters.set(consumer, (deadLetters.get(consumer) ?? 0) + 1);
  }
  return Promise.all(
    consumers.map(async (consumer) => {
      const { transactions, lt, seconds } = await measureLag(
        store,
        consumer.name,
        consumer.order ?? "address",
      );
      return {
        name: consumer.name,
        order: consumer.order,
        createdAt: consumer.createdAt,
        addresses: consumer.cursors.length,
        failing: consumer.cursors.filter((cursor) => cursor.attempts > 0).length,
        lag: { transactions, lt, seconds },
        deadLetters: deadLetters.get(consumer.name) ?? 0,
      };
    }),
  );
}

export interface ConsumerAdminContext {
  store: Store;
  /** The configured webhook consumers: the only ones whose handler this process has. */
  webhooks: readonly WebhookConsumerSpec[];
  logger: Logger;
}

/**
 * Runs a consumer management command against the store, printing data as JSON
 * to stdout and confirmations to the log. Changes to a consumer
 * (rewind, delete) are refused with `ConsumerLockedError` while it runs anywhere.
 */
export async function runConsumerCommand(
  command: ConsumerCommand,
  { store, webhooks, logger }: ConsumerAdminContext,
): Promise<void> {
  switch (command.name) {
    case "consumers":
      console.log(toJson(consumersResponse(await consumerSummaries(store))));
      return;
    case "dead-letters": {
      const letters = await store.listDeadLetters({ consumer: command.consumer });
      console.log(toJson(deadLettersResponse(letters)));
      return;
    }
    case "rewind": {
      const { consumer, to, addresses } = command;
      await assertKnown(store, consumer);
      const moved = await withConsumerLock(store, consumer, () =>
        rewindCursors(store, consumer, to, addresses),
      );
      logger.info(`rewound ${moved} cursor(s) of ${consumer} to ${to}`);
      return;
    }
    case "delete-consumer":
      await assertKnown(store, command.consumer);
      await withConsumerLock(store, command.consumer, () => store.deleteConsumer(command.consumer));
      logger.info(`deleted consumer ${command.consumer}`);
      return;
    case "discard": {
      const { consumer, address, lt } = command;
      if (!(await store.deleteDeadLetter(consumer, address, lt))) {
        throw new Error(`consumer ${consumer} has no dead letter at ${address} lt ${lt}`);
      }
      logger.info(`discarded dead letter ${address} lt ${lt} of ${consumer}`);
      return;
    }
    case "replay": {
      const { consumer, address, lt } = command;
      const spec = replayableSpec(consumer, webhooks);
      await new Consumer(spec.name, store, spec.handler, spec.options, { logger }).replayDeadLetter(
        address,
        lt,
      );
      logger.info(`replayed dead letter ${address} lt ${lt} of ${consumer}`);
      return;
    }
  }
}

/**
 * The webhook consumer `name` to replay through. Replaying needs the consumer's
 * handler, which the CLI has only for the configured webhook targets.
 */
export function replayableSpec(
  name: string,
  webhooks: readonly WebhookConsumerSpec[],
): WebhookConsumerSpec {
  const spec = webhooks.find((webhook) => webhook.name === name);
  if (!spec) {
    throw new Error(
      `cannot replay ${name}: the CLI replays only configured webhook targets ` +
        `(${webhooks.map((webhook) => webhook.name).join(", ") || "none configured"}); ` +
        "replay other consumers with Consumer.replayDeadLetter in the process that runs them",
    );
  }
  return spec;
}

async function assertKnown(store: Store, name: string): Promise<void> {
  const consumers = await store.listConsumers();
  if (!consumers.some((consumer) => consumer.name === name)) {
    throw new Error(`unknown consumer ${name}`);
  }
}
