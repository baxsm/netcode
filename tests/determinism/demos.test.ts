import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  decodeMetrics,
  encodeConfig,
  encodeScenario,
  encodeScript,
  type Metrics,
  type NetcodeConfig,
} from "../../src/sim/types";
import { FAILURE_DEMOS, demonstrates } from "../../src/verify/demos";
import { BUILT_IN_SCENARIOS } from "../../src/scenarios/store";
import type { CustomSegmentSpec } from "../../src/sim/types";
import type { AuthoredScenario } from "../../src/scenarios/store";

const require = createRequire(import.meta.url);
const core = require("../../core/pkg-node/netcode_core.js") as {
  run_metrics_custom: (...args: never[]) => Float64Array;
};

/** The same seed the page runs the demos on, so this checks what a visitor sees. */
const SEED = 7n;

function run(
  scenario: AuthoredScenario,
  segment: CustomSegmentSpec,
  config: NetcodeConfig,
): Metrics {
  return decodeMetrics(
    (core.run_metrics_custom as unknown as (...a: unknown[]) => Float64Array)(
      SEED,
      encodeScenario(scenario.spec),
      encodeScript(scenario.script),
      segment.rttMeanMs,
      segment.rttJitterMs,
      segment.lossPct,
      segment.reorderPct,
      segment.duplicatePct,
      segment.burstLoss,
      encodeConfig(config),
    ),
  );
}

/**
 * The demos are the page's claim that the effects it reports are ones the simulation
 * can actually produce. A demo whose broken run is not measurably worse would be a
 * caption with nothing behind it, so each one is checked against the real core here
 * rather than trusted because it reads plausibly.
 */
describe("every failure demo reproduces its own failure", () => {
  it.for(FAILURE_DEMOS)("$id", (demo) => {
    const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === demo.scenarioId);
    expect(scenario, `${demo.id} names a scenario that does not exist`).toBeDefined();
    if (!scenario) return;

    const broken = run(scenario, demo.segment, demo.broken)[demo.metric];
    const fixed = run(scenario, demo.segment, demo.fixed)[demo.metric];

    expect(
      demonstrates(demo, broken, fixed),
      `${demo.id}: broken measured ${broken} against fixed ${fixed} on ${demo.metric}, ` +
        `where ${demo.higherIsWorse ? "higher" : "lower"} is worse`,
    ).toBe(true);
  });

  /**
   * A difference inside the noise would technically pass the direction check while
   * showing a visitor two numbers that look the same. The gap has to be legible.
   */
  it.for(FAILURE_DEMOS)("$id separates its two runs visibly", (demo) => {
    const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === demo.scenarioId);
    if (!scenario) return;

    const broken = run(scenario, demo.segment, demo.broken)[demo.metric];
    const fixed = run(scenario, demo.segment, demo.fixed)[demo.metric];
    const ratio = Math.max(broken, fixed) / Math.max(Math.min(broken, fixed), 1e-9);

    expect(ratio, `${demo.id}: ${broken} against ${fixed} is too close to read`).toBeGreaterThan(
      1.2,
    );
  });

  /** The hit registration demo only means something if shots were actually fired. */
  it("fires shots in the hit registration demo", () => {
    const demo = FAILURE_DEMOS.find((d) => d.id === "hit-registration");
    if (!demo) throw new Error("no hit registration demo");
    const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === demo.scenarioId);
    if (!scenario) throw new Error("the demo names a scenario that does not exist");

    expect(run(scenario, demo.segment, demo.broken).shotsFired).toBeGreaterThan(0);
  });
});
