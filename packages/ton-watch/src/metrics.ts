import type { ErrorKind } from "./errors";

type Labels = Record<string, string>;

const key = (name: string, labels?: Labels) =>
  labels && Object.keys(labels).length
    ? `${name}{${Object.entries(labels)
        .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
        .join(",")}}`
    : name;

/**
 * Minimal counter/gauge registry. Rendered as Prometheus text by `toPrometheus()`,
 * readable programmatically through `snapshot()`.
 */
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  /** Sliding window of (time, txCount) for the write-rate gauge. */
  private writes: [number, number][] = [];

  inc(name: string, labels?: Labels, by = 1) {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  set(name: string, value: number, labels?: Labels) {
    this.gauges.set(key(name, labels), value);
  }

  get(name: string, labels?: Labels): number {
    const k = key(name, labels);
    return this.counters.get(k) ?? this.gauges.get(k) ?? 0;
  }

  /** Sum of a counter over all label combinations. */
  sum(name: string): number {
    let total = 0;
    for (const [k, v] of this.counters) {
      if (k === name || k.startsWith(`${name}{`)) total += v;
    }
    return total;
  }

  error(kind: ErrorKind, where: string) {
    this.inc("ton_watch_errors_total", { kind, where });
  }

  call(method: string) {
    this.inc("ton_watch_source_calls_total", { method });
  }

  txWritten(count: number) {
    this.inc("ton_watch_tx_written_total", undefined, count);
    if (count > 0) this.writes.push([Date.now(), count]);
  }

  /** Transactions written per second over the last `windowMs`. */
  writeRate(windowMs = 60_000): number {
    const since = Date.now() - windowMs;
    while (this.writes.length && this.writes[0]![0] < since) this.writes.shift();
    const total = this.writes.reduce((s, [, n]) => s + n, 0);
    return total / (windowMs / 1000);
  }

  clearGauges(prefix: string) {
    for (const k of this.gauges.keys()) if (k.startsWith(prefix)) this.gauges.delete(k);
  }

  snapshot(): Record<string, number> {
    return {
      ...Object.fromEntries(this.counters),
      ...Object.fromEntries(this.gauges),
      ton_watch_tx_written_per_second: this.writeRate(),
    };
  }

  toPrometheus(): string {
    const lines: string[] = [];
    const typed = new Set<string>();
    const emit = (k: string, v: number, type: "counter" | "gauge") => {
      const name = k.split("{")[0]!;
      if (!typed.has(name)) {
        lines.push(`# TYPE ${name} ${type}`);
        typed.add(name);
      }
      lines.push(`${k} ${v}`);
    };
    for (const [k, v] of [...this.counters].sort()) emit(k, v, "counter");
    for (const [k, v] of [...this.gauges].sort()) emit(k, v, "gauge");
    emit("ton_watch_tx_written_per_second", this.writeRate(), "gauge");
    return lines.join("\n") + "\n";
  }
}
