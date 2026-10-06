import { describe, expect, test } from "bun:test";
import { Address } from "@ton/core";

import { isConsumerCommand, parseCommand } from "../../src/service/commands";
import { fakeAddress } from "../fixtures/fake-chain";

const A = fakeAddress(1);
const B = fakeAddress(2);
const A_FRIENDLY = Address.parse(A).toString();

describe("parseCommand", () => {
  test("run is the default", () => {
    expect(parseCommand([])).toEqual({ name: "run" });
    expect(parseCommand(["run"])).toEqual({ name: "run" });
  });

  test("address commands normalize the address", () => {
    expect(parseCommand(["add", A_FRIENDLY])).toEqual({ name: "add", address: A, from: "now" });
    expect(parseCommand(["add", A, "--from", "earliest"])).toMatchObject({ from: "earliest" });
    expect(parseCommand(["add", A, "--from", "42"])).toMatchObject({ from: 42n });
    expect(parseCommand(["remove", A])).toEqual({ name: "remove", address: A, purge: false });
    expect(parseCommand(["remove", "--purge", A_FRIENDLY])).toEqual({
      name: "remove",
      address: A,
      purge: true,
    });
  });

  test("consumer commands", () => {
    expect(parseCommand(["consumers"])).toEqual({ name: "consumers" });
    expect(parseCommand(["rewind", "c", "earliest"])).toEqual({
      name: "rewind",
      consumer: "c",
      to: "earliest",
      addresses: undefined,
    });
    expect(
      parseCommand(["rewind", "webhook:x", "123", "--address", A_FRIENDLY, "--address", B]),
    ).toEqual({ name: "rewind", consumer: "webhook:x", to: 123n, addresses: [A, B] });
    expect(parseCommand(["rewind", "c", "now"])).toMatchObject({ to: "now" });
    expect(parseCommand(["dead-letters"])).toEqual({ name: "dead-letters" });
    expect(parseCommand(["dead-letters", "c"])).toEqual({ name: "dead-letters", consumer: "c" });
    expect(parseCommand(["replay", "c", A_FRIENDLY, "7"])).toEqual({
      name: "replay",
      consumer: "c",
      address: A,
      lt: 7n,
    });
    expect(parseCommand(["discard", "c", A, "7"])).toMatchObject({ name: "discard", lt: 7n });
    expect(parseCommand(["delete-consumer", "c"])).toEqual({
      name: "delete-consumer",
      consumer: "c",
    });
  });

  test("isConsumerCommand tells the commands that need no liteserver", () => {
    const names = (argv: string[][]) => argv.map((args) => isConsumerCommand(parseCommand(args)));
    expect(names([["run"], ["deliver"], ["list"], ["add", A], ["remove", A]])).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(
      names([
        ["consumers"],
        ["rewind", "c", "now"],
        ["dead-letters"],
        ["replay", "c", A, "1"],
        ["discard", "c", A, "1"],
        ["delete-consumer", "c"],
      ]).every(Boolean),
    ).toBe(true);
  });

  test.each([
    [["frobnicate"], "unknown command: frobnicate (run | deliver |"],
    [["list", "extra"], "usage: ton-watch list"],
    [["add"], "usage: ton-watch add <address> [--from now|earliest|<lt>]"],
    [["add", A, "--from"], "--from needs a value"],
    [["add", A, "--from", "soon"], "invalid --from value: soon"],
    [["add", "nope"], "invalid address: nope"],
    [["remove", A, "--force"], "unknown option: --force"],
    [["rewind", "c"], "usage: ton-watch rewind <consumer> <earliest|now|lt>"],
    [["rewind", "c", "later"], "invalid rewind target: later (earliest | now | <lt>)"],
    [["rewind", "c", "-1"], "invalid rewind target: -1"],
    [["rewind", "c", "now", "--address", "nope"], "invalid address: nope"],
    [["dead-letters", "a", "b"], "usage: ton-watch dead-letters [<consumer>]"],
    [["replay", "c", A], "usage: ton-watch replay <consumer> <address> <lt>"],
    [["replay", "c", A, "1.5"], "invalid lt: 1.5"],
    [["discard", "c", "nope", "1"], "invalid address: nope"],
    [["delete-consumer"], "usage: ton-watch delete-consumer <consumer>"],
    [["delete-consumer", ""], "invalid consumer name: empty"],
  ])("%j is rejected", (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(message);
  });
});
