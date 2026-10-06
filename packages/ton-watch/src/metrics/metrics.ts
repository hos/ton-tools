import type { ErrorKind } from "../core/errors";

type Labels = Record<string, string>;

const WRITE_RATE_WINDOW_MS = 60_000;
const WRITE_RATE_METRIC = "ton_watch_tx_written_per_second";

/** Prometheus series key: `name{label="value",...}`, or just `name` without labels. */
function seriesKey(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const pairs = Object.entries(labels).map(
    ([label, value]) => `${label}="${value.replace(/"/g, '\\"')}"`,
  );
  return `${name}{${pairs.join(",")}}`;
}

/**
 * Minimal counter/gauge registry. Rendered as Prometheus text by `toPrometheus()`,
 * readable programmatically through `snapshot()`.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  /** Sliding window of `[timestampMs, txCount]` for the write-rate gauge. */
  private writeSamples: [number, number][] = [];

  /** Adds `by` to a counter. */
  inc(name: string, labels?: Labels, by = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  /** Sets a gauge. */
  set(name: string, value: number, labels?: Labels): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  /** Current value of one counter or gauge series; 0 if it was never recorded. */
  get(name: string, labels?: Labels): number {
    const key = seriesKey(name, labels);
    return this.counters.get(key) ?? this.gauges.get(key) ?? 0;
  }

  /** Sum of a counter over all label combinations. */
  sum(name: string): number {
    let total = 0;
    for (const [key, value] of this.counters) {
      if (key === name || key.startsWith(`${name}{`)) total += value;
    }
    return total;
  }

  /** Counts a failure of `kind` at `where` (a method or component name). */
  error(kind: ErrorKind, where: string): void {
    this.inc("ton_watch_errors_total", { kind, where });
  }

  /** Counts a call to the chain. */
  call(method: string): void {
    this.inc("ton_watch_source_calls_total", { method });
  }

  /** Counts newly stored transactions. */
  txWritten(count: number): void {
    this.inc("ton_watch_tx_written_total", undefined, count);
    if (count > 0) this.writeSamples.push([Date.now(), count]);
  }

  /** Transactions written per second over the last `windowMs`. */
  writeRate(windowMs = WRITE_RATE_WINDOW_MS): number {
    const since = Date.now() - windowMs;
    while (this.writeSamples.length > 0 && this.writeSamples[0]![0] < since) {
      this.writeSamples.shift();
    }
    const total = this.writeSamples.reduce((sum, [, count]) => sum + count, 0);
    return total / (windowMs / 1000);
  }

  /** Drops every gauge series whose key starts with `prefix`. */
  clearGauges(prefix: string): void {
    for (const key of this.gauges.keys()) if (key.startsWith(prefix)) this.gauges.delete(key);
  }

  /** Every series and its current value. */
  snapshot(): Record<string, number> {
    return {
      ...Object.fromEntries(this.counters),
      ...Object.fromEntries(this.gauges),
      [WRITE_RATE_METRIC]: this.writeRate(),
    };
  }

  /** Prometheus text exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];
    const typed = new Set<string>();
    const emit = (key: string, value: number, type: "counter" | "gauge") => {
      const name = key.split("{")[0]!;
      if (!typed.has(name)) {
        lines.push(`# TYPE ${name} ${type}`);
        typed.add(name);
      }
      lines.push(`${key} ${value}`);
    };
    for (const [key, value] of [...this.counters].sort()) emit(key, value, "counter");
    for (const [key, value] of [...this.gauges].sort()) emit(key, value, "gauge");
    emit(WRITE_RATE_METRIC, this.writeRate(), "gauge");
    return `${lines.join("\n")}\n`;
  }
}
