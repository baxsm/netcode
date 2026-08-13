/**
 * Every colour that carries meaning, in one place.
 *
 * Canvas 2D and Recharts both take colour as a string prop and neither can read a CSS
 * custom property, so the values have to exist in JS. Before this module they existed
 * in JS four times over: the canvas palette, the pareto chart's constants, the tune
 * page's legend swatches and the profile editor's segment colours. Three of those were
 * hand-typed hex that happened to match a token, so changing a token silently left the
 * legend describing the old colours.
 *
 * This is the source of truth. `src/styles.css` mirrors it for the CSS side, and
 * `_tests/palette.test.ts` fails if the two drift apart.
 */

/**
 * The simulation's own colours, reserved.
 *
 * Nothing in the chrome may reuse these. A client drawn in the interactive accent would
 * read as something you can click, and the verdict green would make an entity look like
 * a passing check. Cyan against amber also separates under deuteranopia and protanopia,
 * which blue against green does not, and entity identity is carried by colour here.
 */
export const ENTITY = {
  server: "#eaecef",
  clientA: "#3ecfcf",
  /* pulled toward yellow rather than orange: at #e8b23a it sat 94 from the correction
     red, so a correction flashing on client B barely read as a different colour */
  clientB: "#f2cf3f",
  correction: "#f2564d",
  rollback: "#b98cf5",
  rewind: "#eb9243",
} as const;

/** Surfaces the canvas draws on. Not semantic, so they are kept apart from ENTITY. */
export const CANVAS = {
  grid: "#232b38",
  ghost: "#8b93a1",
  /** Behind a body's letter glyph, so the glyph reads on any entity colour. */
  glyphInk: "#10141c",
} as const;

/**
 * Chart encoding, deliberately not the interactive accent.
 *
 * A point on the front is not clickable because it is coloured; it is clickable because
 * it is a button. Keeping data blue and controls amber means colour answers "what is
 * this" rather than "can I press it".
 */
export const DATA = {
  front: "#5ab0e8",
  dominated: "#5c6472",
  selected: "#f2f4f7",
  compared: "#eb9243",
} as const;

/** Chart chrome: axes, gridlines and the plot background. */
export const CHART = {
  grid: "#2b3341",
  axis: "#98a0ad",
  surface: "#2b3341",
} as const;

/**
 * Network population segments, in order.
 *
 * Six distinguishable hues that avoid the entity set, since a segment bar and an entity
 * can appear on the same screen.
 */
export const SEGMENTS = [
  "#5ab0e8",
  "#eb9243",
  "#5fcf8f",
  "#b98cf5",
  "#e8d24a",
  "#9aa3b0",
] as const;

export const VERDICT = {
  pass: "#4fc98a",
  warn: "#e0b344",
  fail: "#f2564d",
} as const;

/**
 * The chrome's interactive accent, as sRGB.
 *
 * The token in `styles.css` is the authority and is declared in oklch; this is the same
 * colour written for the tests and for the rare canvas element that needs it. Its whole
 * job is to belong to controls and to nothing else, which is what the palette tests
 * assert against every other set in this file.
 */
export const INTERACTIVE = "#f06ab0";
