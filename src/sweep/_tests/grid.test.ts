import { describe, expect, it } from "vitest";
import {
  activeAxes,
  AXES,
  buildGrid,
  DEFAULT_SEED_COUNT,
  gridSize,
  inertAxes,
  planSweep,
  RESOLUTION_FLOOR,
  seedList,
  TECHNIQUE_PRESETS,
} from "../grid";
import { ALL_TECHNIQUES, DEFAULT_CONFIG, NO_TECHNIQUES, type TechniqueSet } from "../../sim/types";

const predicting: TechniqueSet = { ...ALL_TECHNIQUES };
const viewer: TechniqueSet = { ...NO_TECHNIQUES, entityInterpolation: true };

describe("buildGrid", () => {
  it("produces every combination of the axes", () => {
    const axes = [
      { key: "inputBufferTicks" as const, label: "a", values: [1, 2], format: String },
      {
        key: "snapThresholdPermille" as const,
        label: "b",
        values: [4, 5, 6],
        format: String,
      },
    ];
    const grid = buildGrid(axes, DEFAULT_CONFIG);
    expect(grid).toHaveLength(6);
    expect(gridSize(axes)).toBe(6);
  });

  it("sets each swept value on the config it belongs to", () => {
    const axes = [
      { key: "inputBufferTicks" as const, label: "a", values: [3], format: String },
    ];
    const [only] = buildGrid(axes, DEFAULT_CONFIG);
    expect(only?.inputBufferTicks).toBe(3);
    // every other field must survive untouched, or the sweep would be varying more
    // than the axis it claims to
    expect(only?.correctionBlendPermille).toBe(DEFAULT_CONFIG.correctionBlendPermille);
  });

  it("carries the base technique set onto every configuration", () => {
    const grid = buildGrid(AXES.slice(0, 2), { ...DEFAULT_CONFIG, techniques: viewer });
    expect(grid.every((c) => c.techniques.entityInterpolation)).toBe(true);
    expect(grid.every((c) => !c.techniques.clientPrediction)).toBe(true);
  });

  /**
   * The same request has to produce the same grid in the same order, or a sweep
   * cannot be reproduced from its inputs and a recommendation cannot be audited.
   */
  it("is deterministic in content and order", () => {
    expect(buildGrid(AXES, DEFAULT_CONFIG)).toEqual(buildGrid(AXES, DEFAULT_CONFIG));
  });

  it("returns the base alone when there are no axes", () => {
    expect(buildGrid([], DEFAULT_CONFIG)).toEqual([DEFAULT_CONFIG]);
  });
});

describe("axis activity", () => {
  /**
   * Interpolation delay only acts on a client that does not predict, since a
   * predicting client draws its own simulation rather than the received-state buffer.
   * Sweeping it under prediction would emit duplicate points under different labels.
   */
  it("drops interpolation delay while the client predicts", () => {
    const active = activeAxes(predicting).map((a) => a.key);
    expect(active).not.toContain("interpolationDelayTicks");
    expect(inertAxes(predicting).map((a) => a.key)).toEqual(["interpolationDelayTicks"]);
  });

  it("keeps interpolation delay for a client that interpolates", () => {
    expect(activeAxes(viewer).map((a) => a.key)).toContain("interpolationDelayTicks");
    expect(inertAxes(viewer)).toHaveLength(0);
  });

  it("every axis declares values and a formatter", () => {
    for (const axis of AXES) {
      expect(axis.values.length).toBeGreaterThan(1);
      expect(axis.format(axis.values[0] as number)).toBeTruthy();
    }
  });

  /**
   * Values clustered around the default can only confirm it. They have to span the
   * usable range for the sweep to be able to disagree with the current setting.
   */
  it("spreads each axis across a range rather than around the default", () => {
    for (const axis of AXES) {
      const low = Math.min(...axis.values);
      const high = Math.max(...axis.values);
      expect(high).toBeGreaterThan(low * 2);
    }
  });
});

describe("planSweep", () => {
  it("counts runs as configurations times seeds times segments", () => {
    const plan = planSweep(predicting, 8, 5);
    expect(plan.runCount).toBe(plan.configs.length * 8 * 5);
  });

  it("excludes the inert axis from the grid it plans", () => {
    const plan = planSweep(predicting, 4, 3);
    expect(plan.configs).toHaveLength(gridSize(activeAxes(predicting)));
    expect(plan.inert.map((a) => a.key)).toEqual(["interpolationDelayTicks"]);
  });

  it("plans a larger grid when the inert axis becomes active", () => {
    expect(planSweep(viewer, 4, 3).configs.length).toBeGreaterThan(
      planSweep(predicting, 4, 3).configs.length,
    );
  });

  /**
   * A count of zero would divide the progress bar by zero and report a sweep that
   * runs nothing as complete.
   */
  it("never plans fewer than one seed or segment", () => {
    expect(planSweep(predicting, 0, 0).runCount).toBe(planSweep(predicting, 1, 1).runCount);
  });
});

describe("seedList", () => {
  it("is counting numbers rather than anything drawn from a clock", () => {
    expect(seedList(4)).toEqual([1n, 2n, 3n, 4n]);
  });

  it("returns the same list every time", () => {
    expect(seedList(8)).toEqual(seedList(8));
  });

  it("returns one seed for a zero request", () => {
    expect(seedList(0)).toEqual([1n]);
  });
});

describe("measured defaults", () => {
  /**
   * Both numbers come from a variance measurement recorded in the log, not from a
   * guess. Pinned so a later edit that lowers the seed count has to revisit the
   * measurement rather than quietly claiming a precision it no longer has.
   */
  it("keeps the seed count and resolution floor the measurement produced", () => {
    expect(DEFAULT_SEED_COUNT).toBe(8);
    expect(RESOLUTION_FLOOR).toBeCloseTo(0.029, 3);
  });
});

describe("technique presets", () => {
  it("ships a viewer preset where the interpolation axis is active", () => {
    const preset = TECHNIQUE_PRESETS.find((p) => p.label === "Interpolating viewer");
    expect(preset).toBeDefined();
    expect(inertAxes(preset?.techniques as TechniqueSet)).toHaveLength(0);
  });

  /**
   * A preset the core rejects would spend a sweep producing nothing. Reconciliation
   * and rollback both need prediction.
   */
  it("every preset is a combination the core accepts", () => {
    for (const { label, techniques } of TECHNIQUE_PRESETS) {
      if (techniques.serverReconciliation || techniques.rollback) {
        expect(techniques.clientPrediction, label).toBe(true);
      }
    }
  });
});
