import { describe, expect, it } from "vitest";
import {
  BASELINE_SCHEMA_VERSION,
  check,
  formatOutcome,
  meanOf,
  parseBaseline,
  type Baseline,
} from "../check";
import { METRIC_FIELDS, type Metrics } from "../../sim/types";

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  const base = Object.fromEntries(METRIC_FIELDS.map((f) => [f, 0])) as Record<
    (typeof METRIC_FIELDS)[number],
    number
  >;
  return { ...base, stateHash: 0n, ...overrides };
}

const baseline: Baseline = {
  schemaVersion: BASELINE_SCHEMA_VERSION,
  name: "A baseline",
  scenarioId: "drift",
  segmentIndex: 3,
  seeds: [1, 2],
  config: {},
  thresholds: [
    { metric: "divergenceP99", comparison: "atMost", value: 2 },
    { metric: "hitRegistrationAccuracy", comparison: "atLeast", value: 0.9 },
  ],
};

function json(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...baseline, ...overrides });
}

describe("averaging across the pinned seeds", () => {
  it("takes the mean", () => {
    const runs = [metrics({ divergenceP99: 1 }), metrics({ divergenceP99: 3 })];
    expect(meanOf(runs, "divergenceP99")).toBe(2);
  });

  /** No runs means nothing was measured, which must not read as a passing zero. */
  it("is not a number when nothing ran", () => {
    expect(Number.isNaN(meanOf([], "divergenceP99"))).toBe(true);
  });
});

describe("checking thresholds", () => {
  it("passes when every threshold holds", () => {
    const runs = [metrics({ divergenceP99: 1.5, hitRegistrationAccuracy: 1 })];
    expect(check(baseline, runs).passed).toBe(true);
  });

  it("fails when one threshold is exceeded", () => {
    const runs = [metrics({ divergenceP99: 5, hitRegistrationAccuracy: 1 })];
    const outcome = check(baseline, runs);
    expect(outcome.passed).toBe(false);
    expect(outcome.rows.filter((r) => !r.passed).map((r) => r.metric)).toEqual([
      "divergenceP99",
    ]);
  });

  it("honours atLeast in the other direction", () => {
    const runs = [metrics({ divergenceP99: 1, hitRegistrationAccuracy: 0.5 })];
    expect(check(baseline, runs).rows[1]?.passed).toBe(false);
  });

  it("passes a threshold met exactly", () => {
    const runs = [metrics({ divergenceP99: 2, hitRegistrationAccuracy: 0.9 })];
    expect(check(baseline, runs).passed).toBe(true);
  });

  /**
   * Every comparison against NaN is false, so a metric that failed to measure would
   * pass an atLeast check by accident if it were not rejected outright.
   */
  it("fails rather than passing when a metric did not measure", () => {
    expect(check(baseline, []).passed).toBe(false);
  });

  /** A baseline with nothing to check must not report a green build. */
  it("does not pass a baseline with no thresholds", () => {
    expect(check({ ...baseline, thresholds: [] }, [metrics()]).passed).toBe(false);
  });
});

describe("the failure report", () => {
  it("names the metric, both numbers and the overshoot", () => {
    const runs = [metrics({ divergenceP99: 5, hitRegistrationAccuracy: 1 })];
    const text = formatOutcome(baseline, check(baseline, runs));
    expect(text).toContain("divergenceP99");
    expect(text).toContain("5.0000");
    expect(text).toContain("<= 2");
    expect(text).toContain("off by +3.0000");
    expect(text).toContain("1 of 2 thresholds failed");
  });

  it("says so plainly when everything held", () => {
    const runs = [metrics({ divergenceP99: 1, hitRegistrationAccuracy: 1 })];
    expect(formatOutcome(baseline, check(baseline, runs))).toContain("every threshold held");
  });

  it("carries the scenario and seeds the run was pinned to", () => {
    const text = formatOutcome(baseline, check(baseline, [metrics()]));
    expect(text).toContain("drift");
    expect(text).toContain("1, 2");
  });
});

describe("reading a baseline file", () => {
  it("accepts a well formed one", () => {
    expect(parseBaseline(json(), METRIC_FIELDS).scenarioId).toBe("drift");
  });

  it("rejects a file that is not JSON", () => {
    expect(() => parseBaseline("{nope", METRIC_FIELDS)).toThrow(/not valid JSON/);
  });

  it("rejects a different schema version", () => {
    expect(() => parseBaseline(json({ schemaVersion: 99 }), METRIC_FIELDS)).toThrow(
      /schema version/,
    );
  });

  /**
   * A mistyped metric would compare against undefined and report a failure that is
   * really a typo, so the name is checked against the mirror before anything runs.
   */
  it("rejects a metric this core does not report", () => {
    const bad = json({
      thresholds: [{ metric: "divergnceP99", comparison: "atMost", value: 2 }],
    });
    expect(() => parseBaseline(bad, METRIC_FIELDS)).toThrow(/does not report/);
  });

  it("rejects an unknown comparison", () => {
    const bad = json({
      thresholds: [{ metric: "divergenceP99", comparison: "under", value: 2 }],
    });
    expect(() => parseBaseline(bad, METRIC_FIELDS)).toThrow(/atMost or atLeast/);
  });

  it("rejects a baseline with no thresholds", () => {
    expect(() => parseBaseline(json({ thresholds: [] }), METRIC_FIELDS)).toThrow(
      /no thresholds/,
    );
  });

  it("rejects a baseline with no seeds", () => {
    expect(() => parseBaseline(json({ seeds: [] }), METRIC_FIELDS)).toThrow(/seed/);
  });

  it("rejects a threshold with a value that is not a number", () => {
    const bad = json({
      thresholds: [{ metric: "divergenceP99", comparison: "atMost", value: "two" }],
    });
    expect(() => parseBaseline(bad, METRIC_FIELDS)).toThrow(/finite value/);
  });

  it("rejects a baseline with no scenario", () => {
    expect(() => parseBaseline(json({ scenarioId: "" }), METRIC_FIELDS)).toThrow(/scenarioId/);
  });
});
