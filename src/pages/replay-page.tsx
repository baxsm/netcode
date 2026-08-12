import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FC } from "react";
import ComparisonTable from "../components/comparison-table";
import PeekersPanel from "../components/peekers-panel";
import ReplayTheatre from "../components/replay-theatre";
import TechniqueControls from "../components/technique-controls";
import type { Comparison, SimPool } from "../workers/pool";
import { useRouteParams } from "../router";
import { useScenarios } from "../scenarios/use-scenarios";
import { decodeConfigParams } from "../verify/link";
import {
  DEFAULT_CONFIG,
  SEGMENT_PRESETS,
  describeConfigError,
  type NetcodeConfig,
} from "../sim/types";

interface ReplayPageProps {
  pool: () => SimPool;
}

type Status = "idle" | "running" | "done" | "failed";

const SEED = 42n;

const ReplayPage: FC<ReplayPageProps> = ({ pool }) => {
  const params = useRouteParams();
  const fromSweep = useMemo(() => decodeConfigParams(params), [params]);
  const { scenarios, scenarioFor } = useScenarios();

  // the scenarios page links here with an id, so opening an authored scenario shows
  // that one rather than the default
  const [scenarioId, setScenarioId] = useState(() => scenarioFor(params.get("scenario")).id);
  const scenario = scenarioFor(scenarioId);

  const [config, setConfig] = useState<NetcodeConfig>(fromSweep ?? DEFAULT_CONFIG);
  const [rows, setRows] = useState<Comparison[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState("");
  const [progress, setProgress] = useState({ completed: 0, total: 0 });

  const run = useCallback(
    async (using: NetcodeConfig) => {
      const active = pool();

      setStatus("running");
      setError("");
      setProgress({ completed: 0, total: SEGMENT_PRESETS.length * 2 });

      try {
        // the core rejects contradictory combinations, so a run is never spent
        // producing a number that quietly came from a different configuration
        const code = await active.validate(using);
        if (code !== 0) {
          setInvalid(describeConfigError(code));
          setRows([]);
          setStatus("done");
          return;
        }
        setInvalid("");

        const indices = SEGMENT_PRESETS.map((_, i) => i);
        setRows(
          await active.runComparison(
            scenario.spec,
            indices,
            SEED,
            using,
            setProgress,
            scenario.script,
          ),
        );
        setStatus("done");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("failed");
      }
    },
    [pool, scenario],
  );

  // the comparison re-runs when the scenario changes, since every number in the table
  // is measured against it. `config` is read through the ref rather than depended on,
  // because re-running on every toggle would fire a sweep mid-edit
  const latest = useRef(config);
  latest.current = config;
  useEffect(() => {
    void run(latest.current);
  }, [run]);

  const enabledCount = useMemo(
    () => Object.values(config.techniques).filter(Boolean).length,
    [config.techniques],
  );

  const running = status === "running";

  return (
    <>
      <header>
        <h1>Replay</h1>
        <p>
          The same moment on a lossy link, seen three ways: what the server holds, and
          what each client draws while predicting it. Corrections flash red, rollbacks
          violet.
        </p>
      </header>

      {fromSweep ? (
        <p className="state" data-testid="from-sweep">
          Showing a configuration carried in from another page rather than the default.
        </p>
      ) : null}

      <section className="controls">
        <div className="field inline">
          <label htmlFor="replay-scenario">Scenario</label>
          <select
            id="replay-scenario"
            value={scenario.id}
            disabled={running}
            onChange={(e) => setScenarioId(e.target.value)}
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <span className="muted">
          {scenario.script.length} scripted{" "}
          {scenario.script.length === 1 ? "input" : "inputs"} over{" "}
          {scenario.spec.durationTicks} ticks at {scenario.spec.tickRate} Hz
        </span>
      </section>

      <ReplayTheatre
        pool={pool}
        config={config}
        scenario={scenario.spec}
        script={scenario.script}
      />

      <h2 className="section-heading">Measured across every preset</h2>
      <p className="note">
        Every network preset run twice on one seeded scenario: once with no
        compensation, once with the techniques below. The difference between the two is
        what these techniques buy on that link.
      </p>

      <TechniqueControls
        config={config}
        disabled={running}
        onChange={setConfig}
        onRun={() => void run(config)}
      />

      <section className="controls">
        <button type="button" onClick={() => void run(config)} disabled={running}>
          {running ? "Running" : "Run comparison"}
        </button>
        <span className="muted">
          {enabledCount} of 6 techniques on, seed {String(SEED)}
        </span>
      </section>

      {running ? (
        <p className="state" data-testid="progress">
          {progress.completed} of {progress.total} runs
        </p>
      ) : null}

      {status === "failed" ? (
        <p className="state error" data-testid="error" role="alert">
          {error}
        </p>
      ) : null}

      {invalid ? (
        <p className="state error" data-testid="invalid" role="alert">
          {invalid}
        </p>
      ) : null}

      {rows.length > 0 && !invalid ? (
        <ComparisonTable rows={rows} scenario={scenario.spec} seed={SEED} />
      ) : null}

      <PeekersPanel pool={pool} />
    </>
  );
};

export default ReplayPage;
