import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runner = join(root, "src/baseline/run.ts");
const shipped = join(root, "baselines/default.json");

interface Run {
  status: number;
  output: string;
}

/**
 * Runs the baseline checker as CI would, as a child process.
 *
 * Called in process it would prove the check function works while saying nothing
 * about the exit code, which is the entire contract with CI. A checker that always
 * exited zero would pass every in-process test ever written for it.
 */
function runBaseline(path: string): Run {
  try {
    const output = execFileSync(
      process.execPath,
      ["--experimental-strip-types", runner, path],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, output };
  } catch (cause) {
    const error = cause as { status?: number; stdout?: string; stderr?: string };
    return { status: error.status ?? -1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function withBaseline(mutate: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(readFileSync(shipped, "utf8")) as Record<string, unknown>;
  mutate(value);
  const path = join(mkdtempSync(join(tmpdir(), "netcode-baseline-")), "baseline.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("the CI baseline runner", () => {
  it("passes on the shipped baseline and exits zero", () => {
    const run = runBaseline(shipped);
    expect(run.output).toContain("every threshold held");
    expect(run.status).toBe(0);
  });

  it("reports the core fingerprint alongside the verdict", () => {
    expect(runBaseline(shipped).output).toContain("relaxed_simd=false");
  });

  /**
   * The half that matters. A checker that never fails is worse than no checker,
   * because it reports a green build forever while quality rots underneath it.
   */
  it("fails a broken baseline with a readable diff and a non-zero exit", () => {
    const path = withBaseline((value) => {
      const thresholds = value.thresholds as Array<Record<string, unknown>>;
      const first = thresholds[0];
      if (first) first.value = 0.001;
    });

    const run = runBaseline(path);
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL");
    expect(run.output).toContain("off by");
    expect(run.output).toContain("thresholds failed");
  });

  it("rejects a baseline naming a scenario that does not exist", () => {
    const path = withBaseline((value) => {
      value.scenarioId = "not-a-scenario";
    });
    const run = runBaseline(path);
    // two rather than one, so a malformed baseline is distinguishable in CI from a
    // real quality regression
    expect(run.status).toBe(2);
    expect(run.output).toContain("not a built-in");
  });

  it("rejects a baseline from a different schema version", () => {
    const path = withBaseline((value) => {
      value.schemaVersion = 99;
    });
    const run = runBaseline(path);
    expect(run.status).toBe(2);
    expect(run.output).toContain("schema version");
  });

  it("reports usage when given no file", () => {
    const run = runBaseline("");
    expect(run.status).toBe(2);
  });

  /**
   * The thresholds have to sit above what the build actually measures, or the check
   * is one unlucky change away from failing for no reason. Tightening them to the
   * measured value exactly would be a check that fails on its own noise.
   */
  it("ships thresholds with headroom over the measured values", () => {
    const output = runBaseline(shipped).output;
    const rows = [...output.matchAll(/measured ([\d.]+) <= ([\d.]+)/g)];
    expect(rows.length).toBeGreaterThan(0);
    for (const [, measured, limit] of rows) {
      const headroom = Number(limit) / Number(measured);
      expect(headroom, `measured ${measured} against ${limit}`).toBeGreaterThan(1.05);
    }
  });
});
