import { describe, expect, it } from "vitest";
import { COLOURS, FLASH_HOLD_TICKS, layoutFor, VIEW_HEIGHT, VIEW_WIDTH, VIEWS } from "../draw";

const ASPECT = VIEW_WIDTH / VIEW_HEIGHT;

describe("layoutFor", () => {
  /**
   * A stretched view misrepresents distance, and distance error is what this screen
   * measures. So the scale must be one number for both axes, whatever the panel shape.
   */
  it("uses one scale for both axes", () => {
    for (const [w, h] of [
      [800, 450],
      [800, 200],
      [200, 800],
      [1, 1],
    ] as const) {
      const layout = layoutFor(w, h);
      expect(Number.isFinite(layout.scale)).toBe(true);
      expect(layout.scale).toBeGreaterThan(0);
    }
  });

  it("letterboxes the leftover space rather than stretching", () => {
    // a panel wider than the world's aspect gains side bars, not a wider world
    const wide = layoutFor(1000, 1000 / ASPECT / 2);
    expect(wide.offsetX).toBeGreaterThan(0);
    expect(wide.offsetY).toBeCloseTo(0, 6);

    const tall = layoutFor(200, 200 / ASPECT + 400);
    expect(tall.offsetY).toBeGreaterThan(0);
    expect(tall.offsetX).toBeCloseTo(0, 6);
  });

  /** A panel at the exact world aspect must have no bars at all. */
  it("adds no letterbox at the world aspect", () => {
    const exact = layoutFor(640, 640 / ASPECT);
    expect(exact.offsetX).toBeCloseTo(0, 6);
    expect(exact.offsetY).toBeCloseTo(0, 6);
  });

  it("fits the world inside the canvas on both axes", () => {
    for (const [w, h] of [
      [640, 360],
      [900, 300],
      [300, 900],
    ] as const) {
      const layout = layoutFor(w, h);
      expect(layout.offsetX).toBeGreaterThanOrEqual(-0.001);
      expect(layout.offsetY).toBeGreaterThanOrEqual(-0.001);
      expect(layout.offsetX * 2 + VIEW_WIDTH * layout.scale).toBeLessThanOrEqual(w + 0.001);
      expect(layout.offsetY * 2 + VIEW_HEIGHT * layout.scale).toBeLessThanOrEqual(h + 0.001);
    }
  });

  it("keeps the aspect ratio constant as the panel grows", () => {
    const small = layoutFor(400, 225);
    const large = layoutFor(800, 450);
    expect(large.scale / small.scale).toBeCloseTo(2, 6);
  });
});

describe("view identity", () => {
  it("gives every view a distinct colour and glyph", () => {
    expect(new Set(VIEWS.map((v) => v.colour)).size).toBe(VIEWS.length);
    expect(new Set(VIEWS.map((v) => v.glyph)).size).toBe(VIEWS.length);
  });

  /** Identity must survive greyscale, so colour is never the only channel. */
  it("labels every view with more than colour", () => {
    for (const view of VIEWS) {
      expect(view.glyph.length).toBeGreaterThan(0);
      expect(view.title.length).toBeGreaterThan(0);
    }
  });

  it("puts exactly one server view first and then the clients in order", () => {
    expect(VIEWS[0]?.clientIndex).toBeNull();
    expect(VIEWS[1]?.clientIndex).toBe(0);
    expect(VIEWS[2]?.clientIndex).toBe(1);
  });
});

describe("event colours", () => {
  /**
   * A flash is only unambiguous if its colour means one thing. Sharing a colour between
   * corrections and rollbacks would make the two indistinguishable at a glance, which
   * is the entire point of flashing them.
   */
  it("reserves a distinct colour for each event", () => {
    const events = [COLOURS.correction, COLOURS.rollback, COLOURS.rewind];
    expect(new Set(events).size).toBe(events.length);
    for (const event of events) {
      expect(event).not.toBe(COLOURS.server);
      expect(event).not.toBe(COLOURS.clientA);
      expect(event).not.toBe(COLOURS.clientB);
    }
  });

  /**
   * At 144 FPS and a 64 Hz tick, a one tick hold is roughly two frames. The hold has to
   * be long enough that a correction registers rather than reading as a feature that
   * never fires.
   */
  it("holds a flash long enough to see", () => {
    expect(FLASH_HOLD_TICKS).toBeGreaterThanOrEqual(6);
    // and not so long that separate events smear into one continuous tint
    expect(FLASH_HOLD_TICKS).toBeLessThanOrEqual(20);
  });
});
