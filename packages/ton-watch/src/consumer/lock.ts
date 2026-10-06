import type { ConsumerLock } from "../stores/consumer-state";
import type { Store } from "../stores/store";
import { sleep } from "../util/async";
import { ConsumerLockedError } from "./errors";
import type { LockMode } from "./types";

/** Stands in for the lock of a store that cannot lock: always held. */
const UNGUARDED: ConsumerLock = { held: true, release: async () => {} };

/** One attempt at the lock of `name`; null if another instance holds it. */
export async function tryLockConsumer(store: Store, name: string): Promise<ConsumerLock | null> {
  return store.lockConsumer ? store.lockConsumer(name) : UNGUARDED;
}

/**
 * The lock of `name`: `"fail"` throws `ConsumerLockedError` if it is held,
 * `"wait"` retries every `retryMs` until it is free.
 */
export async function lockConsumer(
  store: Store,
  name: string,
  mode: LockMode,
  retryMs: number,
): Promise<ConsumerLock> {
  for (;;) {
    const lock = await tryLockConsumer(store, name);
    if (lock) return lock;
    if (mode === "fail") throw new ConsumerLockedError(name);
    await sleep(retryMs);
  }
}

/** Runs `fn` holding the lock of `name`; throws `ConsumerLockedError` if another instance has it. */
export async function withConsumerLock<T>(
  store: Store,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await lockConsumer(store, name, "fail", 0);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
