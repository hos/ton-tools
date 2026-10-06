import type { CurrencyCollection, Message } from "@ton/core";

import { parseMessageBody } from "./body";
import { peekOp } from "./reader";
import type { MessageBody, ParsedMessage } from "./types";

/** Flattens a `@ton/core` message into a `ParsedMessage` with a decoded body. Never throws. */
export function parseMessage(message: Message): ParsedMessage {
  const info = message.info;
  const bounced = info.type === "internal" && info.bounced;
  const body = parseMessageBody(message.body, { bounced });
  const common = {
    op: peekOp(message.body),
    queryId: queryIdOf(body),
    body,
    comment: body.kind === "text-comment" ? body.text : null,
    raw: message,
  };
  switch (info.type) {
    case "internal":
      return {
        type: "internal",
        src: info.src,
        dest: info.dest,
        value: info.value.coins,
        extraCurrencies: extraCurrencies(info.value),
        bounce: info.bounce,
        bounced: info.bounced,
        fwdFee: info.forwardFee,
        extraFlags: info.ihrFee,
        createdLt: info.createdLt,
        createdAt: info.createdAt,
        ...common,
      };
    case "external-in":
      return {
        type: "external-in",
        src: info.src ?? null,
        dest: info.dest,
        importFee: info.importFee,
        ...common,
      };
    case "external-out":
      return {
        type: "external-out",
        src: info.src,
        dest: info.dest ?? null,
        createdLt: info.createdLt,
        createdAt: info.createdAt,
        ...common,
      };
  }
}

function queryIdOf(body: MessageBody): bigint | null {
  return "queryId" in body ? body.queryId : null;
}

function extraCurrencies(value: CurrencyCollection): Map<number, bigint> {
  const result = new Map<number, bigint>();
  const other = value.other;
  if (!other) return result;
  for (const id of other.keys()) {
    const amount = other.get(id);
    if (amount !== undefined) result.set(id, amount);
  }
  return result;
}
