import { describe, expect, it } from "vitest";
import { decodeConfigParams, encodeConfigParams } from "../link";
import { ALL_TECHNIQUES, DEFAULT_CONFIG, NO_TECHNIQUES } from "../../sim/types";
import { FAILURE_DEMOS } from "../demos";

/**
 * The encoder and the replay page's decoder are two halves of one contract. Held
 * apart they are free to disagree about a field name, and the replay would silently
 * fall back to its default for whichever one drifted, which reads as the link working.
 */
describe("a configuration carried in the hash", () => {
  it("round trips every field", () => {
    const config = {
      techniques: ALL_TECHNIQUES,
      interpolationDelayTicks: 5,
      inputBufferTicks: 3,
      rollbackWindowTicks: 11,
      correctionBlendPermille: 650,
      snapThresholdPermille: 21_000,
      serverRewindLimitMs: 275,
      extrapolationLimitTicks: 4,
    };
    const params = new URLSearchParams(encodeConfigParams(config));
    expect(decodeConfigParams(params)).toEqual(config);
  });

  it("round trips a config with no techniques on", () => {
    const config = { ...DEFAULT_CONFIG, techniques: NO_TECHNIQUES };
    const params = new URLSearchParams(encodeConfigParams(config));
    expect(decodeConfigParams(params)).toEqual(config);
  });

  /** Each flag has to reach its own bit, or two techniques would toggle together. */
  it("round trips every technique independently", () => {
    for (const field of Object.keys(ALL_TECHNIQUES) as Array<keyof typeof ALL_TECHNIQUES>) {
      const config = {
        ...DEFAULT_CONFIG,
        techniques: { ...NO_TECHNIQUES, [field]: true },
      };
      const params = new URLSearchParams(encodeConfigParams(config));
      expect(decodeConfigParams(params)?.techniques, field).toEqual(config.techniques);
    }
  });

  /** A link that only names a scenario must not claim to carry a configuration. */
  it("reads no configuration from a link without one", () => {
    expect(decodeConfigParams(new URLSearchParams({ scenario: "drift" }))).toBeNull();
    expect(decodeConfigParams(new URLSearchParams())).toBeNull();
  });

  /**
   * The hit registration demo links here specifically to show a too-low rewind
   * limit. Defaulting that field would open the replay on a working configuration
   * and the demo would show nothing wrong.
   */
  it("carries the rewind limit each demo depends on", () => {
    for (const demo of FAILURE_DEMOS) {
      const params = new URLSearchParams(encodeConfigParams(demo.broken));
      expect(decodeConfigParams(params), demo.id).toEqual(demo.broken);
    }
  });
});
