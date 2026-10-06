import type { AddressState, TxRecord } from "../core/types";

/** Read-ahead of one address in global order. */
export interface ReadBuffer {
  state: AddressState;
  items: TxRecord[];
  /** The store had nothing more below the watermark. */
  exhausted: boolean;
}

/** The buffer whose next transaction comes first in (lt, address) order. */
export function earliestBuffered(
  states: readonly AddressState[],
  buffers: ReadonlyMap<string, ReadBuffer>,
): ReadBuffer | null {
  let best: ReadBuffer | null = null;
  for (const { address } of states) {
    const buffer = buffers.get(address)!;
    const head = buffer.items[0];
    if (!head) continue;
    const bestHead = best?.items[0];
    if (
      !bestHead ||
      head.lt < bestHead.lt ||
      (head.lt === bestHead.lt && head.address < bestHead.address)
    ) {
      best = buffer;
    }
  }
  return best;
}
