/**
 * The CI baseline check: does this build still meet the netcode quality it was
 * signed off at?
 *
 * The feature that keeps paying after tuning is finished, because netcode quality
 * rots silently as gameplay features land. Nothing about a correction budget shows up
 * in a type error or a failing unit test.
 *
 * Pure so it can be tested without a runner. The runner reads files and exits; this
 * decides.
 */

import type { Metrics, MetricField } from "../sim/types";

export const BASELINE_SCHEMA_VERSION = 1;

/** Comparisons a threshold can make, named as the assertion they express. */
export const COMPARISONS = ["atMost", "atLeast"] as const;
export type Comparison = (typeof COMPARISONS)[number];

export interface Threshold {
  metric: MetricField;
  comparison: Comparison;
  value: number;
}

export interface Baseline {
  schemaVersion: number;
  name: string;
  scenarioId: string;
  /** Preset index the run uses, matching `SEGMENT_PRESETS`. */
  segmentIndex: number;
  /** Pinned so the check is deterministic. A single seed has no run-to-run spread. */
  seeds: number[];
  config: Record<string, unknown>;
  thresholds: Threshold[];
}

export interface CheckedThreshold extends Threshold {
  measured: number;
  passed: boolean;
}

export interface CheckOutcome {
  passed: boolean;
  rows: CheckedThreshold[];
}

function holds(comparison: Comparison, measured: number, value: number): boolean {
  return comparison === "atMost" ? measured <= value : measured >= value;
}

/**
 * The mean of a metric across the pinned seeds.
 *
 * Averaged rather than checked per seed, because a per-seed assertion turns one
 * unlucky seed into a red build. The seeds are pinned, so the mean is exact rather
 * than an estimate with a spread around it.
 */
export function meanOf(runs: readonly Metrics[], metric: MetricField): number {
  if (runs.length === 0) return Number.NaN;
  return runs.reduce((sum, run) => sum + run[metric], 0) / runs.length;
}

export function check(baseline: Baseline, runs: readonly Metrics[]): CheckOutcome {
  const rows = baseline.thresholds.map((threshold) => {
    const measured = meanOf(runs, threshold.metric);
    return {
      ...threshold,
      measured,
      // a metric that came back as NaN fails rather than passing by comparison, since
      // every comparison against NaN is false in one direction and true in the other
      passed: Number.isFinite(measured) && holds(threshold.comparison, measured, threshold.value),
    };
  });
  return { passed: rows.length > 0 && rows.every((row) => row.passed), rows };
}

/**
 * The failure report, as a table a reader can act on.
 *
 * Names the metric, what was expected, what was measured, and by how much it missed.
 * A bare non-zero exit would tell a developer their build failed without telling them
 * which budget they spent.
 */
export function formatOutcome(baseline: Baseline, outcome: CheckOutcome): string {
  const lines = [
    `baseline: ${baseline.name}`,
    `scenario: ${baseline.scenarioId}, segment ${baseline.segmentIndex}, seeds ${baseline.seeds.join(", ")}`,
    "",
  ];

  const width = Math.max(...outcome.rows.map((row) => row.metric.length), 6);
  for (const row of outcome.rows) {
    const verb = row.comparison === "atMost" ? "<=" : ">=";
    const drift = row.measured - row.value;
    const by =
      row.passed || !Number.isFinite(drift)
        ? ""
        : `  off by ${drift > 0 ? "+" : ""}${drift.toFixed(4)}`;
    lines.push(
      `${row.passed ? "pass" : "FAIL"}  ${row.metric.padEnd(width)}  ` +
        `measured ${row.measured.toFixed(4)} ${verb} ${row.value}${by}`,
    );
  }

  lines.push("");
  lines.push(
    outcome.passed
      ? "every threshold held"
      : `${outcome.rows.filter((row) => !row.passed).length} of ${outcome.rows.length} thresholds failed`,
  );
  return lines.join("\n");
}

/**
 * Reads a baseline file, rejecting rather than repairing.
 *
 * A baseline that reached the runner with a mistyped metric name would compare
 * against `undefined` and report a failure that is really a typo, so the field names
 * are checked against the mirror before anything runs.
 *
 * `segmentCount` bounds the preset index for the same reason. The core resolves the
 * index with a catch-all arm, because a numeric boundary has to be total, so an index
 * past the end arrives as the hostile preset and measures a link nobody asked for.
 * That reads as a quality regression on a good build, which is the one verdict this
 * runner must never invent.
 */
export function parseBaseline(
  raw: string,
  knownMetrics: readonly string[],
  segmentCount: number,
): Baseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`the baseline file is not valid JSON: ${String(cause)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the baseline file does not describe a baseline");
  }
  const value = parsed as Record<string, unknown>;

  if (value.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `the baseline is schema version ${String(value.schemaVersion)}, and this build reads version ${BASELINE_SCHEMA_VERSION}`,
    );
  }

  const seeds = Array.isArray(value.seeds) ? value.seeds : [];
  if (seeds.length === 0 || !seeds.every((seed) => Number.isInteger(seed))) {
    throw new Error("the baseline needs at least one whole-number seed");
  }

  const thresholds = Array.isArray(value.thresholds) ? value.thresholds : [];
  if (thresholds.length === 0) {
    throw new Error("the baseline has no thresholds, so it would pass without checking anything");
  }

  for (const [i, threshold] of thresholds.entries()) {
    if (typeof threshold !== "object" || threshold === null) {
      throw new Error(`threshold ${i + 1} is not an object`);
    }
    const t = threshold as Record<string, unknown>;
    if (typeof t.metric !== "string" || !knownMetrics.includes(t.metric)) {
      throw new Error(
        `threshold ${i + 1} names metric "${String(t.metric)}", which this core does not report`,
      );
    }
    if (t.comparison !== "atMost" && t.comparison !== "atLeast") {
      throw new Error(
        `threshold ${i + 1} has comparison "${String(t.comparison)}", expected atMost or atLeast`,
      );
    }
    if (typeof t.value !== "number" || !Number.isFinite(t.value)) {
      throw new Error(`threshold ${i + 1} needs a finite value`);
    }
  }

  if (typeof value.scenarioId !== "string" || !value.scenarioId) {
    throw new Error("the baseline needs a scenarioId");
  }
  if (typeof value.segmentIndex !== "number" || !Number.isInteger(value.segmentIndex)) {
    throw new Error("the baseline needs a whole-number segmentIndex");
  }
  if (value.segmentIndex < 0 || value.segmentIndex >= segmentCount) {
    throw new Error(
      `the baseline names segment ${value.segmentIndex}, and this core has ${segmentCount} (0 to ${segmentCount - 1})`,
    );
  }

  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name: typeof value.name === "string" ? value.name : "unnamed",
    scenarioId: value.scenarioId,
    segmentIndex: value.segmentIndex,
    seeds: seeds as number[],
    config: (value.config as Record<string, unknown>) ?? {},
    thresholds: thresholds as Threshold[],
  };
}
