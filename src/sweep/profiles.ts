/**
 * Network profiles: the player population a configuration is tuned against.
 *
 * A distribution rather than a single latency, because tuning against one condition
 * is the mistake this tool exists to prevent. A configuration that is excellent at
 * 30 ms and unusable at 200 ms must not win, and it only loses if the population is
 * respected while the results are aggregated.
 */

import type { WeightedSegment } from "../sim/types";

export interface NetworkProfile {
  id: string;
  name: string;
  description: string;
  segments: WeightedSegment[];
}

/** Weights are permille, so a whole population sums to 1000. */
export const FULL_WEIGHT = 1000;

function segment(
  weightPermille: number,
  rttMeanMs: number,
  rttJitterMs: number,
  lossPct: number,
  burstLoss = false,
): WeightedSegment {
  return {
    weightPermille,
    rttMeanMs,
    rttJitterMs,
    lossPct,
    reorderPct: 0,
    duplicatePct: 0,
    burstLoss,
  };
}

/**
 * Shipped profiles. Weights describe who is actually playing, which is the input
 * that decides which configuration wins.
 */
export const PROFILES: NetworkProfile[] = [
  {
    id: "mixed",
    name: "Mixed consumer",
    description:
      "A broad player base: mostly broadband, a fifth on mobile, a tail on a bad link.",
    segments: [
      segment(250, 30, 5, 0),
      segment(350, 60, 15, 1),
      segment(200, 90, 30, 2),
      segment(150, 140, 25, 1),
      segment(50, 220, 60, 8, true),
    ],
  },
  {
    id: "competitive",
    name: "Competitive",
    description: "Wired players near a datacenter. Low latency, almost no loss.",
    segments: [segment(300, 4, 1, 0), segment(500, 30, 5, 0), segment(200, 60, 15, 1)],
  },
  {
    id: "global",
    name: "Global",
    description: "Players routed across continents, with a real long-distance tail.",
    segments: [
      segment(200, 60, 15, 1),
      segment(300, 140, 25, 1),
      segment(300, 220, 60, 8, true),
      segment(200, 90, 30, 2),
    ],
  },
  {
    id: "mobile",
    name: "Mobile",
    description: "Cellular players. High jitter and burst loss dominate.",
    segments: [segment(400, 90, 30, 2), segment(400, 140, 25, 1), segment(200, 220, 60, 8, true)],
  },
];

export function totalWeight(segments: readonly WeightedSegment[]): number {
  return segments.reduce((sum, s) => sum + s.weightPermille, 0);
}

/**
 * True when the weights describe a whole population.
 *
 * The core renormalizes whatever it is given, so a profile that does not sum to one
 * still runs. It would just be answering a different question than the one on screen,
 * which is why the interface says so rather than silently correcting it.
 */
export function weightsAreWhole(segments: readonly WeightedSegment[]): boolean {
  return totalWeight(segments) === FULL_WEIGHT;
}

export function describeSegment(s: WeightedSegment): string {
  const parts = [`${s.rttMeanMs} ms`];
  if (s.rttJitterMs > 0) parts.push(`±${s.rttJitterMs} jitter`);
  if (s.lossPct > 0) parts.push(`${s.lossPct}% loss${s.burstLoss ? " in bursts" : ""}`);
  return parts.join(", ");
}
