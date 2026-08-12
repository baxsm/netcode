/**
 * Playback state, as pure functions over a captured frame list.
 *
 * Nothing here touches a canvas or a clock, which is what makes "step one tick"
 * provable rather than approximately right.
 *
 * One cursor serves all three views. Three independent cursors would drift apart over
 * a long run and the views would quietly stop being comparable.
 */

import type { Frame, Point } from "../sim/types";

export interface Cursor {
  /** Whole ticks elapsed. Indexes the frame list directly. */
  tick: number;
  /**
   * How far between this tick and the next, in [0, 1). Display only: feeding it back
   * into a metric would make measured divergence a function of framerate.
   */
  fraction: number;
}

export const START: Cursor = { tick: 0, fraction: 0 };

/**
 * Longest wall-clock gap a single frame may account for.
 *
 * A backgrounded tab fires no animation frames, so the first frame after it returns
 * carries the whole time it was away. Unclamped, that one frame runs the entire replay
 * and the page looks like it refuses to play. Longer than any frame a running tab
 * produces, short enough that the jump it allows is a few ticks.
 */
export const MAX_FRAME_MS = 250;

/**
 * Moves the cursor forward by elapsed wall-clock time.
 *
 * `tickRate` is the simulation's, so playback runs at the speed the run was recorded
 * at rather than at one frame per repaint. Stops at the last frame instead of wrapping,
 * because a run that silently restarts reads as a stutter.
 */
export function advance(
  cursor: Cursor,
  elapsedMs: number,
  tickRate: number,
  frameCount: number,
  speed = 1,
): Cursor {
  if (frameCount <= 0 || tickRate <= 0) return START;

  // a negative gap would run the cursor backwards, which no caller ever means
  const capped = Math.min(Math.max(elapsedMs, 0), MAX_FRAME_MS);
  const ticks = (capped / 1000) * tickRate * speed + cursor.fraction;
  const whole = Math.floor(ticks);
  const next = cursor.tick + whole;
  const last = frameCount - 1;

  if (next >= last) return { tick: last, fraction: 0 };
  return { tick: next, fraction: ticks - whole };
}

export function stepForward(cursor: Cursor, frameCount: number): Cursor {
  if (frameCount <= 0) return START;
  return { tick: Math.min(cursor.tick + 1, frameCount - 1), fraction: 0 };
}

export function stepBack(cursor: Cursor): Cursor {
  return { tick: Math.max(cursor.tick - 1, 0), fraction: 0 };
}

/**
 * Lands on a whole tick with no fraction, so scrubbing to a tick and stepping to it
 * produce the same frame rather than disagreeing by one.
 */
export function seek(tick: number, frameCount: number): Cursor {
  if (frameCount <= 0) return START;
  const clamped = Math.min(Math.max(Math.round(tick), 0), frameCount - 1);
  return { tick: clamped, fraction: 0 };
}

export function atEnd(cursor: Cursor, frameCount: number): boolean {
  return frameCount <= 0 || cursor.tick >= frameCount - 1;
}

/**
 * Display only: it smooths motion between captured frames and is never measured.
 */
export function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * The two frames the cursor sits between, and how far between them it is.
 *
 * At the last frame both are the same frame, so a caller interpolating against the
 * result holds still rather than reading past the end.
 */
export function frameAt(
  frames: readonly Frame[],
  cursor: Cursor,
): { from: Frame; to: Frame; t: number } | null {
  if (frames.length === 0) return null;
  const index = Math.min(Math.max(cursor.tick, 0), frames.length - 1);
  const from = frames[index] as Frame;
  const to = (frames[index + 1] ?? from) as Frame;
  return { from, to, t: to === from ? 0 : cursor.fraction };
}

/**
 * How strongly to draw an event flash, decaying over `holdTicks` after it happened.
 *
 * A correction lasting one frame is invisible at 144 Hz, which reads as a feature that
 * does not work rather than as a visualisation that failed. Zero when nothing happened
 * recently, so the caller draws nothing rather than a permanent tint.
 */
export function flashAt(
  frames: readonly Frame[],
  tick: number,
  clientIndex: number,
  pick: (client: Frame["clients"][number]) => boolean,
  holdTicks: number,
): number {
  if (holdTicks <= 0) return 0;
  const start = Math.max(0, tick - holdTicks);
  for (let i = tick; i >= start; i -= 1) {
    const client = frames[i]?.clients[clientIndex];
    if (client && pick(client)) {
      return 1 - (tick - i) / holdTicks;
    }
  }
  return 0;
}

/** Ticks converted to milliseconds at the run's rate, for labelling the timeline. */
export function tickToMs(tick: number, tickRate: number): number {
  if (tickRate <= 0) return 0;
  return (tick / tickRate) * 1000;
}
