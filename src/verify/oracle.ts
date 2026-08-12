/**
 * The project's external correctness claim.
 *
 * These figures come from a different implementation by a different team, so agreement
 * means something that comparing the code against itself cannot. That is the whole
 * reason the page exists.
 *
 * Source: "Peeking into VALORANT's Netcode", Riot Games, 28 July 2020.
 * <https://technology.riotgames.com/news/peeking-valorants-netcode>
 */

/**
 * Milliseconds either side of the published figure that still counts as a match.
 *
 * The article rounds all three figures to the nearest millisecond and says outright
 * that it hand-waves the buffering term, so a tolerance is required rather than
 * optional. Two milliseconds absorbs that rounding while still failing on a real
 * regression: one frame is 7.8 ms at 128 tick and 6.9 ms at 144 FPS, so an
 * off-by-one-frame error is three times this and cannot slip through.
 *
 * Widening this to make a failing row pass would be turning the one external check
 * into a check against itself. A change here needs a log entry with its reason.
 */
export const TOLERANCE_MS = 2;

export interface OraclePoint {
  label: string;
  rttMs: number;
  tickRate: number;
  clientFps: number;
  /** The figure Riot published for this condition. */
  publishedMs: number;
  /** Why this operating point appears in the article. */
  note: string;
}

/**
 * The three operating points from the article.
 *
 * The middle row runs at 75 ms rather than the 35 ms the phase document first
 * recorded. 35 ms is a stated infrastructure goal in the article, not the condition
 * the 141 ms figure was computed under, and at 35 ms the model produces 100.6 ms.
 * See docs/phases/phase-2.md.
 */
export const ORACLE_POINTS: OraclePoint[] = [
  {
    label: "Baseline",
    rttMs: 100,
    tickRate: 64,
    clientFps: 60,
    publishedMs: 181,
    note: "Before Riot Direct and 128 tick, which is what the article opens with.",
  },
  {
    label: "Riot Direct, 128 tick",
    rttMs: 75,
    tickRate: 128,
    clientFps: 60,
    publishedMs: 141,
    note: "The article's 40 ms improvement, at the round trip that figure was computed under.",
  },
  {
    label: "144 FPS client",
    rttMs: 35,
    tickRate: 128,
    clientFps: 144,
    publishedMs: 71,
    note: "A high frame rate client on the improved network.",
  },
];

export interface OracleRow extends OraclePoint {
  measuredMs: number;
  deltaMs: number;
  passed: boolean;
}

export function judge(point: OraclePoint, measuredMs: number): OracleRow {
  const deltaMs = measuredMs - point.publishedMs;
  return {
    ...point,
    measuredMs,
    deltaMs,
    passed: Math.abs(deltaMs) <= TOLERANCE_MS,
  };
}

export function allPassed(rows: readonly OracleRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.passed);
}
