/**
 * How a result reads to a person.
 *
 * Every row is in a unit the decision is argued in: milliseconds, world units,
 * corrections per minute. The normalized scores the front is computed from are never
 * shown, because a number with no unit cannot be argued with.
 *
 * One ordered list, shared by every surface that shows metrics, so the same
 * quantity is always in the same place.
 */

import type { Metrics, NetcodeConfig, ScenarioSpec } from "../sim/types";
import { TECHNIQUE_FIELDS, TECHNIQUE_LABELS } from "../sim/types";

export interface MetricRow {
  label: string;
  value: string;
  /** Why the row matters, shown where there is room for it. */
  note: string;
}

/**
 * Corrections scaled to a minute rather than reported as a count.
 *
 * A raw count makes a longer scenario look worse than a shorter one running
 * identical netcode. Mirrors `corrections_per_minute` in the core, which is what the
 * smoothness score uses.
 */
export function correctionsPerMinute(metrics: Metrics, scenario: ScenarioSpec): number {
  if (metrics.sampledTicks === 0 || scenario.tickRate === 0) return 0;
  const seconds = metrics.sampledTicks / scenario.tickRate;
  return seconds > 0 ? (metrics.correctionCount / seconds) * 60 : 0;
}

export function metricRows(metrics: Metrics, scenario: ScenarioSpec): MetricRow[] {
  return [
    {
      label: "Input latency",
      value: `${metrics.inputLatencyMeanMs.toFixed(1)} ms`,
      note: "How long an input takes to reach the server and come back.",
    },
    {
      label: "Divergence p99",
      value: metrics.divergenceP99.toFixed(2),
      note: "World units between client and server, at the 99th percentile.",
    },
    {
      label: "Worst rubber-band",
      value: metrics.correctionMagnitudeMax.toFixed(2),
      note: "The largest single jump a correction moved the player.",
    },
    {
      label: "Corrections",
      value: `${correctionsPerMinute(metrics, scenario).toFixed(0)} / min`,
      note: "How often the server pulled the client back into line.",
    },
    {
      label: "Packets lost",
      value: `${metrics.packetsDropped} of ${metrics.packetsSent}`,
      note: "Across the whole population, weighted by segment.",
    },
  ];
}

/**
 * The configuration, as labelled rows. Shared by the config panel and the diff.
 *
 * The constants the sweep varies come first, then the ones it holds fixed, marked as
 * such. Listing a held constant unmarked next to a measured result would imply the
 * number was part of what produced it: on this scenario the rollback window only
 * bounds a reported depth, and the rewind limit only acts on a shot that is never
 * fired.
 */
export function configRows(config: NetcodeConfig): Array<{ label: string; value: string }> {
  return [
    {
      label: "Techniques",
      value:
        TECHNIQUE_FIELDS.filter((f) => config.techniques[f])
          .map((f) => TECHNIQUE_LABELS[f])
          .join(", ") || "none",
    },
    { label: "Input buffer", value: `${config.inputBufferTicks} ticks` },
    {
      label: "Correction blend",
      value: `${(config.correctionBlendPermille / 10).toFixed(0)}% error kept`,
    },
    {
      label: "Snap threshold",
      value: `${(config.snapThresholdPermille / 1000).toFixed(1)} units`,
    },
    {
      label: "Interpolation delay",
      value: `${config.interpolationDelayTicks} ticks${
        config.techniques.clientPrediction ? " (unused while predicting)" : ""
      }`,
    },
    { label: "Rollback window", value: `${config.rollbackWindowTicks} ticks (not swept)` },
    { label: "Server rewind limit", value: `${config.serverRewindLimitMs} ms (not swept)` },
    {
      label: "Extrapolation limit",
      value: `${config.extrapolationLimitTicks} ticks (not swept)`,
    },
  ];
}

/**
 * The configuration as the JSON a game would read.
 *
 * Permille fields become the decimals a caller expects, since the integer form
 * exists only to keep a float off the boundary into a fixed-point core.
 */
export function configJson(config: NetcodeConfig): string {
  return JSON.stringify(
    {
      techniques: config.techniques,
      interpolationDelayTicks: config.interpolationDelayTicks,
      inputBufferTicks: config.inputBufferTicks,
      rollbackWindowTicks: config.rollbackWindowTicks,
      correctionBlendRate: config.correctionBlendPermille / 1000,
      snapThresholdUnits: config.snapThresholdPermille / 1000,
      serverRewindLimitMs: config.serverRewindLimitMs,
      extrapolationLimitTicks: config.extrapolationLimitTicks,
    },
    null,
    2,
  );
}
