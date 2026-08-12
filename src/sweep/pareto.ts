/**
 * The Pareto front: configurations where responsiveness cannot improve without
 * costing smoothness.
 *
 * Computed here rather than in the core because it is cheap comparison logic over
 * results that have already crossed the boundary, and because pure TypeScript is
 * where a property test over random metric sets is easy to write.
 *
 * Both axes are lower-is-better, and both are already normalized against fixed
 * anchors by the core. Comparing raw metrics instead would let whichever quantity
 * has the larger numeric range decide every point.
 */

import type { SweepPoint } from "../sim/types";

/** What the front is computed over. Kept minimal so the logic is testable alone. */
export interface Scored {
  responsiveness: number;
  smoothness: number;
}

/**
 * True when `a` is at least as good on both axes and strictly better on one.
 *
 * The strictness matters: without it two points with identical scores would dominate
 * each other, and both would be excluded from a front they both belong on.
 */
export function dominates(a: Scored, b: Scored): boolean {
  const noWorse = a.responsiveness <= b.responsiveness && a.smoothness <= b.smoothness;
  const better = a.responsiveness < b.responsiveness || a.smoothness < b.smoothness;
  return noWorse && better;
}

/**
 * Indices of the non-dominated points, in the order they were given.
 *
 * Quadratic, which is the right cost here: a sweep produces hundreds of points, not
 * millions, and the obvious algorithm is the one that can be checked by eye against
 * the definition.
 */
export function paretoIndices(points: readonly Scored[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const candidate = points[i] as Scored;
    const beaten = points.some(
      (other, j) => j !== i && dominates(other, candidate),
    );
    if (!beaten) out.push(i);
  }
  return out;
}

/**
 * Front points sorted along the tradeoff, so a line through them reads as a curve.
 *
 * Sorted by responsiveness ascending; smoothness then descends, because a point that
 * is better on both would have dominated its neighbour and not be here.
 */
export function frontOrder(points: readonly Scored[], indices: readonly number[]): number[] {
  return [...indices].sort((a, b) => {
    const pa = points[a] as Scored;
    const pb = points[b] as Scored;
    return pa.responsiveness - pb.responsiveness || pa.smoothness - pb.smoothness;
  });
}

/**
 * The point closest to the ideal corner, as a starting suggestion.
 *
 * Distance to the origin of the two normalized scores. This is a *suggestion*, not
 * the answer: which end of the front to take is the tradeoff the tool exists to
 * show, and collapsing it to one number would hide it. The interface says so.
 */
export function balancedIndex(points: readonly Scored[], indices: readonly number[]): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const i of indices) {
    const p = points[i] as Scored;
    const distance = Math.hypot(p.responsiveness, p.smoothness);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

export interface ConfigDifference {
  label: string;
  left: string;
  right: string;
}

/**
 * Fields that differ between two configurations.
 *
 * Takes a describer rather than reading the config directly, so the rows shown in the
 * diff are the same rows shown in the config panel and the two cannot drift.
 */

export function differences(
  left: SweepPoint,
  right: SweepPoint,
  describe: (config: SweepPoint["config"]) => Array<{ label: string; value: string }>,
): ConfigDifference[] {
  const a = describe(left.config);
  const b = describe(right.config);
  const out: ConfigDifference[] = [];
  a.forEach((row, i) => {
    const other = b[i];
    if (other && other.value !== row.value) {
      out.push({ label: row.label, left: row.value, right: other.value });
    }
  });
  return out;
}
