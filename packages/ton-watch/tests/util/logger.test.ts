import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { consoleLogger, isLogLevel, type LogLevel, silentLogger } from "../../src/util/logger";

const METHODS = ["debug", "info", "warn", "error"] as const;

/** Spies on the console methods; must be called before the logger is created (it binds them). */
function captureConsole() {
  const spies = METHODS.map((method) => spyOn(console, method).mockImplementation(() => {}));
  return {
    printed: () =>
      METHODS.filter((_, i) => spies[i]!.mock.calls.length > 0) as (typeof METHODS)[number][],
    calls: (method: (typeof METHODS)[number]) => spies[METHODS.indexOf(method)]!.mock.calls,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe("isLogLevel", () => {
  test("accepts exactly the five levels", () => {
    for (const level of ["debug", "info", "warn", "error", "silent"]) {
      expect(isLogLevel(level)).toBe(true);
    }
    for (const level of ["", "INFO", "trace", "fatal", " info", "info "]) {
      expect(isLogLevel(level)).toBe(false);
    }
  });
});

describe("consoleLogger", () => {
  let capture: ReturnType<typeof captureConsole> | undefined;
  afterEach(() => capture?.restore());

  const cases: [LogLevel, (typeof METHODS)[number][]][] = [
    ["debug", ["debug", "info", "warn", "error"]],
    ["info", ["info", "warn", "error"]],
    ["warn", ["warn", "error"]],
    ["error", ["error"]],
    ["silent", []],
  ];
  for (const [level, expected] of cases) {
    test(`level ${level} prints ${expected.join(", ") || "nothing"}`, () => {
      capture = captureConsole();
      const logger = consoleLogger(level);
      for (const method of METHODS) logger[method]("message");
      expect(capture.printed()).toEqual(expected);
    });
  }

  test("defaults to info", () => {
    capture = captureConsole();
    const logger = consoleLogger();
    logger.debug("hidden");
    logger.info("shown");
    expect(capture.printed()).toEqual(["info"]);
  });

  test("prefixes every message and passes all arguments through", () => {
    capture = captureConsole();
    const error = new Error("x");
    consoleLogger("debug").warn("a", 1, error);
    expect(capture.calls("warn")).toEqual([["[ton-watch]", "a", 1, error]]);
  });

  test("silentLogger prints nothing", () => {
    capture = captureConsole();
    for (const method of METHODS) silentLogger[method]("message");
    expect(capture.printed()).toEqual([]);
  });

  test("console satisfies the Logger interface", () => {
    const logger: import("../../src/util/logger").Logger = console;
    expect(typeof logger.info).toBe("function");
  });
});
