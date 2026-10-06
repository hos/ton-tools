import { expect, test } from "bun:test";

import { beginCell, type Cell } from "@ton/core";

import { parseMessageBody } from "../../src/parse/body";
import { Op } from "../../src/parse/opcodes";
import { rng } from "../fixtures/fake-chain";

const KNOWN_OPS = [...Object.values(Op)];

/** A random cell tree: random bit length (optionally starting with a known opcode) and refs. */
function randomCell(random: () => number, depth: number, op?: number): Cell {
  const b = beginCell();
  if (op !== undefined) b.storeUint(op, 32);
  const bits = Math.floor(random() * (b.availableBits + 1));
  for (let i = 0; i < bits; i++) b.storeBit(random() < 0.5);
  const refs = depth > 0 ? Math.floor(random() * 5) : 0;
  for (let i = 0; i < refs; i++) b.storeRef(randomCell(random, depth - 1));
  return b.endCell();
}

test("random cells never throw and always yield a body", () => {
  const random = rng(7);
  for (let i = 0; i < 3000; i++) {
    const op = random() < 0.7 ? KNOWN_OPS[Math.floor(random() * KNOWN_OPS.length)] : undefined;
    const cell = randomCell(random, 3, op);
    for (const bounced of [false, true]) {
      const body = parseMessageBody(cell, { bounced });
      expect(typeof body.kind).toBe("string");
    }
  }
});
