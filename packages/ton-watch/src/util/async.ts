import { assertPositiveInteger } from "./validate";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Like `Promise.all(items.map(fn))`, with at most `concurrency` calls running at
 * once. Results keep the order of `items`. Rejects if `concurrency` is not a
 * positive integer.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  assertPositiveInteger("concurrency", concurrency);
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Runs tasks one at a time, in the order they were queued; a failure does not stop the queue. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => {});
    return result;
  }
}
