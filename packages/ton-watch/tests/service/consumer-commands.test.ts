/**
 * The consumer management commands of the `ton-watch` CLI, in-process against
 * PGlite: they work on the database alone and never connect to a liteserver.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Consumer } from "../../src/consumer/consumer";
import { ConsumerLockedError } from "../../src/consumer/errors";
import type { TxHandler } from "../../src/consumer/types";
import { main } from "../../src/service/cli";
import type { ConsumersResponse, DeadLettersResponse } from "../../src/service/output";
import { PgStore } from "../../src/stores/pg/pg-store";
import { fakeAddress } from "../fixtures/fake-chain";
import { type ServiceHarness, setupService } from "./harness";

const A = fakeAddress(1);
const B = fakeAddress(2);

let h: ServiceHarness;
let store: PgStore;

const env = (extra: Record<string, string> = {}) => ({
  TON_WATCH_DATABASE_URL: "postgres://test/db",
  TON_WATCH_LOG: "silent",
  ...extra,
});

beforeEach(async () => {
  h = await setupService();
  store = new PgStore(h.fakePool as never);
  await store.migrate();
  h.chain.grow([A, B], 6);
  for (const address of [A, B]) {
    await store.addAddress(address, { startLt: 0n });
    await store.write(address, h.chain.txs(address));
    await store.advanceFrontier(address);
  }
});

afterEach(() => h.teardown());

/** Runs a command and returns the JSON it printed. */
async function printed<T>(argv: string[]): Promise<T> {
  h.logSpy.mockClear();
  await main(argv, env());
  return JSON.parse(String(h.logSpy.mock.calls.at(-1)?.[0])) as T;
}

/** Runs a command with info logging and returns the lines it logged. */
async function logged(argv: string[]): Promise<string[]> {
  h.infoSpy.mockClear();
  await main(argv, env({ TON_WATCH_LOG: "info" }));
  return h.infoSpy.mock.calls.map((call) => call.slice(1).join(" "));
}

/**
 * "payments": every transaction of A delivered, B's third dead-lettered and B
 * delivered up to its fifth. "audit" (global order): nothing delivered yet.
 */
async function seedConsumers() {
  const poison = h.chain.txs(B)[2]!.lt;
  const stopAt = h.chain.txs(B)[4]!.lt;
  const handler: TxHandler = (tx) => {
    if (tx.lt === poison) throw new Error("bad tx");
    if (tx.address === B && tx.lt > stopAt) throw new Error("not yet");
  };
  const payments = new Consumer("payments", store, handler, {
    onError: "dead-letter",
    maxAttempts: 100,
    retryMinMs: 0,
    retryMaxMs: 0,
    isRetryable: (error) => (error as Error).message !== "bad tx",
  });
  for (let i = 0; i < 3; i++) await payments.runOnce();
  await new Consumer("audit", store, () => {}, { order: "global", batchSize: 1 }).runOnce();
  await store.setCursor("audit", A, 0n);
  await store.setCursor("audit", B, 0n);
  return { poison };
}

describe("ton-watch consumers", () => {
  test("lists every consumer with order, lag, failing addresses and dead letters", async () => {
    await seedConsumers();
    const { version, consumers } = await printed<ConsumersResponse>(["consumers"]);
    expect(version).toBe(1);
    expect(consumers).toEqual([
      {
        name: "audit",
        order: "global",
        createdAt: expect.any(String),
        addresses: 2,
        failing: 0,
        // Global order lags up to the watermark: A's newest transaction, below B's newest.
        lag: {
          transactions: 11,
          lt: String(h.chain.txs(A).at(-1)!.lt),
          seconds: expect.any(Number),
        },
        deadLetters: 0,
      },
      {
        name: "payments",
        order: "address",
        createdAt: expect.any(String),
        addresses: 2,
        failing: 1,
        lag: {
          transactions: 1,
          lt: String(h.chain.txs(B)[5]!.lt - h.chain.txs(B)[4]!.lt),
          seconds: expect.any(Number),
        },
        deadLetters: 1,
      },
    ]);
    expect(h.connectSpy).not.toHaveBeenCalled();
    expect(h.exitSpy).toHaveBeenCalledWith(0);
  });

  test("an empty database lists none", async () => {
    expect(await printed<ConsumersResponse>(["consumers"])).toEqual({ version: 1, consumers: [] });
  });
});

describe("ton-watch dead-letters, discard", () => {
  test("lists dead letters (all or one consumer's) with hex hashes, and discards one", async () => {
    const { poison } = await seedConsumers();
    const { version, deadLetters } = await printed<DeadLettersResponse>(["dead-letters"]);
    expect(version).toBe(1);
    expect(deadLetters).toEqual([
      {
        consumer: "payments",
        address: B,
        lt: String(poison),
        hash: h.chain.txs(B)[2]!.hash.toString("hex"),
        error: "bad tx",
        attempts: 1,
        firstFailureAt: expect.any(String),
        lastFailureAt: expect.any(String),
      },
    ]);
    expect(await printed<DeadLettersResponse>(["dead-letters", "audit"])).toEqual({
      version: 1,
      deadLetters: [],
    });

    expect(await logged(["discard", "payments", B, String(poison)])).toContain(
      `discarded dead letter ${B} lt ${poison} of payments`,
    );
    expect(await store.listDeadLetters()).toEqual([]);
    await expect(main(["discard", "payments", B, String(poison)], env())).rejects.toThrow(
      `consumer payments has no dead letter at ${B} lt ${poison}`,
    );
    expect(h.connectSpy).not.toHaveBeenCalled();
  });
});

describe("ton-watch rewind", () => {
  test("moves every cursor, or only --address ones; clears failures, keeps dead letters", async () => {
    await seedConsumers();
    expect(await logged(["rewind", "payments", "earliest"])).toContain(
      "rewound 2 cursor(s) of payments to earliest",
    );
    expect((await store.listCursors("payments")).map((c) => [c.lt, c.attempts])).toEqual([
      [0n, 0],
      [0n, 0],
    ]);
    expect(await store.listDeadLetters()).toHaveLength(1);

    const lt = h.chain.txs(B)[3]!.lt;
    await main(["rewind", "payments", String(lt), "--address", B], env());
    expect(await store.getCursor("payments", A)).toBe(0n);
    expect(await store.getCursor("payments", B)).toBe(lt);

    await main(["rewind", "payments", "now"], env());
    expect(await store.getCursor("payments", A)).toBe(h.chain.txs(A).at(-1)!.lt);
  });

  test("an unknown consumer or address is refused", async () => {
    await seedConsumers();
    await expect(main(["rewind", "nobody", "earliest"], env())).rejects.toThrow(
      "unknown consumer nobody",
    );
    await expect(
      main(["rewind", "payments", "earliest", "--address", fakeAddress(9)], env()),
    ).rejects.toThrow("unknown address");
  });

  test("is refused with ConsumerLockedError while the consumer runs elsewhere", async () => {
    await seedConsumers();
    const lock = await store.lockConsumer("payments");
    const error = await main(["rewind", "payments", "earliest"], env()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConsumerLockedError);
    await lock?.release();
    expect(await store.getCursor("payments", A)).toBe(h.chain.txs(A).at(-1)!.lt);
  });
});

describe("ton-watch delete-consumer", () => {
  test("deletes record, cursors and dead letters; refused while running or unknown", async () => {
    await seedConsumers();
    const lock = await store.lockConsumer("payments");
    await expect(main(["delete-consumer", "payments"], env())).rejects.toBeInstanceOf(
      ConsumerLockedError,
    );
    await lock?.release();

    expect(await logged(["delete-consumer", "payments"])).toContain("deleted consumer payments");
    expect((await store.listConsumers()).map((c) => c.name)).toEqual(["audit"]);
    expect(await store.listCursors("payments")).toEqual([]);
    expect(await store.listDeadLetters()).toEqual([]);
    await expect(main(["delete-consumer", "payments"], env())).rejects.toThrow(
      "unknown consumer payments",
    );
  });
});

describe("ton-watch replay", () => {
  test("only a configured webhook target, checked before connecting", async () => {
    await expect(main(["replay", "payments", A, "1"], env())).rejects.toThrow(
      "cannot replay payments: the CLI replays only configured webhook targets (none configured)",
    );
    await expect(
      main(["replay", "webhook:other", A, "1"], env({ TON_WATCH_WEBHOOK_URL: "http://h/" })),
    ).rejects.toThrow("(webhook:default)");
    expect(h.poolSpy).not.toHaveBeenCalled();
  });

  test("a missing dead letter is an error", async () => {
    await expect(
      main(["replay", "webhook:default", A, "1"], env({ TON_WATCH_WEBHOOK_URL: "http://h/" })),
    ).rejects.toThrow(`consumer webhook:default has no dead letter at ${A} lt 1`);
  });
});

describe("argument errors", () => {
  test("fail before connecting to anything", async () => {
    await expect(main(["rewind", "payments", "yesterday"], env())).rejects.toThrow(
      "invalid rewind target: yesterday",
    );
    await expect(main(["dead-letters", "a", "b"], env())).rejects.toThrow("usage:");
    expect(h.poolSpy).not.toHaveBeenCalled();
    expect(h.connectSpy).not.toHaveBeenCalled();
  });
});
