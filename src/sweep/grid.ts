/**
 * The configuration grid the sweep runs over.
 *
 * A full grid across every constant is combinatorially infeasible, so the ranges are
 * deliberately coarse and the count is reported before the run starts. What must
 * never happen is a bounded search presenting as complete coverage.
 */

import {
  ALL_TECHNIQUES,
  DEFAULT_CONFIG,
  type NetcodeConfig,
  type TechniqueSet,
} from "../sim/types";

/** One tuning constant and the values the sweep tries for it. */
export interface Axis {
  key: SweptKey;
  label: string;
  values: number[];
  /** How a value reads in the interface, in the unit the decision is argued in. */
  format: (value: number) => string;
  /**
   * Set when the constant only acts on a client that does not predict.
   *
   * Interpolation delay indexes into the buffer of received states, and a predicting
   * client draws its own simulation instead of that buffer. Sweeping it while
   * prediction is on produces identical points under different labels, which reads as
   * a flat region of the front rather than as a knob doing nothing.
   */
  inertUnderPrediction?: boolean;
}

export type SweptKey =
  | "interpolationDelayTicks"
  | "inputBufferTicks"
  | "correctionBlendPermille"
  | "snapThresholdPermille";

/**
 * Default ranges, shipped rather than left as empty fields.
 *
 * Values are spread across the usable range rather than clustered near the default,
 * because a sweep that only tries neighbours of the current setting can only ever
 * confirm it.
 *
 * Three constants from `NetcodeConfig` are deliberately not swept, because measuring
 * them showed none of them moves either score:
 *
 * - **Rollback window** only clamps the depth that gets *reported*. It bounds a
 *   metric rather than changing what the simulation does.
 * - **Extrapolation limit** only acts when the state buffer cannot reach the render
 *   tick, which a predicting client never asks it to.
 * - **Server rewind limit** is the one that changes a real outcome. On a scenario
 *   that fires, raising it from 0 to 200 ms takes hit registration from 35% to 100%.
 *   It stays off the grid anyway because hit registration is not a term in either
 *   score, so every value it takes returns the same two coordinates and the front
 *   would gain duplicate points under different labels. Tuning it is a separate
 *   question with a direct answer, which `/verify` shows rather than searching for:
 *   the limit has to cover the round trip of the players being compensated for.
 *
 * Sweeping all three would multiply the grid by 36 while every added point returned a
 * duplicate result under a different label, which reads as a flat front rather than
 * as knobs that do nothing.
 */
export const AXES: Axis[] = [
  {
    key: "inputBufferTicks",
    label: "Input buffer",
    values: [0, 1, 2, 4, 6, 8],
    format: (v) => `${v} ticks`,
  },
  {
    key: "correctionBlendPermille",
    label: "Correction blend",
    values: [100, 300, 500, 700, 850, 950],
    format: (v) => `${(v / 10).toFixed(0)}% error kept`,
  },
  {
    // above roughly 15 units nothing ever exceeds the threshold, so a snap never
    // fires and every larger value produces an identical result. the range stops
    // where the constant stops acting rather than where the field would allow
    key: "snapThresholdPermille",
    label: "Snap threshold",
    values: [500, 1_000, 2_000, 4_000, 8_000, 15_000],
    format: (v) => `${(v / 1000).toFixed(1)} units`,
  },
  {
    key: "interpolationDelayTicks",
    label: "Interpolation delay",
    values: [1, 3, 6, 12],
    format: (v) => `${v} ticks`,
    inertUnderPrediction: true,
  },
];

/** Axes that will actually change the result under the given technique set. */
export function activeAxes(techniques: TechniqueSet): Axis[] {
  return AXES.filter((axis) => !(axis.inertUnderPrediction && techniques.clientPrediction));
}

/** Axes whose values the sweep would vary without any of them changing a result. */
export function inertAxes(techniques: TechniqueSet): Axis[] {
  return AXES.filter((axis) => axis.inertUnderPrediction && techniques.clientPrediction);
}

export function gridSize(axes: readonly Axis[]): number {
  return axes.reduce((total, axis) => total * Math.max(1, axis.values.length), 1);
}

/**
 * Every combination of the given axes, on top of a base configuration.
 *
 * Emitted in a fixed nested order so the same request always produces the same list,
 * which is what makes a sweep reproducible from its inputs alone.
 */
export function buildGrid(axes: readonly Axis[], base: NetcodeConfig): NetcodeConfig[] {
  let out: NetcodeConfig[] = [base];
  for (const axis of axes) {
    const next: NetcodeConfig[] = [];
    for (const config of out) {
      for (const value of axis.values) {
        next.push({ ...config, [axis.key]: value });
      }
    }
    out = next;
  }
  return out;
}

export interface SweepPlan {
  configs: NetcodeConfig[];
  axes: Axis[];
  /** Axes held at their default because they cannot act, named so the UI can say so. */
  inert: Axis[];
  runCount: number;
}

/**
 * What a sweep will actually do, worked out before it starts.
 *
 * The run count is the honest cost: configurations times seeds times segments. It is
 * shown in advance so the size of the search is visible rather than discovered by
 * waiting.
 */
export function planSweep(
  techniques: TechniqueSet,
  seedCount: number,
  segmentCount: number,
): SweepPlan {
  const axes = activeAxes(techniques);
  const configs = buildGrid(axes, { ...DEFAULT_CONFIG, techniques });
  return {
    configs,
    axes,
    inert: inertAxes(techniques),
    runCount: configs.length * Math.max(1, seedCount) * Math.max(1, segmentCount),
  };
}

/**
 * Seeds the sweep runs each configuration against.
 *
 * Counting numbers rather than anything drawn from a clock, so the same sweep is
 * reproducible from its inputs alone and a recommendation can be audited later.
 */
export function seedList(count: number): bigint[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => BigInt(i + 1));
}

/**
 * Seeds per configuration, chosen from a measured variance rather than guessed.
 *
 * Smoothness carries essentially all the run-to-run noise; responsiveness is two
 * orders of magnitude more stable. Its spread falls from 0.031 at one seed to 0.014
 * at eight, then only to 0.012 at sixteen, so eight is the knee. The full
 * measurement is in docs/log.md.
 */
export const DEFAULT_SEED_COUNT = 8;

/**
 * The smallest score difference the tool can honestly distinguish, at the default
 * seed count. Two standard deviations of the smoothness score.
 *
 * Reported in the interface, because presenting a gap narrower than this as a real
 * difference between configurations would be false precision.
 */
export const RESOLUTION_FLOOR = 0.029;

export const TECHNIQUE_PRESETS: Array<{ label: string; techniques: TechniqueSet }> = [
  { label: "Full stack", techniques: ALL_TECHNIQUES },
  {
    label: "Predict and reconcile",
    techniques: {
      clientPrediction: true,
      serverReconciliation: true,
      entityInterpolation: false,
      extrapolation: false,
      serverRewind: true,
      rollback: false,
    },
  },
  {
    label: "Interpolating viewer",
    techniques: {
      clientPrediction: false,
      serverReconciliation: false,
      entityInterpolation: true,
      extrapolation: true,
      serverRewind: false,
      rollback: false,
    },
  },
];
