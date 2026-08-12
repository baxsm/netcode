import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FC } from "react";
import ComparisonTable from "../components/comparison-table";
import PeekersPanel from "../components/peekers-panel";
import ReplayTheatre from "../components/replay-theatre";
import TechniqueControls from "../components/technique-controls";
import type { Comparison, SimPool } from "../workers/pool";
import { useRouteParams } from "../router";
import {
  DEFAULT_CONFIG,
  DEFAULT_SCENARIO,
  SEGMENT_PRESETS,
  TECHNIQUE_FIELDS,
  describeConfigError,
  type NetcodeConfig,
  type TechniqueSet,
} from "../sim/types";

interface ReplayPageProps {
  pool: () => SimPool;
}

type Status = "idle" | "running" | "done" | "failed";

const SEED = 42n;

/**
 * A configuration carried in from the sweep, when there is one.
 *
 * The tune page links here with the constants of the point that was chosen, so
 * "open in replay" shows that configuration rather than the page default. Anything
 * missing or unparseable falls back to the default rather than to zero, since a
 * partly-applied config would show numbers for something nobody selected.
 */
function configFromParams(params: URLSearchParams): NetcodeConfig | null {
  if (![...params.keys()].length) return null;

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
    serverRewindLimitMs: DEFAULT_CONFIG.serverRewindLimitMs,
    extrapolationLimitTicks: number("extrap", DEFAULT_CONFIG.extrapolationLimitTicks),
  };
}

const ReplayPage: FC<ReplayPageProps> = ({ pool }) => {
  const params = useRouteParams();
  const fromSweep = useMemo(() => configFromParams(params), [params]);

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
        setRows(await active.runComparison(DEFAULT_SCENARIO, indices, SEED, using, setProgress));
        setStatus("done");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("failed");
      }
    },
    [pool],
  );

  // the initial run only. `config` is deliberately read through the ref rather than
  // depended on, because re-running on every toggle would fire a sweep mid-edit
  const initial = useRef(config);
  useEffect(() => {
    void run(initial.current);
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
          Showing the configuration selected on the tune page.
        </p>
      ) : null}

      <ReplayTheatre pool={pool} config={config} />

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
        <ComparisonTable rows={rows} scenario={DEFAULT_SCENARIO} seed={SEED} />
      ) : null}

      <PeekersPanel pool={pool} />
    </>
  );
};

export default ReplayPage;
