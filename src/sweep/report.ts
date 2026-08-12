/**
 * The exported report: everything needed to review a recommendation without the tool.
 *
 * Self-contained on purpose. A config alone does not say what it was chosen against,
 * and a result that cannot be re-derived is an assertion rather than a measurement.
 */

import type { InputEventSpec, Metrics, ScenarioSpec, SweepPoint } from "../sim/types";
import type { NetworkProfile } from "./profiles";
import { correctionsPerMinute } from "./metrics-view";

export const SCHEMA_VERSION = 1;

export interface ReportInput {
  scenario: ScenarioSpec;
  scenarioId: string;
  scenarioName: string;
  /** The inputs the run received. Two configurations only compare under the same ones. */
  script: readonly InputEventSpec[];
  profile: NetworkProfile;
  seeds: readonly number[];
  points: readonly SweepPoint[];
  frontIndices: readonly number[];
  chosenIndex: number;
  coreVersion: string;
  resolutionFloor: number;
}

function pointJson(point: SweepPoint, scenario: ScenarioSpec) {
  return {
    config: {
      techniques: point.config.techniques,
      interpolationDelayTicks: point.config.interpolationDelayTicks,
      inputBufferTicks: point.config.inputBufferTicks,
      rollbackWindowTicks: point.config.rollbackWindowTicks,
      correctionBlendRate: point.config.correctionBlendPermille / 1000,
      snapThresholdUnits: point.config.snapThresholdPermille / 1000,
      serverRewindLimitMs: point.config.serverRewindLimitMs,
      extrapolationLimitTicks: point.config.extrapolationLimitTicks,
    },
    metrics: playerVisible(point.metrics, scenario),
    scores: { responsiveness: point.responsiveness, smoothness: point.smoothness },
    configHash: point.configHash.toString(),
  };
}

/** Metrics in the units the decision is argued in, not the raw buffer fields. */
function playerVisible(metrics: Metrics, scenario: ScenarioSpec) {
  return {
    inputLatencyMeanMs: metrics.inputLatencyMeanMs,
    divergenceP99Units: metrics.divergenceP99,
    worstRubberBandUnits: metrics.correctionMagnitudeMax,
    correctionsPerMinute: correctionsPerMinute(metrics, scenario),
    packetsSent: metrics.packetsSent,
    packetsDropped: metrics.packetsDropped,
  };
}

export function buildReport(input: ReportInput): string {
  const chosen = input.points[input.chosenIndex];
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      core: input.coreVersion,
      // the script travels with the constants, since a configuration is only
      // comparable against another that received the same inputs
      scenario: {
        id: input.scenarioId,
        name: input.scenarioName,
        ...input.scenario,
        inputScript: [...input.script],
      },
      profile: {
        id: input.profile.id,
        name: input.profile.name,
        segments: input.profile.segments,
      },
      seeds: [...input.seeds],
      // the smallest score gap the seed count can honestly resolve, carried with the
      // result so a reader does not read a difference narrower than the noise floor
      // as a real one
      resolutionFloor: input.resolutionFloor,
      chosen: chosen ? pointJson(chosen, input.scenario) : null,
      front: input.frontIndices
        .map((i) => input.points[i])
        .filter((p): p is SweepPoint => p !== undefined)
        .map((p) => pointJson(p, input.scenario)),
    },
    null,
    2,
  );
}

/** Hands a string to the browser as a file download. */
export function downloadJson(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
