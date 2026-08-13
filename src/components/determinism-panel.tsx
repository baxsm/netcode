import { useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import type { SimPool } from "../workers/pool";
import { BUILT_IN_SCENARIOS } from "../scenarios/store";
import { DEFAULT_CONFIG } from "../sim/types";

interface DeterminismPanelProps {
  pool: () => SimPool;
  coreVersion: string;
}

/** Repeats of one seed. Enough that a run varying only sometimes still shows up. */
const REPEATS = 5;

/** A second seed, so a hash that is constant regardless of input cannot pass. */
const SEEDS = [42n, 43n] as const;

/** A lossy preset, since a clean link exercises far less of the run. */
const SEGMENT_INDEX = 6;

interface Result {
  seed: bigint;
  hashes: string[];
}

/**
 * The determinism check, run in the browser.
 *
 * Cross-engine agreement is a CI concern and is gated in Playwright across Chromium
 * and Firefox. What this adds is making the property visible in the product, next to
 * the build that produced it, because a hash without its build fingerprint says
 * nothing about which core it came from.
 */
const DeterminismPanel: FC<DeterminismPanelProps> = ({ pool, coreVersion }) => {
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState("");

  /**
   * False once this mount has been torn down.
   *
   * A check is ten simulations, so it easily outlives a route change or the StrictMode
   * remount that starts a second one. Without this, the run belonging to the mount
   * that was discarded still writes its result, and the panel shows whichever finished
   * last rather than the one the visible mount asked for.
   */
  const live = useRef(true);

  const check = useCallback(async (alive: () => boolean = () => true) => {
    setRunning(true);
    setError("");
    try {
      const active = pool();
      const scenario = BUILT_IN_SCENARIOS[0];
      if (!scenario) throw new Error("no built-in scenario to check against");

      const measured = await Promise.all(
        SEEDS.map(async (seed) => ({
          seed,
          hashes: await Promise.all(
            Array.from({ length: REPEATS }, () =>
              active
                .checkDeterminism(
                  scenario.spec,
                  SEGMENT_INDEX,
                  seed,
                  DEFAULT_CONFIG,
                  scenario.script,
                )
                .then((hash) => hash.toString(16).padStart(16, "0")),
            ),
          ),
        })),
      );
      if (!alive()) return;
      setResults(measured);
      setRunning(false);
    } catch (cause) {
      if (!alive()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setRunning(false);
    }
  }, [pool]);

  useEffect(() => {
    live.current = true;
    void check(() => live.current);
    return () => {
      live.current = false;
    };
  }, [check]);

  const stable = results.every((r) => new Set(r.hashes).size === 1);
  const distinct = new Set(results.map((r) => r.hashes[0])).size === results.length;
  const held = results.length > 0 && stable && distinct;

  return (
    <section className="panel" aria-labelledby="determinism-heading">
      <div className="panel-head">
        <h2 id="determinism-heading">Determinism</h2>
        {results.length > 0 ? (
          <span className={held ? "verdict pass" : "verdict fail"} data-testid="determinism-verdict">
            {held ? "Stable and seed dependent" : "Hashes disagree"}
          </span>
        ) : null}
      </div>

      <p className="note">
        The same seed run {REPEATS} times must produce one hash, and two seeds must
        produce different ones. The first property is what makes a result reproducible;
        the second is what stops a hash that ignores its input from passing as stable.
        Agreement across engines is checked in CI, against Chromium and Firefox.
      </p>

      {error ? (
        <p className="state error" role="alert">
          {error}{" "}
          <button type="button" className="ghost" onClick={() => void check()}>
            Try again
          </button>
        </p>
      ) : null}

      {running && results.length === 0 ? (
        <p className="state" data-testid="determinism-loading">
          Running {REPEATS * SEEDS.length} simulations.
        </p>
      ) : null}

      {results.length > 0 ? (
        <div className="table-wrap">
          <table data-testid="determinism-table">
            <thead>
              <tr>
                <th scope="col">Seed</th>
                <th scope="col">State hash</th>
                <th scope="col">Runs</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => {
                const unique = new Set(result.hashes).size;
                return (
                  <tr key={String(result.seed)} data-testid="determinism-row">
                    <th scope="row">{String(result.seed)}</th>
                    <td>
                      <code>{result.hashes[0]}</code>
                    </td>
                    <td>{result.hashes.length}</td>
                    <td>
                      <span className={unique === 1 ? "verdict pass" : "verdict fail"}>
                        {unique === 1 ? "Identical" : `${unique} different hashes`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* a hash is only meaningful next to the core that produced it, so the build
          fingerprint sits with the result rather than only in the top bar */}
      <p className="note">
        Produced by core <code>{coreVersion || "unknown"}</code>. Relaxed SIMD is
        reported in that string because its instructions may return different results
        for the same inputs, which would break every guarantee on this page.
      </p>
    </section>
  );
};

export default DeterminismPanel;
