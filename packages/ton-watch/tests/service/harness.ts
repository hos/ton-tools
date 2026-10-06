/**
 * Runs the `ton-watch` CLI in-process: Postgres is replaced by PGlite and the
 * liteserver connection by a `FakeSource`, both mocked at the module level;
 * `process.exit` and console output are captured.
 */
import { type Mock, spyOn } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import * as pg from "pg";

import { LiteSource } from "../../src/source/liteserver/lite-source";
import { FakeChain, FakeSource } from "../fixtures/fake-chain";

export interface ServiceHarness {
  db: PGlite;
  chain: FakeChain;
  /** What the mocked `pg.Pool` constructor returns; also usable as a `PgStore` database. */
  fakePool: {
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    transaction<T>(fn: (tx: never) => Promise<T>): Promise<T>;
    on(): void;
    end(): Promise<void>;
  };
  poolSpy: Mock<(...args: unknown[]) => unknown>;
  connectSpy: Mock<(options?: unknown) => Promise<unknown>>;
  exitSpy: Mock<(code?: number) => never>;
  logSpy: Mock<(...args: unknown[]) => void>;
  infoSpy: Mock<(...args: unknown[]) => void>;
  /** Restores every spy, removes signal listeners added since setup and closes PGlite. */
  teardown(): Promise<void>;
}

export async function setupService(): Promise<ServiceHarness> {
  const db = await PGlite.create();
  const chain = new FakeChain();
  const fakePool: ServiceHarness["fakePool"] = {
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(fn as never),
    on: () => {},
    end: async () => {},
  };
  // Replaces the pg.Pool constructor; a class spy is typed for `new`, hence the cast.
  const poolSpy = spyOn(pg, "Pool") as unknown as ServiceHarness["poolSpy"];
  poolSpy.mockImplementation(() => fakePool);
  const source = Object.assign(new FakeSource(chain), { stats: () => [] });
  const connectSpy = spyOn(LiteSource, "connect") as unknown as ServiceHarness["connectSpy"];
  connectSpy.mockResolvedValue(source);
  // process.exit must not end the test run.
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const infoSpy = spyOn(console, "info").mockImplementation(() => {});
  const signals = ["SIGINT", "SIGTERM"] as const;
  const listenersBefore = new Map(signals.map((signal) => [signal, process.listeners(signal)]));

  return {
    db,
    chain,
    fakePool,
    poolSpy,
    connectSpy,
    exitSpy,
    logSpy,
    infoSpy,
    async teardown() {
      for (const spy of [poolSpy, connectSpy, exitSpy, logSpy, infoSpy]) spy.mockRestore();
      for (const signal of signals) {
        for (const listener of process.listeners(signal)) {
          if (!listenersBefore.get(signal)?.includes(listener)) process.off(signal, listener);
        }
      }
      await db.close();
    },
  };
}

/** Polls `cond` every 10ms; throws after `ms`. */
export async function until(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
