/**
 * The three failure modes, each as a configuration that actually produces it.
 *
 * None of these are staged. Every one is a real run whose measured outcome is worse
 * than the same scenario under a working configuration, and the page reports the
 * measurement rather than an assertion that the failure happened. A demo that showed
 * a caption without a number behind it would be the kind of fake this project's rules
 * exist to prevent.
 */

import {
  ALL_TECHNIQUES,
  DEFAULT_CONFIG,
  NO_TECHNIQUES,
  type CustomSegmentSpec,
  type NetcodeConfig,
} from "../sim/types";
import type { MetricField } from "../sim/types";

export interface FailureDemo {
  id: string;
  title: string;
  /** What goes wrong, in the terms a player would describe it. */
  symptom: string;
  /** Why the configuration below causes it. */
  cause: string;
  /** The scenario this runs against, by id. */
  scenarioId: string;
  segment: CustomSegmentSpec;
  /** The configuration that fails. */
  broken: NetcodeConfig;
  /** The same run with the cause removed, which is what makes the failure legible. */
  fixed: NetcodeConfig;
  /** The metric that carries the failure, and which direction is worse. */
  metric: MetricField;
  metricLabel: string;
  /** True when a higher value is the failure, false when a lower one is. */
  higherIsWorse: boolean;
}

/** A link bad enough that the compensation has visible work to do. */
const LOSSY: CustomSegmentSpec = {
  rttMeanMs: 140,
  rttJitterMs: 40,
  lossPct: 8,
  reorderPct: 2,
  duplicatePct: 0,
  burstLoss: true,
};

const LONG_HAUL: CustomSegmentSpec = {
  rttMeanMs: 220,
  rttJitterMs: 60,
  lossPct: 2,
  reorderPct: 1,
  duplicatePct: 0,
  burstLoss: false,
};

export const FAILURE_DEMOS: FailureDemo[] = [
  {
    id: "divergence",
    title: "Divergence under packet loss",
    symptom:
      "The client and the server drift apart, so the player is not standing where the server thinks they are.",
    cause:
      "With no prediction and no reconciliation, the client only moves when authoritative state arrives. Every dropped packet is motion it never applies.",
    scenarioId: "drift",
    segment: LOSSY,
    broken: { ...DEFAULT_CONFIG, techniques: NO_TECHNIQUES },
    fixed: { ...DEFAULT_CONFIG, techniques: ALL_TECHNIQUES },
    metric: "divergenceP99",
    metricLabel: "p99 divergence",
    higherIsWorse: true,
  },
  {
    id: "rubber-band",
    title: "Rubber-banding from a slow blend",
    symptom:
      "Corrections arrive as long visible slides rather than being absorbed, so the player is dragged off where they aimed.",
    cause:
      "A blend rate near 1000 leaves almost the whole error in place each tick, so the client takes hundreds of milliseconds to converge and every new correction stacks on the last.",
    scenarioId: "stop-start",
    segment: LOSSY,
    broken: {
      ...DEFAULT_CONFIG,
      correctionBlendPermille: 990,
      // beyond any error this scenario produces, so nothing ever snaps and the slow
      // blend is what the run actually shows
      snapThresholdPermille: 1_000_000,
    },
    fixed: { ...DEFAULT_CONFIG, correctionBlendPermille: 700 },
    metric: "correctionMagnitudeMax",
    metricLabel: "worst rubber-band",
    higherIsWorse: true,
  },
  {
    id: "hit-registration",
    title: "Hit registration error at too low a rewind limit",
    symptom:
      "Shots that connected on the player's screen do not register, because the server resolves them against a newer world than the one they were aiming at.",
    cause:
      "The rewind limit clamps how far back the server will look. Below the client's own latency it cannot reach the state the client was drawing, so it judges the shot against a position the player never saw.",
    scenarioId: "hitreg",
    segment: LONG_HAUL,
    // 40 ms cannot reach back to what a client 220 ms away was drawing, so the server
    // resolves against a world that client never saw. 400 ms covers the round trip
    broken: { ...DEFAULT_CONFIG, serverRewindLimitMs: 40 },
    fixed: { ...DEFAULT_CONFIG, serverRewindLimitMs: 400 },
    metric: "hitRegistrationAccuracy",
    metricLabel: "hits confirmed",
    higherIsWorse: false,
  },
];

/** True when the broken run is worse than the fixed one, which is the demo's claim. */
export function demonstrates(demo: FailureDemo, brokenValue: number, fixedValue: number): boolean {
  return demo.higherIsWorse ? brokenValue > fixedValue : brokenValue < fixedValue;
}
