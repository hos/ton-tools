import type { TxRecord } from "../../core/types";
import type {
  Backlog,
  ConsumerLock,
  ConsumerOrder,
  ConsumerRecord,
  ConsumerStateStore,
  CursorState,
  DeadLetter,
  RawDeadLetterFilter,
} from "../consumer-state";

/** What consumer state needs to know about the stored transactions. */
export interface MemoryTransactions {
  /** Stored transactions with `afterLt < lt <= frontier`, ascending; null unless the address is active. */
  deliverable(address: string, afterLt: bigint): TxRecord[] | null;
}

const key = (...parts: (string | bigint)[]) => parts.join("|");

const byKey = <T extends { consumer: string; address: string }>(a: T, b: T) =>
  a.consumer.localeCompare(b.consumer) || a.address.localeCompare(b.address);

/** `ConsumerStateStore` of `MemoryStore`. The lock guards against a second instance in this process. */
export class MemoryConsumerState implements ConsumerStateStore {
  private readonly cursors = new Map<string, CursorState>();
  private readonly consumers = new Map<string, { order: ConsumerOrder; createdAt: Date }>();
  private readonly deadLetters = new Map<string, DeadLetter>();
  private readonly locked = new Set<string>();

  constructor(private readonly transactions: MemoryTransactions) {}

  async getCursor(consumer: string, address: string): Promise<bigint | null> {
    return this.cursors.get(key(consumer, address))?.lt ?? null;
  }

  async setCursor(consumer: string, address: string, lt: bigint): Promise<void> {
    this.writeCursor(consumer, address, lt);
  }

  async compareAndSetCursor(
    consumer: string,
    address: string,
    expected: bigint | null,
    lt: bigint,
  ): Promise<boolean> {
    if ((this.cursors.get(key(consumer, address))?.lt ?? null) !== expected) return false;
    this.writeCursor(consumer, address, lt);
    return true;
  }

  private writeCursor(consumer: string, address: string, lt: bigint): void {
    this.cursors.set(key(consumer, address), {
      consumer,
      address,
      lt,
      updatedAt: new Date(),
      attempts: 0,
      lastError: null,
      firstFailureAt: null,
      lastFailureAt: null,
    });
  }

  async listCursors(consumer?: string): Promise<CursorState[]> {
    return [...this.cursors.values()]
      .filter((cursor) => consumer === undefined || cursor.consumer === consumer)
      .map((cursor) => ({ ...cursor }))
      .sort(byKey);
  }

  async recordFailure(
    consumer: string,
    address: string,
    error: string,
  ): Promise<CursorState | null> {
    const cursor = this.cursors.get(key(consumer, address));
    if (!cursor) return null;
    const now = new Date();
    cursor.attempts++;
    cursor.lastError = error;
    cursor.firstFailureAt ??= now;
    cursor.lastFailureAt = now;
    return { ...cursor };
  }

  async saveConsumer(name: string, order: ConsumerOrder): Promise<void> {
    const createdAt = this.consumers.get(name)?.createdAt ?? new Date();
    this.consumers.set(name, { order, createdAt });
  }

  async listConsumers(): Promise<ConsumerRecord[]> {
    const cursors = await this.listCursors();
    const names = new Set([...this.consumers.keys(), ...cursors.map((cursor) => cursor.consumer)]);
    return [...names].sort().map((name) => {
      const record = this.consumers.get(name);
      return {
        name,
        order: record?.order ?? null,
        createdAt: record?.createdAt ?? null,
        cursors: cursors.filter((cursor) => cursor.consumer === name),
      };
    });
  }

  async deleteConsumer(name: string): Promise<void> {
    this.consumers.delete(name);
    for (const [k, cursor] of this.cursors) if (cursor.consumer === name) this.cursors.delete(k);
    for (const [k, letter] of this.deadLetters) {
      if (letter.consumer === name) this.deadLetters.delete(k);
    }
  }

  async putDeadLetter(letter: DeadLetter): Promise<void> {
    this.deadLetters.set(key(letter.consumer, letter.address, letter.lt), { ...letter });
  }

  async updateDeadLetter(letter: DeadLetter): Promise<boolean> {
    const k = key(letter.consumer, letter.address, letter.lt);
    if (!this.deadLetters.has(k)) return false;
    this.deadLetters.set(k, { ...letter });
    return true;
  }

  async listDeadLetters(filter: RawDeadLetterFilter = {}): Promise<DeadLetter[]> {
    return [...this.deadLetters.values()]
      .filter(
        (letter) =>
          (filter.consumer === undefined || letter.consumer === filter.consumer) &&
          (filter.address === undefined || letter.address === filter.address) &&
          (filter.lt === undefined || letter.lt === filter.lt),
      )
      .sort((a, b) => byKey(a, b) || (a.lt < b.lt ? -1 : a.lt > b.lt ? 1 : 0))
      .slice(0, filter.limit)
      .map((letter) => ({ ...letter }));
  }

  async deleteDeadLetter(consumer: string, address: string, lt: bigint): Promise<boolean> {
    return this.deadLetters.delete(key(consumer, address, lt));
  }

  async backlog(consumer: string, uptoLt?: bigint): Promise<Backlog[]> {
    const result: Backlog[] = [];
    for (const cursor of await this.listCursors(consumer)) {
      const pending = this.transactions
        .deliverable(cursor.address, cursor.lt)
        ?.filter((tx) => uptoLt === undefined || tx.lt <= uptoLt);
      if (!pending) continue;
      result.push({
        address: cursor.address,
        cursor: cursor.lt,
        transactions: pending.length,
        newestLt: pending.at(-1)?.lt ?? null,
        oldestUtime: pending[0]?.utime ?? null,
      });
    }
    return result;
  }

  async lockConsumer(name: string): Promise<ConsumerLock | null> {
    if (this.locked.has(name)) return null;
    this.locked.add(name);
    let held = true;
    return {
      get held() {
        return held;
      },
      release: async () => {
        if (!held) return;
        held = false;
        this.locked.delete(name);
      },
    };
  }

  /** Drops everything that belongs to a purged address. */
  forgetAddress(address: string): void {
    for (const [k, cursor] of this.cursors) if (cursor.address === address) this.cursors.delete(k);
    for (const [k, letter] of this.deadLetters) {
      if (letter.address === address) this.deadLetters.delete(k);
    }
  }
}
