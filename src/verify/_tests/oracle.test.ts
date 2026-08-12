import { describe, expect, it } from "vitest";
import { ORACLE_POINTS, TOLERANCE_MS, allPassed, judge } from "../oracle";
import { FAILURE_DEMOS, demonstrates } from "../demos";

const point = ORACLE_POINTS[0];
if (!point) throw new Error("no oracle points");

describe("judging a row against the published figure", () => {
  it("passes an exact match", () => {
    expect(judge(point, point.publishedMs).passed).toBe(true);
  });

  it("passes at the edge of the tolerance in both directions", () => {
    expect(judge(point, point.publishedMs + TOLERANCE_MS).passed).toBe(true);
    expect(judge(point, point.publishedMs - TOLERANCE_MS).passed).toBe(true);
  });

  it("fails just outside the tolerance", () => {
    expect(judge(point, point.publishedMs + TOLERANCE_MS + 0.1).passed).toBe(false);
    expect(judge(point, point.publishedMs - TOLERANCE_MS - 0.1).passed).toBe(false);
  });

  /**
   * One frame is 7.8 ms at 128 tick and 6.9 ms at 144 FPS, so the tolerance has to
   * stay well under that or an off-by-one-frame error would pass as a match.
   */
  it("stays narrow enough to catch an off-by-one-frame error", () => {
    expect(TOLERANCE_MS * 2).toBeLessThan(6.9);
  });

  it("reports the difference with its sign", () => {
    expect(judge(point, point.publishedMs + 1.5).deltaMs).toBeCloseTo(1.5);
    expect(judge(point, point.publishedMs - 1.5).deltaMs).toBeCloseTo(-1.5);
  });

  it("holds only when every row passes", () => {
    const rows = ORACLE_POINTS.map((p) => judge(p, p.publishedMs));
    expect(allPassed(rows)).toBe(true);
    expect(allPassed([...rows.slice(1), judge(point, point.publishedMs + 50)])).toBe(false);
  });

  it("does not report a pass with no rows measured", () => {
    expect(allPassed([])).toBe(false);
  });

  it("covers the three published operating points", () => {
    expect(ORACLE_POINTS).toHaveLength(3);
    expect(ORACLE_POINTS.map((p) => p.publishedMs)).toEqual([181, 141, 71]);
  });
});

describe("a failure demo's claim", () => {
  it("holds when the broken run is worse on a metric where higher is worse", () => {
    const demo = FAILURE_DEMOS.find((d) => d.higherIsWorse);
    if (!demo) throw new Error("no demo where higher is worse");
    expect(demonstrates(demo, 10, 2)).toBe(true);
    expect(demonstrates(demo, 2, 10)).toBe(false);
    expect(demonstrates(demo, 5, 5)).toBe(false);
  });

  it("holds when the broken run is worse on a metric where lower is worse", () => {
    const demo = FAILURE_DEMOS.find((d) => !d.higherIsWorse);
    if (!demo) throw new Error("no demo where lower is worse");
    expect(demonstrates(demo, 0.2, 0.9)).toBe(true);
    expect(demonstrates(demo, 0.9, 0.2)).toBe(false);
  });

  /** Every demo has to differ from its own fixed configuration, or it shows nothing. */
  it("gives each demo a broken configuration that differs from its fixed one", () => {
    for (const demo of FAILURE_DEMOS) {
      expect(demo.broken, demo.id).not.toEqual(demo.fixed);
    }
  });

  it("names the three failure modes the page claims", () => {
    expect(FAILURE_DEMOS.map((d) => d.id)).toEqual([
      "divergence",
      "rubber-band",
      "hit-registration",
    ]);
  });
});
