/**
 * The headless baseline runner.
 *
 * Runs in Node against the same WASM core the browser uses, which is only sound
 * because Phase 0 proved the two engines agree bit for bit. A separate Node-only
 * implementation would be checking a different thing than the one that ships.
 *
 * Usage: `npm run baseline -- <path to baseline.json>`
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// extensions are explicit down this chain because the runner is the one module that
// executes under plain Node rather than through Vite, and Node's ESM resolver does
// not guess them. Vite resolves an explicit extension just as happily
import {
  DEFAULT_CONFIG,
  METRIC_FIELDS,
  decodeMetrics,
  encodeConfig,
  encodeScenario,
  encodeScript,
  type Metrics,
  type NetcodeConfig,
} from "../sim/types.ts";
import { BUILT_IN_SCENARIOS } from "../scenarios/store.ts";
import { check, formatOutcome, parseBaseline } from "./check.ts";

const require = createRequire(import.meta.url);

interface Core {
  run_metrics: (...args: never[]) => Float64Array;
  version: () => string;
}

function loadCore(): Core {
  return require("../../core/pkg-node/netcode_core.js") as Core;
}

/**
 * The configuration a baseline pins, over the shipped default.
 *
 * Merged rather than replaced, so a baseline states only the constants it means to
 * hold and a new field added to the config later does not silently arrive as zero.
 */
function configFrom(pinned: Record<string, unknown>): NetcodeConfig {
  const merged: NetcodeConfig = { ...DEFAULT_CONFIG, techniques: { ...DEFAULT_CONFIG.techniques } };
  for (const [key, value] of Object.entries(pinned)) {
    if (key === "techniques" && typeof value === "object" && value !== null) {
      Object.assign(merged.techniques, value);
      continue;
    }
    if (typeof value === "number" && key in merged) {
      (merged as unknown as Record<string, number>)[key] = value;
    }
  }
  return merged;
}

export function runBaseline(path: string): number {
  const core = loadCore();
  const baseline = parseBaseline(readFileSync(path, "utf8"), METRIC_FIELDS);

  const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === baseline.scenarioId);
  if (!scenario) {
    const known = BUILT_IN_SCENARIOS.map((s) => s.id).join(", ");
    throw new Error(
      `the baseline names scenario "${baseline.scenarioId}", which is not a built-in. Known: ${known}`,
    );
  }

  const config = configFrom(baseline.config);
  const runs: Metrics[] = baseline.seeds.map((seed) =>
    decodeMetrics(
      (core.run_metrics as unknown as (...a: unknown[]) => Float64Array)(
        BigInt(seed),
        baseline.segmentIndex,
        encodeScenario(scenario.spec),
        encodeScript(scenario.script),
        encodeConfig(config),
      ),
    ),
  );

  const outcome = check(baseline, runs);
  // the core fingerprint travels with the verdict, because a threshold is only
  // meaningful next to the build that measured against it
  process.stdout.write(`core ${core.version()}\n\n${formatOutcome(baseline, outcome)}\n`);
  return outcome.passed ? 0 : 1;
}

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: npm run baseline -- <path to baseline.json>\n");
  process.exit(2);
}

try {
  process.exit(runBaseline(path));
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(2);
}
