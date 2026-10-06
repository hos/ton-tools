import type { ErrorKind } from "../core/errors";
import { VERSION } from "../version";
import {
  type CounterName,
  closedLabel,
  ERROR_SITES,
  type GaugeName,
  METRICS,
  type MetricLabels,
  type MetricName,
  SOURCE_METHODS,
} from "./registry";

const WRITE_RATE_WINDOW_MS = 60_000;

/** Labels argument: omitted for a metric without labels, exactly its labels otherwise. */
type LabelsArg<N extends MetricName> = (typeof METRICS)[N]["labels"] extends readonly []
  ? [labels?: undefined]
  : [labels: MetricLabels<N>];

interface Series {
  labels: readonly string[];
  value: number;
}

/**
 * ton-watch's metrics: the counters and gauges listed in `METRICS` (see
 * `registry.ts`), and nothing else.
 *
 * Read them with `toPrometheus()` (served on the service's `/metrics`),
 * `snapshot()`, `get()` or `sum()`. The recording methods are for ton-watch's own
 * components; a `Metrics` passed in through options is shared by them.
 */
export class Metrics {
  /** Per metric: series by their label values joined with `\0`. */
  private readonly families = new Map<MetricName, Map<string, Series>>();
  /** Sliding window of `[timestampMs, txCount]` for `writeRate()`. */
  private writeSamples: [number, number][] = [];

  constructor() {
    this.write("ton_watch_build_info", [VERSION], () => 1);
  }

  // ------------------------------------------------------------- reading

  /** Current value of one series; 0 if it was never recorded. */
  get<N extends MetricName>(name: N, ...[labels]: LabelsArg<N>): number {
    return this.families.get(name)?.get(labelKey(labelValues(name, labels)))?.value ?? 0;
  }

  /** Sum of every series of a metric. */
  sum(name: MetricName): number {
    let total = 0;
    for (const series of this.families.get(name)?.values() ?? []) total += series.value;
    return total;
  }

  /** Every series, keyed `name{label="value",...}` as in the Prometheus text. */
  snapshot(): Record<string, number> {
    const snapshot: Record<string, number> = {};
    for (const [name, series] of this.sortedFamilies()) {
      for (const { labels, value } of series) snapshot[seriesName(name, labels)] = value;
    }
    return snapshot;
  }

  /** Prometheus text exposition format (0.0.4), with `# HELP` and `# TYPE` per metric. */
  toPrometheus(): string {
    const lines: string[] = [];
    for (const [name, series] of this.sortedFamilies()) {
      const { help, type } = METRICS[name];
      lines.push(`# HELP ${name} ${help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`);
      lines.push(`# TYPE ${name} ${type}`);
      for (const { labels, value } of series) lines.push(`${seriesName(name, labels)} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  // ------------------------------------------------------------- recording (internal)

  /** @internal Adds `by` to a counter. */
  inc<N extends CounterName>(name: N, ...args: [...LabelsArg<N>, by?: number]): void {
    const [labels, by = 1] = args as unknown as [Record<string, string> | undefined, number?];
    this.write(name, labelValues(name, labels), (value) => value + by);
  }

  /** @internal Sets a gauge. */
  set<N extends GaugeName>(name: N, value: number, ...[labels]: LabelsArg<N>): void {
    this.write(name, labelValues(name, labels), () => value);
  }

  /** @internal Drops one series of a gauge, or all of them without labels. */
  remove<N extends GaugeName>(name: N, labels?: MetricLabels<N>): void {
    if (labels === undefined) this.families.delete(name);
    else this.families.get(name)?.delete(labelKey(labelValues(name, labels)));
  }

  /**
   * @internal Counts a failure of `kind` at `where`: one of `ERROR_SITES`,
   * anything else counts as `other`.
   */
  error(kind: ErrorKind, where: string): void {
    this.inc("ton_watch_errors_total", { kind, where: closedLabel(ERROR_SITES, where) });
  }

  /** @internal Counts a call to the chain; `method` outside `SOURCE_METHODS` counts as `other`. */
  call(method: string): void {
    this.inc("ton_watch_source_calls_total", { method: closedLabel(SOURCE_METHODS, method) });
  }

  /** @internal Counts newly stored transactions. */
  txWritten(count: number): void {
    this.inc("ton_watch_tx_written_total", undefined, count);
    if (count > 0) this.writeSamples.push([Date.now(), count]);
  }

  /**
   * @internal Transactions written per second over the last `windowMs`, for
   * health reports. Not exported as a metric: use `rate(ton_watch_tx_written_total[1m])`.
   */
  writeRate(windowMs: number = WRITE_RATE_WINDOW_MS): number {
    const since = Date.now() - windowMs;
    while (this.writeSamples.length > 0 && this.writeSamples[0]![0] < since) {
      this.writeSamples.shift();
    }
    const total = this.writeSamples.reduce((sum, [, count]) => sum + count, 0);
    return total / (windowMs / 1000);
  }

  private write(
    name: MetricName,
    labels: readonly string[],
    update: (value: number) => number,
  ): void {
    let family = this.families.get(name);
    if (!family) {
      family = new Map();
      this.families.set(name, family);
    }
    const key = labelKey(labels);
    const series = family.get(key);
    if (series) series.value = update(series.value);
    else family.set(key, { labels, value: update(0) });
  }

  /** Families by name, each with its series sorted by label values; empty ones left out. */
  private sortedFamilies(): [MetricName, Series[]][] {
    return [...this.families]
      .filter(([, family]) => family.size > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, family]) => [
        name,
        [...family.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s),
      ]);
  }
}

/**
 * A metric's label values in declaration order. Throws if `labels` does not have
 * exactly the declared names: a programming error the type system usually catches.
 */
function labelValues(name: MetricName, labels: Record<string, string> | undefined): string[] {
  const declared: readonly string[] = METRICS[name].labels;
  const given = labels ?? {};
  const keys = Object.keys(given);
  if (keys.length !== declared.length || !declared.every((label) => Object.hasOwn(given, label))) {
    throw new Error(
      `metric ${name} takes labels [${declared.join(", ")}], got [${keys.join(", ")}]`,
    );
  }
  return declared.map((label) => given[label]!);
}

const labelKey = (values: readonly string[]) => values.join("\0");

/** `name{label="value",...}`, or `name` without labels; values escaped for the text format. */
function seriesName(name: MetricName, values: readonly string[]): string {
  if (values.length === 0) return name;
  const declared: readonly string[] = METRICS[name].labels;
  const pairs = values.map((value, i) => `${declared[i]}="${escapeLabelValue(value)}"`);
  return `${name}{${pairs.join(",")}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
