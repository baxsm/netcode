import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CANVAS, DATA, ENTITY, INTERACTIVE, SEGMENTS, VERDICT } from "../palette";

/**
 * The palette exists twice by necessity: as CSS custom properties for the chrome, and
 * as JS strings for the canvas and Recharts, neither of which can read a custom
 * property. Two copies drift, so these tests are what keeps them honest.
 */
const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** sRGB channels for a `#rrggbb` string. */
function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const linear = channels(hex)
    .map((c) => c / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] as number) + 0.7152 * (linear[1] as number) + 0.0722 * (linear[2] as number);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Euclidean distance in sRGB, a rough stand-in for "tells two things apart". */
function separation(a: string, b: string): number {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

describe("palette", () => {
  /**
   * The failure this is written against: a single --accent was the primary button fill,
   * the focus ring, the population-share bar and the pareto front colour all at once,
   * so colour could not tell the reader what was interactive.
   */
  it("keeps the interactive accent out of the data and entity sets", () => {
    // the chrome's --primary, as sRGB. the token itself is oklch, so this is the
    // rendered equivalent and the CSS assertion below keeps the token present
    const interactive = INTERACTIVE;

    for (const [name, colour] of Object.entries(ENTITY)) {
      expect(separation(colour, interactive), `entity ${name}`).toBeGreaterThan(60);
    }
    // the front is what a reader is most likely to mistake for something clickable
    expect(separation(DATA.front, interactive)).toBeGreaterThan(120);
  });

  it("separates the two clients from each other and from the server", () => {
    // the pairs a reader has to tell apart at a glance, in three side-by-side views
    expect(separation(ENTITY.clientA, ENTITY.clientB)).toBeGreaterThan(140);
    expect(separation(ENTITY.clientA, ENTITY.server)).toBeGreaterThan(120);
    expect(separation(ENTITY.clientB, ENTITY.server)).toBeGreaterThan(100);
  });

  /** Corrections are red and rollbacks violet, exclusively. See `docs/ui.md`. */
  it("keeps the event colours apart from the entities that carry them", () => {
    for (const entity of [ENTITY.server, ENTITY.clientA, ENTITY.clientB]) {
      expect(separation(entity, ENTITY.correction)).toBeGreaterThan(100);
      expect(separation(entity, ENTITY.rollback)).toBeGreaterThan(100);
    }
  });

  it("reads every entity against the canvas it is drawn on", () => {
    for (const [name, colour] of Object.entries(ENTITY)) {
      // 3:1 is the floor for a graphical object that carries meaning
      expect(contrast(colour, "#151b23"), name).toBeGreaterThan(3);
    }
  });

  it("keeps a body's glyph legible on every entity colour", () => {
    for (const [name, colour] of Object.entries(ENTITY)) {
      expect(contrast(CANVAS.glyphInk, colour), name).toBeGreaterThan(4.5);
    }
  });

  it("keeps every population segment distinguishable from its neighbours", () => {
    for (let i = 1; i < SEGMENTS.length; i += 1) {
      const previous = SEGMENTS[i - 1] as string;
      const current = SEGMENTS[i] as string;
      expect(separation(previous, current), `${previous} vs ${current}`).toBeGreaterThan(60);
    }
  });

  /**
   * The chrome declares the same colours as CSS custom properties. If a token is
   * changed there and not here, the canvas and the legend describing it disagree.
   */
  it("declares an interactive accent that no entity or data colour matches", () => {
    expect(CSS).toMatch(/--primary:\s*oklch/);
    expect(CSS).toMatch(/--ring:\s*oklch/);
    // the reserved sets must exist as tokens so the chrome can never invent its own
    for (const token of ["--client-a", "--client-b", "--server", "--correction", "--rollback"]) {
      expect(CSS, token).toContain(token);
    }
  });

  it("never lets a verdict colour double as the interactive accent", () => {
    for (const [name, colour] of Object.entries(VERDICT)) {
      expect(separation(colour, INTERACTIVE), name).toBeGreaterThan(60);
    }
  });
});
