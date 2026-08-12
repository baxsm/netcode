import { describe, expect, it } from "vitest";
import {
  balancedIndex,
  dominates,
  frontOrder,
  paretoIndices,
  type Scored,
} from "../pareto";

const at = (responsiveness: number, smoothness: number): Scored => ({
  responsiveness,
  smoothness,
});

/**
 * A seeded generator, so a failing case is reproducible rather than appearing once
 * and never again. Math.random would make a property failure unreportable.
 */
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function randomPoints(next: () => number, count: number): Scored[] {
  return Array.from({ length: count }, () =>
    // rounded to two places so ties occur, which is the case that separates a
    // correct dominance rule from one missing its strictness check
    at(Math.round(next() * 100) / 100, Math.round(next() * 100) / 100),
  );
}

describe("dominates", () => {
  it("is true when better on both axes", () => {
    expect(dominates(at(1, 1), at(2, 2))).toBe(true);
  });

  it("is true when better on one and equal on the other", () => {
    expect(dominates(at(1, 2), at(2, 2))).toBe(true);
    expect(dominates(at(2, 1), at(2, 2))).toBe(true);
  });

  it("is false when worse on either axis", () => {
    expect(dominates(at(1, 3), at(2, 2))).toBe(false);
    expect(dominates(at(3, 1), at(2, 2))).toBe(false);
  });

  /**
   * Without the strictness check two identical points dominate each other, and both
   * get excluded from a front they both belong on.
   */
  it("is false for two identical points", () => {
    expect(dominates(at(2, 2), at(2, 2))).toBe(false);
  });
});

describe("paretoIndices", () => {
  it("keeps every point when none dominates another", () => {
    const points = [at(1, 3), at(2, 2), at(3, 1)];
    expect(paretoIndices(points)).toEqual([0, 1, 2]);
  });

  it("drops a point beaten on both axes", () => {
    const points = [at(1, 1), at(2, 2)];
    expect(paretoIndices(points)).toEqual([0]);
  });

  it("keeps both of two equal points", () => {
    expect(paretoIndices([at(2, 2), at(2, 2)])).toEqual([0, 1]);
  });

  it("returns nothing for an empty sweep", () => {
    expect(paretoIndices([])).toEqual([]);
  });

  it("returns the only point of a single-point sweep", () => {
    expect(paretoIndices([at(9, 9)])).toEqual([0]);
  });

  /**
   * The definition, checked exhaustively on random sets rather than on cases chosen
   * to pass. Both halves matter: an implementation that returns everything satisfies
   * the first and fails the second.
   */
  it("includes no dominated point and excludes no non-dominated one", () => {
    const next = generator(20_260_812);
    for (let round = 0; round < 200; round += 1) {
      const points = randomPoints(next, 1 + Math.floor(next() * 25));
      const front = new Set(paretoIndices(points));

      points.forEach((candidate, i) => {
        const beaten = points.some((other, j) => j !== i && dominates(other, candidate));
        expect(front.has(i), `point ${i} of round ${round}`).toBe(!beaten);
      });
    }
  });

  it("does not depend on the order the points arrive in", () => {
    const next = generator(7);
    for (let round = 0; round < 50; round += 1) {
      const points = randomPoints(next, 12);
      const forward = paretoIndices(points).map((i) => points[i] as Scored);
      const reversed = paretoIndices([...points].reverse()).map(
        (i) => [...points].reverse()[i] as Scored,
      );

      const key = (p: Scored) => `${p.responsiveness}:${p.smoothness}`;
      expect(forward.map(key).sort()).toEqual(reversed.map(key).sort());
    }
  });
});

describe("frontOrder", () => {
  /**
   * The front is drawn as a connected line, so the points have to walk the tradeoff.
   * Unsorted they would zigzag and read as noise rather than a curve.
   */
  it("walks responsiveness ascending so a line through it reads as a curve", () => {
    const points = [at(3, 1), at(1, 3), at(2, 2)];
    const ordered = frontOrder(points, paretoIndices(points));
    expect(ordered.map((i) => (points[i] as Scored).responsiveness)).toEqual([1, 2, 3]);
  });

  it("has smoothness descending across a real front", () => {
    const next = generator(99);
    const points = randomPoints(next, 30);
    const ordered = frontOrder(points, paretoIndices(points));
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = points[ordered[i - 1] as number] as Scored;
      const current = points[ordered[i] as number] as Scored;
      expect(current.smoothness).toBeLessThanOrEqual(previous.smoothness);
    }
  });
});

describe("balancedIndex", () => {
  it("picks the point nearest the ideal corner", () => {
    const points = [at(0.1, 0.9), at(0.5, 0.5), at(0.9, 0.1)];
    expect(balancedIndex(points, [0, 1, 2])).toBe(1);
  });

  it("is null when there is no front to choose from", () => {
    expect(balancedIndex([], [])).toBeNull();
  });
});
