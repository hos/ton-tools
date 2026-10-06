import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { Metrics } from "../../src/metrics/metrics";
import { VERSION } from "../../src/version";

const BUILD_INFO = `ton_watch_build_info{version="${VERSION}"}`;
const DELIVERED = "ton_watch_consumer_delivered_total";

afterEach(() => setSystemTime());

describe("Metrics counters and gauges", () => {
  test("inc adds 1 by default, or `by`", () => {
    const metrics = new Metrics();
    metrics.inc("ton_watch_splits_total");
    metrics.inc("ton_watch_splits_total");
    metrics.inc("ton_watch_splits_total", undefined, 5);
    expect(metrics.get("ton_watch_splits_total")).toBe(7);
  });

  test("labels make separate series", () => {
    const metrics = new Metrics();
    metrics.inc(DELIVERED, { consumer: "a" });
    metrics.inc(DELIVERED, { consumer: "b" }, 2);
    expect(metrics.get(DELIVERED, { consumer: "a" })).toBe(1);
    expect(metrics.get(DELIVERED, { consumer: "b" })).toBe(2);
  });

  test("labels are matched by name, not by argument order", () => {
    const metrics = new Metrics();
    metrics.inc("ton_watch_history_pages_total", { source: "toncenter", why: "boost" });
    expect(
      metrics.get("ton_watch_history_pages_total", { why: "boost", source: "toncenter" }),
    ).toBe(1);
  });

  test("labels other than the declared ones are refused", () => {
    const metrics = new Metrics();
    const inc = metrics.inc.bind(metrics) as (name: string, labels?: object) => void;
    expect(() => inc(DELIVERED)).toThrow("takes labels [consumer]");
    expect(() => inc(DELIVERED, { consumer: "a", extra: "x" })).toThrow();
    expect(() => inc("ton_watch_splits_total", { consumer: "a" })).toThrow();
  });

  test("set overwrites a gauge, including with 0", () => {
    const metrics = new Metrics();
    metrics.set("ton_watch_gaps_open", 10);
    metrics.set("ton_watch_gaps_open", 0);
    expect(metrics.get("ton_watch_gaps_open")).toBe(0);
    expect(metrics.snapshot()).toHaveProperty("ton_watch_gaps_open", 0);
  });

  test("get is 0 for a series never recorded", () => {
    expect(new Metrics().get(DELIVERED, { consumer: "x" })).toBe(0);
  });

  test("sum adds every series of one metric", () => {
    const metrics = new Metrics();
    metrics.inc(DELIVERED, { consumer: "a" }, 2);
    metrics.inc(DELIVERED, { consumer: "b" }, 3);
    metrics.inc("ton_watch_consumer_errors_total", { consumer: "a" }, 100);
    expect(metrics.sum(DELIVERED)).toBe(5);
    expect(metrics.sum("ton_watch_consumer_skipped_total")).toBe(0);
  });

  test("remove drops one series, or every series without labels", () => {
    const metrics = new Metrics();
    metrics.set("ton_watch_address_lag_seconds", 5, { address: "0:a" });
    metrics.set("ton_watch_address_lag_seconds", 6, { address: "0:b" });
    metrics.set("ton_watch_address_gaps_open", 1, { address: "0:a" });
    metrics.remove("ton_watch_address_lag_seconds", { address: "0:a" });
    expect(Object.keys(metrics.snapshot())).toContain(
      'ton_watch_address_lag_seconds{address="0:b"}',
    );
    expect(Object.keys(metrics.snapshot())).not.toContain(
      'ton_watch_address_lag_seconds{address="0:a"}',
    );
    metrics.remove("ton_watch_address_lag_seconds");
    metrics.remove("ton_watch_address_gaps_open");
    expect(metrics.snapshot()).toEqual({ [BUILD_INFO]: 1 });
  });
});

describe("Metrics closed label sets", () => {
  test("error and call count known sites and methods", () => {
    const metrics = new Metrics();
    metrics.error("timeout", "getTransactions");
    metrics.error("timeout", "getTransactions");
    metrics.call("getTip");
    expect(
      metrics.get("ton_watch_errors_total", { kind: "timeout", where: "getTransactions" }),
    ).toBe(2);
    expect(metrics.get("ton_watch_source_calls_total", { method: "getTip" })).toBe(1);
  });

  test("unknown sites and methods count as other", () => {
    const metrics = new Metrics();
    metrics.error("unknown", "somewhere new");
    metrics.call("getConfig");
    expect(metrics.get("ton_watch_errors_total", { kind: "unknown", where: "other" })).toBe(1);
    expect(metrics.get("ton_watch_source_calls_total", { method: "other" })).toBe(1);
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

  test("writeRate is per second over the window and forgets old samples", () => {
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

  test("the rate is not exported as a metric", () => {
    const metrics = new Metrics();
    metrics.txWritten(30);
    expect(metrics.snapshot()).toEqual({ [BUILD_INFO]: 1, ton_watch_tx_written_total: 30 });
  });
});

describe("Metrics.toPrometheus", () => {
  test("a new registry exports only build info", () => {
    expect(new Metrics().toPrometheus()).toBe(
      [
        "# HELP ton_watch_build_info Always 1; the version label is the running ton-watch version.",
        "# TYPE ton_watch_build_info gauge",
        `${BUILD_INFO} 1`,
        "",
      ].join("\n"),
    );
  });

  test("exact text: HELP and TYPE per family, families and series sorted", () => {
    const metrics = new Metrics();
    metrics.set("ton_watch_gaps_open", 1.5);
    metrics.inc(DELIVERED, { consumer: "y" }, 2);
    metrics.inc(DELIVERED, { consumer: "x" });
    metrics.inc("ton_watch_splits_total");
    expect(metrics.toPrometheus()).toBe(
      [
        "# HELP ton_watch_build_info Always 1; the version label is the running ton-watch version.",
        "# TYPE ton_watch_build_info gauge",
        `${BUILD_INFO} 1`,
        "# HELP ton_watch_consumer_delivered_total Transactions handed to the consumer's handler and committed.",
        "# TYPE ton_watch_consumer_delivered_total counter",
        'ton_watch_consumer_delivered_total{consumer="x"} 1',
        'ton_watch_consumer_delivered_total{consumer="y"} 2',
        "# HELP ton_watch_gaps_open Missing ranges currently known, over all addresses.",
        "# TYPE ton_watch_gaps_open gauge",
        "ton_watch_gaps_open 1.5",
        "# HELP ton_watch_splits_total Long walks split into parallel pieces.",
        "# TYPE ton_watch_splits_total counter",
        "ton_watch_splits_total 1",
        "",
      ].join("\n"),
    );
  });

  test("several labels are written in declaration order", () => {
    const metrics = new Metrics();
    metrics.error("rate_limit", "getTip");
    expect(metrics.toPrometheus()).toContain(
      'ton_watch_errors_total{kind="rate_limit",where="getTip"} 1\n',
    );
  });

  test("double quotes, backslashes and newlines in label values are escaped", () => {
    const metrics = new Metrics();
    metrics.inc(DELIVERED, { consumer: 'say "hi"' });
    metrics.inc(DELIVERED, { consumer: "a\\b" });
    metrics.inc(DELIVERED, { consumer: "line1\nline2" });
    const text = metrics.toPrometheus();
    expect(text).toContain(`${DELIVERED}{consumer="say \\"hi\\""} 1\n`);
    expect(text).toContain(`${DELIVERED}{consumer="a\\\\b"} 1\n`);
    expect(text).toContain(`${DELIVERED}{consumer="line1\\nline2"} 1\n`);
    expect(metrics.get(DELIVERED, { consumer: 'say "hi"' })).toBe(1);
  });

  test("all series of one family are contiguous, after its HELP and TYPE", () => {
    const metrics = new Metrics();
    metrics.set("ton_watch_walks", 1);
    metrics.set("ton_watch_walks_stuck", 1);
    metrics.inc("ton_watch_walks_started_total", { kind: "head" });
    metrics.inc("ton_watch_walks_started_total", { kind: "gap" });
    const lines = metrics.toPrometheus().trimEnd().split("\n");
    const seen = new Set<string>();
    let current = "";
    for (const line of lines) {
      if (line.startsWith("# HELP ")) {
        current = line.split(" ")[2]!;
        expect(seen.has(current)).toBe(false);
        seen.add(current);
      } else if (!line.startsWith("#")) {
        expect(line.split(/[{ ]/, 1)[0]).toBe(current);
      }
    }
  });
});
