import type { RewindTarget } from "../consumer/types";
import { toRawAddress } from "../core/address";
import type { AddAddressOptions } from "../ton-watch";
import { parseFrom } from "./config";

/** A `ton-watch` command line, validated. Addresses are raw. */
export type Command =
  | { name: "run" }
  | { name: "deliver" }
  | { name: "list" }
  | { name: "add"; address: string; from: AddAddressOptions["from"] }
  | { name: "remove"; address: string; purge: boolean }
  | ConsumerCommand;

/** Consumer management: works on the database alone, without a liteserver connection. */
export type ConsumerCommand =
  | { name: "consumers" }
  | { name: "rewind"; consumer: string; to: RewindTarget; addresses?: string[] }
  | { name: "dead-letters"; consumer?: string }
  | { name: "replay"; consumer: string; address: string; lt: bigint }
  | { name: "discard"; consumer: string; address: string; lt: bigint }
  | { name: "delete-consumer"; consumer: string };

export const USAGE: Record<Command["name"], string> = {
  run: "ton-watch [run]",
  deliver: "ton-watch deliver",
  list: "ton-watch list",
  add: "ton-watch add <address> [--from now|genesis|<lt>]",
  remove: "ton-watch remove <address> [--purge]",
  consumers: "ton-watch consumers",
  rewind: "ton-watch rewind <consumer> <start|now|lt> [--address <address>]...",
  "dead-letters": "ton-watch dead-letters [<consumer>]",
  replay: "ton-watch replay <consumer> <address> <lt>",
  discard: "ton-watch discard <consumer> <address> <lt>",
  "delete-consumer": "ton-watch delete-consumer <consumer>",
};

const CONSUMER_COMMANDS: ReadonlySet<Command["name"]> = new Set([
  "consumers",
  "rewind",
  "dead-letters",
  "replay",
  "discard",
  "delete-consumer",
]);

export function isConsumerCommand(command: Command): command is ConsumerCommand {
  return CONSUMER_COMMANDS.has(command.name);
}

const isCommandName = (name: string): name is Command["name"] => Object.hasOwn(USAGE, name);

/** Parses and validates `argv` (without the program name); throws with the usage on a mistake. */
export function parseCommand(argv: readonly string[]): Command {
  const [name = "run", ...rest] = argv;
  if (!isCommandName(name)) {
    throw new Error(`unknown command: ${name} (${Object.keys(USAGE).join(" | ")})`);
  }
  const usage = `usage: ${USAGE[name]}`;
  switch (name) {
    case "run":
    case "deliver":
    case "list":
    case "consumers":
      positionals(usage, parseArgs(usage, rest), 0, 0);
      return { name };
    case "add": {
      const args = parseArgs(usage, rest, { values: ["--from"] });
      const [address] = positionals(usage, args, 1, 1);
      const from = args.values.get("--from");
      if (from && from.length > 1) throw new Error(usage);
      return { name, address: parseAddress(address), from: parseFrom(from?.[0]) };
    }
    case "remove": {
      const args = parseArgs(usage, rest, { switches: ["--purge"] });
      const [address] = positionals(usage, args, 1, 1);
      return { name, address: parseAddress(address), purge: args.switches.has("--purge") };
    }
    case "rewind": {
      const args = parseArgs(usage, rest, { values: ["--address"] });
      const [consumer, to] = positionals(usage, args, 2, 2);
      const addresses = args.values.get("--address")?.map(parseAddress);
      return { name, consumer: parseConsumer(consumer), to: parseRewindTarget(to), addresses };
    }
    case "dead-letters": {
      const [consumer] = positionals(usage, parseArgs(usage, rest), 0, 1);
      return consumer === undefined ? { name } : { name, consumer: parseConsumer(consumer) };
    }
    case "replay":
    case "discard": {
      const [consumer, address, lt] = positionals(usage, parseArgs(usage, rest), 3, 3);
      return {
        name,
        consumer: parseConsumer(consumer),
        address: parseAddress(address),
        lt: parseLt(lt),
      };
    }
    case "delete-consumer": {
      const [consumer] = positionals(usage, parseArgs(usage, rest), 1, 1);
      return { name, consumer: parseConsumer(consumer) };
    }
  }
}

interface ParsedArgs {
  positionals: string[];
  /** Values of each option that takes one, in order (an option may repeat). */
  values: Map<string, string[]>;
  switches: Set<string>;
}

function parseArgs(
  usage: string,
  args: readonly string[],
  options: { values?: readonly string[]; switches?: readonly string[] } = {},
): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: new Map(), switches: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
    } else if (options.switches?.includes(arg)) {
      parsed.switches.add(arg);
    } else if (options.values?.includes(arg)) {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} needs a value\n${usage}`);
      parsed.values.set(arg, [...(parsed.values.get(arg) ?? []), value]);
    } else {
      throw new Error(`unknown option: ${arg}\n${usage}`);
    }
  }
  return parsed;
}

/** The positional arguments, padded to `max`; throws with the usage unless there are `min` to `max`. */
function positionals(
  usage: string,
  args: ParsedArgs,
  min: number,
  max: number,
): (string | undefined)[] {
  const count = args.positionals.length;
  if (count < min || count > max) throw new Error(usage);
  return Array.from({ length: max }, (_, i) => args.positionals[i]);
}

function parseAddress(value: string | undefined): string {
  try {
    return toRawAddress(value ?? "");
  } catch {
    throw new Error(`invalid address: ${value}`);
  }
}

function parseConsumer(value: string | undefined): string {
  if (!value) throw new Error("invalid consumer name: empty");
  return value;
}

function parseLt(value: string | undefined): bigint {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`invalid lt: ${value} (a decimal integer)`);
  }
  return BigInt(value);
}

function parseRewindTarget(value: string | undefined): RewindTarget {
  if (value === "start" || value === "now") return value;
  if (value !== undefined && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`invalid rewind target: ${value} (start | now | <lt>)`);
}
