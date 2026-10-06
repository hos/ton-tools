import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { Metrics } from "../../src/metrics/metrics";

const RATE = "ton_watch_tx_written_per_second";

afterEach(() => setSystemTime());

describe("Metrics counters and gauges", () => {
  test("inc adds 1 by default, or `by`", () => {
    const metrics = new Metrics();
    metrics.inc("c");
    metrics.inc("c");
    metrics.inc("c", undefined, 5);
    expect(metrics.get("c")).toBe(7);
  });

  test("labels make separate series; empty labels are the bare series", () => {
    const metrics = new Metrics();
    metrics.inc("c", { kind: "a" });
    metrics.inc("c", { kind: "b" }, 2);
    metrics.inc("c", {});
    expect(metrics.get("c", { kind: "a" })).toBe(1);
    expect(metrics.get("c", { kind: "b" })).toBe(2);
    expect(metrics.get("c")).toBe(1);
    expect(metrics.get("c", {})).toBe(1);
  });

  test("label order is part of the series key", () => {
    const metrics = new Metrics();
    metrics.inc("c", { a: "1", b: "2" });
    expect(metrics.get("c", { a: "1", b: "2" })).toBe(1);
    expect(metrics.get("c", { b: "2", a: "1" })).toBe(0);
  });

  test("set overwrites a gauge, including with 0 and negatives", () => {
    const metrics = new Metrics();
    metrics.set("g", 10);
    metrics.set("g", -1);
    expect(metrics.get("g")).toBe(-1);
    metrics.set("g", 0);
    expect(metrics.get("g")).toBe(0);
  });

  test("get is 0 for unknown series", () => {
    expect(new Metrics().get("missing", { x: "y" })).toBe(0);
  });

  test("sum adds a counter over all labels, without matching longer names", () => {
    const metrics = new Metrics();
    metrics.inc("c", { kind: "a" }, 2);
    metrics.inc("c", { kind: "b" }, 3);
    metrics.inc("c");
    metrics.inc("c_other", undefined, 100);
    metrics.inc("cc", { kind: "a" }, 100);
    metrics.set("c", 1000); // gauges are not summed
    expect(metrics.sum("c")).toBe(6);
    expect(metrics.sum("nothing")).toBe(0);
  });

  test("error and call helpers use the documented series", () => {
    const metrics = new Metrics();
    metrics.error("timeout", "getTransactions");
    metrics.error("timeout", "getTransactions");
    metrics.call("getTip");
    expect(
      metrics.get("ton_watch_errors_total", { kind: "timeout", where: "getTransactions" }),
    ).toBe(2);
    expect(metrics.get("ton_watch_source_calls_total", { method: "getTip" })).toBe(1);
  });

  test("clearGauges drops gauges by prefix and leaves counters alone", () => {
    const metrics = new Metrics();
    metrics.set("ton_watch_address_lag_seconds", 5, { address: "a" });
    metrics.set("ton_watch_address_lag_seconds", 6, { address: "b" });
    metrics.set("ton_watch_gaps_open", 1);
    metrics.inc("ton_watch_address_counter");
    metrics.clearGauges("ton_watch_address_");
    expect(metrics.snapshot()).toEqual({
      ton_watch_gaps_open: 1,
      ton_watch_address_counter: 1,
      [RATE]: 0,
    });
  });
});

describe("Metrics write rate", () => {
  test("txWritten counts every transaction", () => {
    const metrics = new Metrics();
    metrics.txWritten(3);
    metrics.txWritten(0);
    metrics.txWritten(4);
    expect(metrics.get("ton_watch_tx_written_total")).toBe(7);
  });

  test("rate is per second over the window and forgets old samples", () => {
    const metrics = new Metrics();
    setSystemTime(new Date(1_000_000));
    metrics.txWritten(60);
    setSystemTime(new Date(1_030_000));
    metrics.txWritten(60);
    expect(metrics.writeRate()).toBe(2); // 120 tx / 60 s
    expect(metrics.writeRate(10_000)).toBe(6); // only the newer 60 tx, over 10 s
    setSystemTime(new Date(1_080_000));
    expect(metrics.writeRate()).toBe(1); // the first sample left the window
    setSystemTime(new Date(1_200_000));
    expect(metrics.writeRate()).toBe(0);
  });

  test("snapshot includes the write rate", () => {
    const metrics = new Metrics();
    metrics.txWritten(30);
    expect(metrics.snapshot()).toEqual({ ton_watch_tx_written_total: 30, [RATE]: 0.5 });
  });
});

describe("Metrics.toPrometheus", () => {
  test("empty registry still exports the write rate", () => {
    expect(new Metrics().toPrometheus()).toBe(`# TYPE ${RATE} gauge\n${RATE} 0\n`);
  });

  test("exact text: one TYPE line per family, counters then gauges, sorted", () => {
    const metrics = new Metrics();
    metrics.set("z_gauge", 1.5);
    metrics.inc("b_total", { kind: "y" }, 2);
    metrics.inc("b_total", { kind: "x" });
    metrics.inc("a_total");
    metrics.set("lag", -1, { address: "0:ab" });
    expect(metrics.toPrometheus()).toBe(
      [
        "# TYPE a_total counter",
        "a_total 1",
        "# TYPE b_total counter",
        'b_total{kind="x"} 1',
        'b_total{kind="y"} 2',
        "# TYPE lag gauge",
        'lag{address="0:ab"} -1',
        "# TYPE z_gauge gauge",
        "z_gauge 1.5",
        `# TYPE ${RATE} gauge`,
        `${RATE} 0`,
        "",
      ].join("\n"),
    );
  });

  test("multiple labels keep insertion order", () => {
    const metrics = new Metrics();
    metrics.error("rate_limit", "getTip");
    expect(metrics.toPrometheus()).toContain(
      'ton_watch_errors_total{kind="rate_limit",where="getTip"} 1\n',
    );
  });

  test("double quotes in label values are escaped", () => {
    const metrics = new Metrics();
    metrics.inc("c", { consumer: 'say "hi"' });
    expect(metrics.toPrometheus()).toContain('c{consumer="say \\"hi\\""} 1\n');
    expect(metrics.get("c", { consumer: 'say "hi"' })).toBe(1);
  });

  // BUG: seriesKey escapes `"` but not `\` or newlines, which the Prometheus text
  // format requires (`\\`, `\n`). A consumer named `a\b` or containing a newline
  // (consumer names are user-chosen labels) produces an unparsable exposition.
  test.failing("backslashes and newlines in label values are escaped", () => {
    const metrics = new Metrics();
    metrics.inc("c", { consumer: "a\\b" });
    metrics.inc("c", { consumer: "line1\nline2" });
    const text = metrics.toPrometheus();
    expect(text).toContain('c{consumer="a\\\\b"} 1\n');
    expect(text).toContain('c{consumer="line1\\nline2"} 1\n');
  });

  // BUG: series are sorted as "key,value" strings, so `foo` and `foo{...}` are split
  // by `foo_bar` ('_' < '{'). The text format requires a family's lines to be
  // contiguous; strict parsers (OpenMetrics, promtool) reject the output.
  test.failing("all series of one family are contiguous", () => {
    const metrics = new Metrics();
    metrics.inc("foo");
    metrics.inc("foo", { kind: "a" });
    metrics.inc("foo_bar");
    const lines = metrics.toPrometheus().split("\n");
    const fooLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line === "foo 1" || line.startsWith("foo{"));
    expect(fooLines[1]!.index - fooLines[0]!.index).toBe(1);
  });
});
