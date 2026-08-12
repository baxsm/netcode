/**
 * Turning held keys into an input script.
 *
 * The failure this is written to avoid is recording at render ticks. A script written
 * on animation frames plays back differently at a different frame rate, which makes
 * the recording non-reproducible and quietly breaks the one property the whole
 * project rests on. So the recorder is driven by a simulation tick derived from
 * elapsed time and the scenario's own rate, and nothing here reads a frame counter.
 *
 * It is pure: elapsed milliseconds arrive from the caller, the same way the core
 * takes its tick counter rather than reading a clock.
 */

import type { InputEventSpec } from "../sim/types";

/** The movement keys, mapped to the direction they contribute. */
export const KEY_BINDINGS: Record<string, { dx: number; dy: number }> = {
  ArrowUp: { dx: 0, dy: 1 },
  ArrowDown: { dx: 0, dy: -1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  w: { dx: 0, dy: 1 },
  s: { dx: 0, dy: -1 },
  a: { dx: -1, dy: 0 },
  d: { dx: 1, dy: 0 },
};

export const FIRE_KEY = " ";

/** How each control reads in the interface, for the on-screen legend. */
export const CONTROL_HINTS = [
  { keys: "Arrows or WASD", does: "move" },
  { keys: "Space", does: "fire" },
  { keys: "Escape", does: "stop recording" },
] as const;

export interface RecorderState {
  /** Keys currently held, in the order they went down. */
  held: string[];
  /** Direction written at the last tick, so an unchanged direction writes nothing. */
  lastDirection: { dx: number; dy: number } | null;
  /** The last tick an event was written at, so two never land on one tick. */
  lastTick: number;
  script: InputEventSpec[];
}

export function emptyRecorder(): RecorderState {
  return { held: [], lastDirection: null, lastTick: -1, script: [] };
}

/**
 * The tick a moment of elapsed time falls on.
 *
 * Floored against the scenario's own rate, so a recording made on a 144 Hz display
 * and one made on a 60 Hz display produce the same script from the same key timings.
 */
export function tickAt(elapsedMs: number, tickRate: number): number {
  if (tickRate <= 0) return 0;
  return Math.max(0, Math.floor((elapsedMs / 1000) * tickRate));
}

/**
 * The direction the held keys add up to.
 *
 * Components are clamped rather than normalized. The core takes each axis as a
 * permille value and multiplies it by acceleration, so a diagonal is deliberately
 * faster here in the same way holding two keys is in most engines.
 */
export function directionOf(held: readonly string[]): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  for (const key of held) {
    const binding = KEY_BINDINGS[key];
    if (!binding) continue;
    dx += binding.dx;
    dy += binding.dy;
  }
  return { dx: Math.max(-1, Math.min(1, dx)), dy: Math.max(-1, Math.min(1, dy)) };
}

export function keyDown(state: RecorderState, key: string): RecorderState {
  if (state.held.includes(key)) return state;
  return { ...state, held: [...state.held, key] };
}

export function keyUp(state: RecorderState, key: string): RecorderState {
  if (!state.held.includes(key)) return state;
  return { ...state, held: state.held.filter((k) => k !== key) };
}

/**
 * Writes the held direction at a simulation tick, if it changed.
 *
 * An unchanged direction writes nothing, because the core holds the last input until
 * the next event. Writing one per tick would produce a script hundreds of entries
 * long that describes the same motion and cannot be read or edited.
 *
 * A tick that already carries an event is skipped rather than appended to, so the
 * script keeps one input per tick and stays in the shape the editor can round trip.
 */
export function sampleTick(state: RecorderState, tick: number): RecorderState {
  if (tick <= state.lastTick) return state;

  const direction = directionOf(state.held);
  const previous = state.lastDirection;
  const unchanged = previous !== null && previous.dx === direction.dx && previous.dy === direction.dy;
  if (unchanged) return { ...state, lastDirection: direction };

  const stopped = direction.dx === 0 && direction.dy === 0;
  const event: InputEventSpec = stopped
    ? { tick, action: "stop", dxPermille: 0, dyPermille: 0 }
    : {
        tick,
        action: "move",
        dxPermille: direction.dx * 1000,
        dyPermille: direction.dy * 1000,
      };

  // nothing was held and nothing has been written, so there is no motion to stop. a
  // leading stop would be an event describing the state the run already starts in
  if (stopped && previous === null) {
    return { ...state, lastDirection: direction };
  }

  return {
    ...state,
    lastDirection: direction,
    lastTick: tick,
    script: [...state.script, event],
  };
}

/**
 * Writes a shot at a simulation tick, aimed along the current direction.
 *
 * A shot with no direction held fires along positive x, since the core reads the
 * components and a zero vector would be a shot pointed nowhere.
 */
export function fireAt(state: RecorderState, tick: number): RecorderState {
  if (state.script.some((event) => event.tick === tick)) return state;

  const direction = directionOf(state.held);
  const aimed = direction.dx === 0 && direction.dy === 0 ? { dx: 1, dy: 0 } : direction;

  return {
    ...state,
    lastTick: Math.max(state.lastTick, tick),
    script: [
      ...state.script,
      {
        tick,
        action: "fire",
        dxPermille: aimed.dx * 1000,
        dyPermille: aimed.dy * 1000,
      },
    ],
  };
}

/** Sorted by tick, which is the order the core applies them in. */
export function finish(state: RecorderState): InputEventSpec[] {
  return [...state.script].sort((a, b) => a.tick - b.tick);
}
