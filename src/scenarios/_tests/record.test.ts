import { describe, expect, it } from "vitest";
import {
  directionOf,
  emptyRecorder,
  finish,
  fireAt,
  keyDown,
  keyUp,
  sampleTick,
  tickAt,
} from "../record";

describe("the recording clock", () => {
  /**
   * The named failure mode for record mode is writing at render ticks. A script
   * written on animation frames plays back differently at a different frame rate, so
   * the tick has to come from elapsed time and the scenario's own rate.
   */
  it("derives the same tick regardless of how often it is sampled", () => {
    // 500 ms into a 64 Hz run is tick 32 whether the caller sampled once or a
    // hundred times on the way there
    expect(tickAt(500, 64)).toBe(32);
    expect(tickAt(500.4, 64)).toBe(32);
    expect(tickAt(1000, 64)).toBe(64);
    expect(tickAt(1000, 128)).toBe(128);
  });

  it("starts at zero and never goes negative", () => {
    expect(tickAt(0, 64)).toBe(0);
    expect(tickAt(-100, 64)).toBe(0);
  });

  it("does not divide by a zero tick rate", () => {
    expect(tickAt(500, 0)).toBe(0);
  });
});

describe("held keys", () => {
  it("adds up to a direction", () => {
    expect(directionOf(["ArrowRight"])).toEqual({ dx: 1, dy: 0 });
    expect(directionOf(["w", "d"])).toEqual({ dx: 1, dy: 1 });
  });

  it("cancels opposing keys", () => {
    expect(directionOf(["ArrowLeft", "ArrowRight"])).toEqual({ dx: 0, dy: 0 });
  });

  it("ignores keys that are not bound", () => {
    expect(directionOf(["q", "ArrowUp"])).toEqual({ dx: 0, dy: 1 });
  });

  it("does not repeat a key that is already held", () => {
    const held = keyDown(keyDown(emptyRecorder(), "d"), "d");
    expect(held.held).toEqual(["d"]);
  });

  it("releases a key it is holding", () => {
    const state = keyUp(keyDown(emptyRecorder(), "d"), "d");
    expect(state.held).toEqual([]);
  });
});

describe("sampling a tick", () => {
  it("writes a move when a direction is first held", () => {
    const state = sampleTick(keyDown(emptyRecorder(), "ArrowRight"), 10);
    expect(state.script).toEqual([
      { tick: 10, action: "move", dxPermille: 1000, dyPermille: 0 },
    ]);
  });

  /**
   * The core holds the last input until the next event, so an unchanged direction
   * needs no entry. Writing one per tick would produce a script hundreds of entries
   * long describing the same motion.
   */
  it("writes nothing while the direction is unchanged", () => {
    let state = sampleTick(keyDown(emptyRecorder(), "ArrowRight"), 10);
    state = sampleTick(state, 11);
    state = sampleTick(state, 12);
    expect(state.script).toHaveLength(1);
  });

  it("writes a stop when every key is released", () => {
    let state = sampleTick(keyDown(emptyRecorder(), "ArrowRight"), 10);
    state = sampleTick(keyUp(state, "ArrowRight"), 20);
    expect(state.script[1]).toEqual({
      tick: 20,
      action: "stop",
      dxPermille: 0,
      dyPermille: 0,
    });
  });

  /** A run already starts still, so a leading stop describes nothing. */
  it("does not open the script with a stop", () => {
    const state = sampleTick(sampleTick(emptyRecorder(), 0), 5);
    expect(state.script).toEqual([]);
  });

  it("does not write two events on one tick", () => {
    let state = sampleTick(keyDown(emptyRecorder(), "ArrowRight"), 10);
    state = sampleTick(keyDown(state, "ArrowUp"), 10);
    expect(state.script).toHaveLength(1);
  });

  it("does not go backwards in time", () => {
    let state = sampleTick(keyDown(emptyRecorder(), "ArrowRight"), 30);
    state = sampleTick(keyUp(state, "ArrowRight"), 5);
    expect(state.script).toHaveLength(1);
  });
});

describe("firing", () => {
  it("writes a shot along the held direction", () => {
    const state = fireAt(keyDown(emptyRecorder(), "ArrowUp"), 40);
    expect(state.script).toEqual([
      { tick: 40, action: "fire", dxPermille: 0, dyPermille: 1000 },
    ]);
  });

  /** A zero vector would be a shot pointed nowhere, which the core cannot resolve. */
  it("aims along positive x when nothing is held", () => {
    const state = fireAt(emptyRecorder(), 40);
    expect(state.script[0]).toMatchObject({ dxPermille: 1000, dyPermille: 0 });
  });

  it("does not stack a shot onto a tick that already has an event", () => {
    let state = sampleTick(keyDown(emptyRecorder(), "ArrowRight"), 10);
    state = fireAt(state, 10);
    expect(state.script).toHaveLength(1);
  });
});

describe("finishing a recording", () => {
  /**
   * Recording only ever moves forward, so the sort exists for the editor, which can
   * insert an event at any tick after the fact.
   */
  it("returns the script in tick order", () => {
    let state = sampleTick(keyDown(emptyRecorder(), "ArrowRight"), 20);
    state = fireAt(state, 50);
    state = { ...state, script: [...state.script].reverse() };
    expect(finish(state).map((e) => e.tick)).toEqual([20, 50]);
  });

  it("returns an empty script when nothing was pressed", () => {
    expect(finish(emptyRecorder())).toEqual([]);
  });
});
