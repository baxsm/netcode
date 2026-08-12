import { describe, expect, it } from "vitest";
import {
  describeSegment,
  FULL_WEIGHT,
  PROFILES,
  totalWeight,
  weightsAreWhole,
} from "../profiles";
import { encodeSegments, SWEEP_SEGMENT_STRIDE, type WeightedSegment } from "../../sim/types";

describe("shipped profiles", () => {
  /**
   * A profile whose weights do not sum to a whole population is answering a
   * different question than the one on screen. The core renormalizes whatever it is
   * given, so a broken profile would run and quietly return the wrong answer.
   */
  it("every profile describes a whole population", () => {
    for (const profile of PROFILES) {
      expect(totalWeight(profile.segments), profile.name).toBe(FULL_WEIGHT);
      expect(weightsAreWhole(profile.segments), profile.name).toBe(true);
    }
  });

  it("every profile has more than one segment", () => {
    for (const profile of PROFILES) {
      // a single-segment profile is a single latency wearing a distribution's name,
      // which is the mistake this tool exists to prevent
      expect(profile.segments.length, profile.name).toBeGreaterThan(1);
    }
  });

  it("every profile has an id, a name and a description", () => {
    for (const profile of PROFILES) {
      expect(profile.id).toBeTruthy();
      expect(profile.name).toBeTruthy();
      expect(profile.description).toBeTruthy();
    }
  });

  it("profile ids are unique", () => {
    const ids = PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The profiles must actually differ in the conditions they describe, or picking
   * one over another would change nothing while appearing to.
   */
  it("profiles differ in their population mean latency", () => {
    const means = PROFILES.map((p) =>
      Math.round(
        p.segments.reduce((sum, s) => sum + (s.rttMeanMs * s.weightPermille) / FULL_WEIGHT, 0),
      ),
    );
    expect(new Set(means).size).toBe(means.length);
  });

  it("the competitive profile is faster than the global one", () => {
    const mean = (id: string) => {
      const p = PROFILES.find((x) => x.id === id);
      return (p?.segments ?? []).reduce(
        (sum, s) => sum + (s.rttMeanMs * s.weightPermille) / FULL_WEIGHT,
        0,
      );
    };
    expect(mean("competitive")).toBeLessThan(mean("global"));
  });
});

describe("weightsAreWhole", () => {
  const seg = (weightPermille: number): WeightedSegment => ({
    weightPermille,
    rttMeanMs: 50,
    rttJitterMs: 10,
    lossPct: 0,
    reorderPct: 0,
    duplicatePct: 0,
    burstLoss: false,
  });

  it("is false when the weights fall short", () => {
    expect(weightsAreWhole([seg(400), seg(400)])).toBe(false);
  });

  it("is false when the weights overshoot", () => {
    expect(weightsAreWhole([seg(700), seg(700)])).toBe(false);
  });

  it("is true when they sum to a whole population", () => {
    expect(weightsAreWhole([seg(600), seg(400)])).toBe(true);
  });
});

describe("encodeSegments", () => {
  it("writes one record per segment at the declared stride", () => {
    const buffer = encodeSegments(PROFILES[0]?.segments ?? []);
    expect(buffer.length).toBe((PROFILES[0]?.segments.length ?? 0) * SWEEP_SEGMENT_STRIDE);
  });

  it("puts every field at its own index", () => {
    const buffer = encodeSegments([
      {
        weightPermille: 750,
        rttMeanMs: 120,
        rttJitterMs: 30,
        lossPct: 4,
        reorderPct: 2,
        duplicatePct: 1,
        burstLoss: true,
      },
    ]);
    expect([...buffer]).toEqual([750, 120, 30, 4, 2, 1, 1]);
  });

  it("writes burst loss as zero when it is off", () => {
    const buffer = encodeSegments([
      {
        weightPermille: 1000,
        rttMeanMs: 10,
        rttJitterMs: 0,
        lossPct: 0,
        reorderPct: 0,
        duplicatePct: 0,
        burstLoss: false,
      },
    ]);
    expect(buffer[6]).toBe(0);
  });
});

describe("describeSegment", () => {
  it("names only the conditions that are set", () => {
    expect(
      describeSegment({
        weightPermille: 1000,
        rttMeanMs: 30,
        rttJitterMs: 0,
        lossPct: 0,
        reorderPct: 0,
        duplicatePct: 0,
        burstLoss: false,
      }),
    ).toBe("30 ms");
  });

  it("says when loss arrives in bursts", () => {
    const text = describeSegment({
      weightPermille: 1000,
      rttMeanMs: 220,
      rttJitterMs: 60,
      lossPct: 8,
      reorderPct: 0,
      duplicatePct: 0,
      burstLoss: true,
    });
    expect(text).toContain("220 ms");
    expect(text).toContain("8% loss in bursts");
  });
});
