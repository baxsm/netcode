import { describe, expect, it } from "vitest";
import {
  advance,
  atEnd,
  flashAt,
  frameAt,
  lerp,
  MAX_FRAME_MS,
  seek,
  START,
  stepBack,
  stepForward,
  tickToMs,
  type Cursor,
} from "../playback";
import type { ClientFrame, Frame } from "../../sim/types";

const client = (over: Partial<ClientFrame> = {}): ClientFrame => ({
  position: { x: 0, y: 0 },
  ghost: null,
  preCorrection: null,
  correctionMagnitude: 0,
  snapped: false,
  rollbackDepth: 0,
  ...over,
});

const frames = (count: number, over: (i: number) => Partial<ClientFrame> = () => ({})): Frame[] =>
  Array.from({ length: count }, (_, i) => ({
    tick: i,
    server: { x: i, y: 0 },
    clients: [client(over(i)), client()],
    rewindTarget: null,
  }));

describe("advance", () => {
  it("moves exactly one tick per tick interval", () => {
    // 64 Hz means one tick every 15.625 ms
    const next = advance(START, 1000 / 64, 64, 100);
    expect(next.tick).toBe(1);
    expect(next.fraction).toBeCloseTo(0, 10);
  });

  it("carries the remainder into the fraction rather than losing it", () => {
    // half a tick twice must land on a whole tick, not stay at zero
    const half = advance(START, 1000 / 128, 64, 100);
    expect(half.tick).toBe(0);
    expect(half.fraction).toBeCloseTo(0.5, 10);
    expect(advance(half, 1000 / 128, 64, 100).tick).toBe(1);
  });

  it("stops at the last frame instead of wrapping", () => {
    const next = advance({ tick: 98, fraction: 0 }, 1000, 64, 100);
    expect(next).toEqual({ tick: 99, fraction: 0 });
    expect(advance(next, 1000, 64, 100)).toEqual({ tick: 99, fraction: 0 });
  });

  it("runs at the scenario rate, not a fixed one", () => {
    // the same gap must cover twice the ticks at twice the rate, which fails if any
    // path hardcodes a rate. measured at the cap, since a longer gap is clamped
    expect(advance(START, MAX_FRAME_MS, 64, 1000).tick).toBe(16);
    expect(advance(START, MAX_FRAME_MS, 128, 1000).tick).toBe(32);
  });

  it("scales with playback speed", () => {
    const normal = advance(START, 100, 64, 1000, 1);
    const double = advance(START, 100, 64, 1000, 2);
    expect(double.tick).toBeGreaterThan(normal.tick);
  });

  it("returns to the start when there is nothing to play", () => {
    expect(advance({ tick: 5, fraction: 0.5 }, 100, 64, 0)).toEqual(START);
    expect(advance(START, 100, 0, 100)).toEqual(START);
  });

  /**
   * A backgrounded tab fires no animation frames, so the first frame after it returns
   * carries the entire time it was away. Found in a real browser: without the clamp
   * that one frame ran a 399 tick run to its end the moment the tab was looked at, and
   * the page appeared to refuse to play.
   */
  it("clamps a huge gap so a backgrounded tab does not jump the whole run", () => {
    const afterMinutes = advance(START, 120_000, 64, 400);
    const capped = advance(START, MAX_FRAME_MS, 64, 400);
    expect(afterMinutes).toEqual(capped);
    expect(afterMinutes.tick).toBeLessThan(399);
  });

  it("treats a gap at the cap the same as one beyond it", () => {
    expect(advance(START, MAX_FRAME_MS, 64, 400)).toEqual(advance(START, MAX_FRAME_MS * 4, 64, 400));
  });

  it("never runs backwards on a negative gap", () => {
    expect(advance({ tick: 10, fraction: 0 }, -500, 64, 400)).toEqual({ tick: 10, fraction: 0 });
  });

  it("still advances normally below the cap", () => {
    // a 60 Hz frame is well under the cap, so it must pass through untouched. at 64 Hz
    // that is 1.0667 ticks: one whole tick and the remainder carried as the fraction
    const next = advance(START, 1000 / 60, 64, 400);
    expect(next.tick).toBe(1);
    expect(next.fraction).toBeCloseTo(64 / 60 - 1, 10);
  });
});

describe("stepping", () => {
  it("moves exactly one tick and clears the fraction", () => {
    expect(stepForward({ tick: 4, fraction: 0.9 }, 100)).toEqual({ tick: 5, fraction: 0 });
    expect(stepBack({ tick: 4, fraction: 0.9 })).toEqual({ tick: 3, fraction: 0 });
  });

  it("does not run past either end", () => {
    expect(stepForward({ tick: 99, fraction: 0 }, 100)).toEqual({ tick: 99, fraction: 0 });
    expect(stepBack(START)).toEqual(START);
  });

  /**
   * Stepping forward then back must land exactly where it started. A fractional
   * remainder surviving either call would make the pair lossy and the rollback
   * explanation the view exists for would drift.
   */
  it("round trips", () => {
    let cursor: Cursor = { tick: 10, fraction: 0 };
    for (let i = 0; i < 20; i += 1) cursor = stepForward(cursor, 100);
    for (let i = 0; i < 20; i += 1) cursor = stepBack(cursor);
    expect(cursor).toEqual({ tick: 10, fraction: 0 });
  });
});

describe("seek", () => {
  it("lands on a whole tick with no fraction", () => {
    expect(seek(42.7, 100)).toEqual({ tick: 43, fraction: 0 });
  });

  it("clamps into range", () => {
    expect(seek(-5, 100)).toEqual({ tick: 0, fraction: 0 });
    expect(seek(500, 100)).toEqual({ tick: 99, fraction: 0 });
    expect(seek(5, 0)).toEqual(START);
  });

  /** Scrubbing to a tick and stepping to it must produce the same frame. */
  it("agrees with stepping", () => {
    let stepped: Cursor = START;
    for (let i = 0; i < 7; i += 1) stepped = stepForward(stepped, 100);
    expect(seek(7, 100)).toEqual(stepped);
  });
});

describe("atEnd", () => {
  it("is true only on the last frame", () => {
    expect(atEnd({ tick: 98, fraction: 0 }, 100)).toBe(false);
    expect(atEnd({ tick: 99, fraction: 0 }, 100)).toBe(true);
    expect(atEnd(START, 0)).toBe(true);
  });
});

describe("frameAt", () => {
  it("returns the surrounding pair", () => {
    const at = frameAt(frames(10), { tick: 3, fraction: 0.25 });
    expect(at?.from.tick).toBe(3);
    expect(at?.to.tick).toBe(4);
    expect(at?.t).toBe(0.25);
  });

  /** At the end there is nothing to interpolate toward, so it must hold still. */
  it("holds still on the last frame", () => {
    const at = frameAt(frames(10), { tick: 9, fraction: 0.9 });
    expect(at?.from.tick).toBe(9);
    expect(at?.to.tick).toBe(9);
    expect(at?.t).toBe(0);
  });

  it("clamps an out of range cursor rather than reading past the end", () => {
    expect(frameAt(frames(10), { tick: 999, fraction: 0 })?.from.tick).toBe(9);
    expect(frameAt(frames(10), { tick: -5, fraction: 0 })?.from.tick).toBe(0);
    expect(frameAt([], START)).toBeNull();
  });
});

describe("lerp", () => {
  it("reaches the hand computed midpoint", () => {
    expect(lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
  });

  it("returns the endpoints exactly", () => {
    const a = { x: 3, y: 4 };
    const b = { x: 9, y: 1 };
    expect(lerp(a, b, 0)).toEqual(a);
    expect(lerp(a, b, 1)).toEqual(b);
  });
});

describe("flashAt", () => {
  const corrected = (at: number) =>
    frames(50, (i) => (i === at ? { correctionMagnitude: 5, preCorrection: { x: 0, y: 0 } } : {}));

  const pick = (c: ClientFrame) => c.correctionMagnitude > 0;

  it("is full strength on the tick the event happened", () => {
    expect(flashAt(corrected(20), 20, 0, pick, 8)).toBe(1);
  });

  /**
   * The whole reason the hold exists. A correction on tick 20 must still be visible a
   * few ticks later, otherwise it lasts one frame and is invisible at high framerates.
   */
  it("decays over the hold rather than vanishing", () => {
    const f = corrected(20);
    expect(flashAt(f, 24, 0, pick, 8)).toBeCloseTo(0.5, 10);
    expect(flashAt(f, 27, 0, pick, 8)).toBeGreaterThan(0);
  });

  it("is gone once the hold has passed", () => {
    expect(flashAt(corrected(20), 29, 0, pick, 8)).toBe(0);
  });

  it("does not flash before the event", () => {
    expect(flashAt(corrected(20), 19, 0, pick, 8)).toBe(0);
  });

  it("reports nothing when no event ever occurred", () => {
    expect(flashAt(frames(50), 30, 0, pick, 8)).toBe(0);
  });

  /** The newest event wins, so two close together do not read as one long fade. */
  it("takes the most recent event in the window", () => {
    const f = frames(50, (i) =>
      i === 20 || i === 26 ? { correctionMagnitude: 5, preCorrection: { x: 0, y: 0 } } : {},
    );
    expect(flashAt(f, 27, 0, pick, 8)).toBeCloseTo(1 - 1 / 8, 10);
  });

  it("reads the client it was asked for", () => {
    expect(flashAt(corrected(20), 20, 1, pick, 8)).toBe(0);
  });

  it("draws nothing when the hold is zero", () => {
    expect(flashAt(corrected(20), 20, 0, pick, 0)).toBe(0);
  });
});

describe("tickToMs", () => {
  it("converts at the run rate", () => {
    expect(tickToMs(64, 64)).toBe(1000);
    expect(tickToMs(128, 128)).toBe(1000);
    expect(tickToMs(0, 64)).toBe(0);
  });

  it("does not divide by zero", () => {
    expect(tickToMs(10, 0)).toBe(0);
  });
});
