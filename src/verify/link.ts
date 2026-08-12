/**
 * A configuration carried in the hash, so a route can open on one.
 *
 * The encoder and the replay page's decoder are the two halves of one contract, and
 * a test round trips them. Written twice, the sweep's link and the demo's link would
 * be free to disagree about a field name and the replay would silently fall back to
 * its default for whichever one drifted.
 */

import { DEFAULT_CONFIG, TECHNIQUE_FIELDS, type NetcodeConfig, type TechniqueSet } from "../sim/types";

export function encodeConfigParams(config: NetcodeConfig): Record<string, string> {
  return {
    interp: String(config.interpolationDelayTicks),
    buffer: String(config.inputBufferTicks),
    blend: String(config.correctionBlendPermille),
    snap: String(config.snapThresholdPermille),
    rollback: String(config.rollbackWindowTicks),
    extrap: String(config.extrapolationLimitTicks),
    rewind: String(config.serverRewindLimitMs),
    techniques: String(
      TECHNIQUE_FIELDS.reduce(
        (bits, field, i) => bits | (config.techniques[field] ? 1 << i : 0),
        0,
      ),
    ),
  };
}

/**
 * Reads a configuration back out of the hash, or null when the link carries none.
 *
 * Keyed on `techniques` rather than on any parameter at all, so a link that only
 * names a scenario does not claim to carry a chosen configuration. Anything missing
 * or unparseable falls back to the default rather than to zero, since a partly
 * applied config would show numbers for something nobody selected.
 */
export function decodeConfigParams(params: URLSearchParams): NetcodeConfig | null {
  if (!params.has("techniques")) return null;

  const number = (key: string, fallback: number) => {
    const raw = Number(params.get(key));
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  };

  const bits = Number(params.get("techniques"));
  const techniques: TechniqueSet = Number.isFinite(bits)
    ? (Object.fromEntries(
        TECHNIQUE_FIELDS.map((field, i) => [field, (bits & (1 << i)) !== 0]),
      ) as TechniqueSet)
    : DEFAULT_CONFIG.techniques;

  return {
    techniques,
    interpolationDelayTicks: number("interp", DEFAULT_CONFIG.interpolationDelayTicks),
    inputBufferTicks: number("buffer", DEFAULT_CONFIG.inputBufferTicks),
    rollbackWindowTicks: number("rollback", DEFAULT_CONFIG.rollbackWindowTicks),
    correctionBlendPermille: number("blend", DEFAULT_CONFIG.correctionBlendPermille),
    snapThresholdPermille: number("snap", DEFAULT_CONFIG.snapThresholdPermille),
    // carried rather than defaulted, since the hit registration demo links here
    // specifically to show what a too-low limit does
    serverRewindLimitMs: number("rewind", DEFAULT_CONFIG.serverRewindLimitMs),
    extrapolationLimitTicks: number("extrap", DEFAULT_CONFIG.extrapolationLimitTicks),
  };
}
