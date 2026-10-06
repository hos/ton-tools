import type { AddressState } from "../core/types";
import { runAtomically, type Store } from "../stores/store";
import type { RewindTarget } from "./types";

function targetLt(state: AddressState, to: RewindTarget): bigint {
  if (to === "start") return state.startLt;
  if (to === "now") return state.frontier?.lt ?? state.startLt;
  return to;
}

/**
 * Moves the cursors of `consumer` to `to`, on `addresses` (raw) or on every address
 * it has a cursor on, in one store transaction when the store has them. Clears
 * their failure counts; dead letters are kept. Resolves to the number moved.
 * The caller makes sure the consumer is not delivering meanwhile.
 */
export async function rewindCursors(
  store: Store,
  consumer: string,
  to: RewindTarget,
  addresses?: readonly string[],
): Promise<number> {
  const targets = new Set(
    addresses ?? (await store.listCursors(consumer)).map((cursor) => cursor.address),
  );
  const states = new Map(
    (await store.listAddresses({ includeInactive: true })).map((state) => [state.address, state]),
  );
  const moves = [...targets].map((address) => {
    const state = states.get(address);
    if (!state) throw new Error(`unknown address ${address}`);
    return { address, lt: targetLt(state, to) };
  });
  await runAtomically(store, async (tx) => {
    for (const { address, lt } of moves) await tx.setCursor(consumer, address, lt);
  });
  return moves.length;
}
