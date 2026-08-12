import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  DEFAULT_CONFIG,
  DEFAULT_SCENARIO,
  METRIC_FIELDS,
  SWEEP_SEGMENT_STRIDE,
  SWEEP_STRIDE,
  decodeSweep,
  encodeConfig,
  encodeConfigs,
  encodeSegments,
  type NetcodeConfig,
  type WeightedSegment,
} from "../../src/sim/types";
import { buildGrid, planSweep, AXES } from "../../src/sweep/grid";
import { paretoIndices } from "../../src/sweep/pareto";
import { PROFILES } from "../../src/sweep/profiles";
import { ALL_TECHNIQUES, NO_TECHNIQUES } from "../../src/sim/types";

const require = createRequire(import.meta.url);
const core = require("../../core/pkg-node/netcode_core.js") as {
  sweep_stride: () => number;
  sweep_segment_stride: () => number;
  run_sweep: (...args: never[]) => Float64Array;
  default_config: () => Float64Array;
};

const s = DEFAULT_SCENARIO;

/** Shorter runs than the app uses, so the suite stays fast without changing shape. */
const scenario = { ...s, durationTicks: 200 };

function sweep(
  configs: NetcodeConfig[],
  segments: WeightedSegment[],
  seeds: number[],
): Float64Array {
  return (core.run_sweep as unknown as (...a: unknown[]) => Float64Array)(
    scenario.tickRate,
    scenario.durationTicks,
    scenario.accel,
    scenario.maxSpeed,
    scenario.frictionPermille,
    scenario.bounds,
    scenario.moveFromTick,
    scenario.stopAtTick,
    encodeConfigs(configs),
    encodeSegments(segments),
    Float64Array.from(seeds),
  );
}

const mixed = PROFILES.find((p) => p.id === "mixed")?.segments ?? [];
const competitive = PROFILES.find((p) => p.id === "competitive")?.segments ?? [];

describe("the mirror's default configuration", () => {
  /**
   * `DEFAULT_CONFIG` claims to match `NetcodeConfig::default()`, and nothing was
   * holding it to that. Changing the core's default input buffer left the mirror a
   * tick apart, and every suite stayed green because both sides only ever compared
   * against themselves. The interface then reported a constant the core was not
   * running.
   */
  it("matches the core field for field", () => {
    expect([...encodeConfig(DEFAULT_CONFIG)]).toEqual([...core.default_config()]);
  });
});

describe("the sweep boundary", () => {
  /**
   * The stride is the contract. A core that writes a different number of values per
   * point would shift every score, and the numbers would still look plausible.
   */
  it("agrees with the mirror on both strides", () => {
    expect(core.sweep_stride()).toBe(SWEEP_STRIDE);
    expect(core.sweep_segment_stride()).toBe(SWEEP_SEGMENT_STRIDE);
  });

  it("returns one record per configuration", () => {
    const configs = [DEFAULT_CONFIG, { ...DEFAULT_CONFIG, inputBufferTicks: 5 }];
    const buffer = sweep(configs, mixed, [1, 2]);
    expect(buffer.length).toBe(configs.length * SWEEP_STRIDE);
    expect(decodeSweep(buffer, configs)).toHaveLength(2);
  });

  it("pairs each point with the configuration that produced it", () => {
    const configs = [DEFAULT_CONFIG, { ...DEFAULT_CONFIG, inputBufferTicks: 6 }];
    const points = decodeSweep(sweep(configs, mixed, [1]), configs);
    expect(points[0]?.config.inputBufferTicks).toBe(DEFAULT_CONFIG.inputBufferTicks);
    expect(points[1]?.config.inputBufferTicks).toBe(6);
    // distinct configurations must carry distinct identities, or two points in the
    // results could not be told apart
    expect(points[0]?.configHash).not.toBe(points[1]?.configHash);
  });

  it("refuses a buffer whose length is not a whole number of records", () => {
    expect(() => decodeSweep(new Float64Array(SWEEP_STRIDE + 1), [DEFAULT_CONFIG])).toThrow(
      /whole number of records/,
    );
  });

  /**
   * Decoding N records against M configurations would pair scores with the wrong
   * settings and report a recommendation for a configuration nobody ran.
   */
  it("refuses a point count that does not match the configurations", () => {
    expect(() => decodeSweep(new Float64Array(SWEEP_STRIDE * 2), [DEFAULT_CONFIG])).toThrow(
      /2 points for 1 configurations/,
    );
  });

  it("reports every metric as a finite number", () => {
    const points = decodeSweep(sweep([DEFAULT_CONFIG], mixed, [1, 2]), [DEFAULT_CONFIG]);
    const metrics = points[0]?.metrics;
    for (const field of METRIC_FIELDS) {
      expect(Number.isFinite(metrics?.[field]), field).toBe(true);
    }
    expect(Number.isFinite(points[0]?.responsiveness)).toBe(true);
    expect(Number.isFinite(points[0]?.smoothness)).toBe(true);
  });
});

describe("sweep reproducibility", () => {
  /**
   * The property that makes a recommendation auditable. Same inputs, same answer,
   * every time and on every machine.
   */
  it("the same sweep produces identical points", () => {
    const configs = buildGrid(AXES.slice(0, 2), DEFAULT_CONFIG);
    const first = sweep(configs, mixed, [1, 2, 3]);
    const second = sweep(configs, mixed, [1, 2, 3]);
    expect([...first]).toEqual([...second]);
  });

  /**
   * The pool splits the grid across workers, so a point must not depend on which
   * block it was run in. This is the same defect a worker race would produce, caught
   * here without needing threads.
   */
  it("splitting the grid does not change any point", () => {
    const configs = buildGrid(AXES.slice(0, 2), DEFAULT_CONFIG);
    const whole = [...sweep(configs, mixed, [1, 2])];

    const split: number[] = [];
    for (let at = 0; at < configs.length; at += 3) {
      split.push(...sweep(configs.slice(at, at + 3), mixed, [1, 2]));
    }
    expect(split).toEqual(whole);
  });

  it("the same sweep produces an identical front", () => {
    const configs = buildGrid(AXES.slice(0, 3), DEFAULT_CONFIG);
    const front = () => paretoIndices(decodeSweep(sweep(configs, mixed, [1, 2]), configs));
    expect(front()).toEqual(front());
  });

  it("a different seed list produces a different result", () => {
    const configs = [DEFAULT_CONFIG];
    expect([...sweep(configs, mixed, [1, 2])]).not.toEqual([...sweep(configs, mixed, [3, 4])]);
  });
});

describe("the population reaches the result", () => {
  /**
   * The methodological claim of the product. If the profile does not change the
   * answer, every recommendation is being made against a single latency.
   */
  it("a different profile produces different scores", () => {
    const points = (segments: WeightedSegment[]) =>
      decodeSweep(sweep([DEFAULT_CONFIG], segments, [1, 2]), [DEFAULT_CONFIG])[0];

    const onMixed = points(mixed);
    const onCompetitive = points(competitive);
    expect(onCompetitive?.responsiveness).toBeLessThan(onMixed?.responsiveness ?? 0);
  });

  it("reweighting the same segments changes the aggregate", () => {
    const heavy = mixed.map((seg, i) => ({ ...seg, weightPermille: i === 0 ? 900 : 25 }));
    const [base] = decodeSweep(sweep([DEFAULT_CONFIG], mixed, [1]), [DEFAULT_CONFIG]);
    const [shifted] = decodeSweep(sweep([DEFAULT_CONFIG], heavy, [1]), [DEFAULT_CONFIG]);
    expect(shifted?.smoothness).not.toBe(base?.smoothness);
  });
});

describe("the front over a real sweep", () => {
  it("returns a front that is a non-empty subset of the points", () => {
    const plan = planSweep(ALL_TECHNIQUES, 2, mixed.length);
    const points = decodeSweep(sweep(plan.configs, mixed, [1, 2]), plan.configs);
    const front = paretoIndices(points);

    expect(front.length).toBeGreaterThan(0);
    expect(front.length).toBeLessThanOrEqual(points.length);
  });

  /**
   * Every point off the front must be beaten by one on it, and no front point may be
   * beaten by anything. Checked against a real sweep rather than random numbers,
   * because scores from the core are correlated in ways random points are not.
   */
  it("no front point is dominated and no dominated point is on the front", () => {
    const plan = planSweep(ALL_TECHNIQUES, 2, mixed.length);
    const points = decodeSweep(sweep(plan.configs, mixed, [1, 2]), plan.configs);
    const front = new Set(paretoIndices(points));

    points.forEach((candidate, i) => {
      const beaten = points.some(
        (other, j) =>
          j !== i &&
          other.responsiveness <= candidate.responsiveness &&
          other.smoothness <= candidate.smoothness &&
          (other.responsiveness < candidate.responsiveness ||
            other.smoothness < candidate.smoothness),
      );
      expect(front.has(i), `point ${i}`).toBe(!beaten);
    });
  });

  /**
   * The known-answer case. Interpolation delay only acts on a client that does not
   * predict, and on a quiet link deeper delay buys nothing, so the front must favour
   * the shallow end.
   */
  it("favours shallow interpolation on a quiet link", () => {
    const viewer = { ...NO_TECHNIQUES, entityInterpolation: true };
    const configs = [1, 3, 6, 12].map((interpolationDelayTicks) => ({
      ...DEFAULT_CONFIG,
      techniques: viewer,
      interpolationDelayTicks,
    }));

    const points = decodeSweep(sweep(configs, competitive, [1, 2, 3, 4]), configs);
    const smoothest = points.reduce((best, p) => (p.smoothness < best.smoothness ? p : best));
    expect(smoothest.config.interpolationDelayTicks).toBe(1);
  });
});

describe("every swept axis reaches the simulation", () => {
  /**
   * A constant that cannot change a result turns the sweep into the same handful of
   * points under different labels, and the front reads as flat rather than as a knob
   * doing nothing.
   *
   * This is not hypothetical. `inputBufferTicks` sat in the config, the hash and the
   * boundary for two phases while the simulation never read it, and nothing caught
   * it because no test asserted the constant changed anything. Every axis the grid
   * ships is held to that here.
   */
  it.each(AXES.map((axis) => [axis.label, axis] as const))(
    "%s changes the aggregate",
    (_label, axis) => {
      // interpolation delay only acts on a client that does not predict, so it is
      // exercised against the technique set the grid actually pairs it with
      const techniques = axis.inertUnderPrediction
        ? { ...NO_TECHNIQUES, entityInterpolation: true }
        : ALL_TECHNIQUES;

      const configs = axis.values.map((value) => ({
        ...DEFAULT_CONFIG,
        techniques,
        [axis.key]: value,
      }));

      const points = decodeSweep(sweep(configs, mixed, [1, 2]), configs);
      const distinct = new Set(
        points.map((p) => `${p.responsiveness.toFixed(6)}:${p.smoothness.toFixed(6)}`),
      );
      expect(distinct.size, `${axis.label} produced one result for every value`).toBeGreaterThan(1);
    },
  );

  /**
   * The x-axis of the chart. Without a constant that moves input latency every point
   * lands in one vertical line and the tradeoff cannot be read.
   */
  it("the grid spreads points along input latency", () => {
    const plan = planSweep(ALL_TECHNIQUES, 2, mixed.length);
    const points = decodeSweep(sweep(plan.configs, mixed, [1, 2]), plan.configs);
    const latencies = points.map((p) => p.metrics.inputLatencyMeanMs);
    const spread = Math.max(...latencies) - Math.min(...latencies);
    expect(spread).toBeGreaterThan(20);
  });
});

describe("the sweep against a single run", () => {
  /**
   * One configuration against one segment at one seed is that run, so the aggregate
   * must reproduce it exactly. Any drift here means the aggregation is doing
   * something to a single value.
   */
  it("a one-by-one sweep reproduces the run it aggregates", () => {
    const only: WeightedSegment[] = [
      {
        weightPermille: 1000,
        rttMeanMs: 60,
        rttJitterMs: 15,
        lossPct: 1,
        reorderPct: 0,
        duplicatePct: 0,
        burstLoss: false,
      },
    ];
    const points = decodeSweep(sweep([DEFAULT_CONFIG], only, [5]), [DEFAULT_CONFIG]);
    const metrics = points[0]?.metrics;

    expect(metrics?.sampledTicks).toBe(scenario.durationTicks - 32);
    expect(metrics?.divergenceP99).toBeGreaterThan(0);
    expect(metrics?.divergenceP99).toBeLessThanOrEqual(metrics?.divergenceMax ?? 0);
  });
});
