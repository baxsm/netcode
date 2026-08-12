import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SimPool, type Comparison } from "./workers/pool";
import TechniqueControls from "./components/technique-controls";
import ComparisonTable from "./components/comparison-table";
import PeekersPanel from "./components/peekers-panel";
import ReplayTheatre from "./components/replay-theatre";
import {
  DEFAULT_CONFIG,
  DEFAULT_SCENARIO,
  SEGMENT_PRESETS,
  describeConfigError,
  type NetcodeConfig,
} from "./sim/types";

type Status = "idle" | "running" | "done" | "failed";

const SEED = 42n;

export default function App() {
  const poolRef = useRef<SimPool | null>(null);
  const [config, setConfig] = useState<NetcodeConfig>(DEFAULT_CONFIG);
  const [rows, setRows] = useState<Comparison[]>([]);
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState("");
  const [progress, setProgress] = useState({ completed: 0, total: 0 });

  /**
   * Created on demand rather than during render.
   *
   * StrictMode mounts, unmounts and remounts in development, so a pool built during
   * render is disposed by the first cleanup and then reused dead by the second pass,
   * which surfaces as "Proxy has been released". Building it here means the remount
   * gets a live pool.
   */
  const poolFor = useCallback((): SimPool => {
    if (!poolRef.current) poolRef.current = new SimPool();
    return poolRef.current;
  }, []);

  useEffect(() => {
    return () => {
      poolRef.current?.dispose();
      poolRef.current = null;
    };
  }, []);

  const run = useCallback(
    async (using: NetcodeConfig) => {
      const pool = poolFor();

      setStatus("running");
      setError("");
      setProgress({ completed: 0, total: SEGMENT_PRESETS.length * 2 });

      try {
        setVersion(await pool.version());

        // the core rejects contradictory combinations, so a run is never spent
        // producing a number that quietly came from a different configuration
        const code = await pool.validate(using);
        if (code !== 0) {
          setInvalid(describeConfigError(code));
          setRows([]);
          setStatus("done");
          return;
        }
        setInvalid("");

        const indices = SEGMENT_PRESETS.map((_, i) => i);
        setRows(await pool.runComparison(DEFAULT_SCENARIO, indices, SEED, using, setProgress));
        setStatus("done");
      } catch (cause) {
        // a run in flight when the pool is disposed rejects, and reporting that as a
        // failure would show an error the user never caused
        if (poolRef.current !== pool) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("failed");
      }
    },
    [poolFor],
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
    <main>
      <header>
        <h1>netcode</h1>
        <p>
          The same moment on a lossy link, seen three ways: what the server holds, and
          what each client draws while predicting it. Corrections flash red, rollbacks
          violet.
        </p>
      </header>

      <ReplayTheatre pool={poolFor} config={config} />

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

      <PeekersPanel pool={poolFor} />

      {version ? (
        <footer>
          {/* the build flags travel with every result, because a number is only
              meaningful next to the build that produced it */}
          <code data-testid="version">core {version}</code>
        </footer>
      ) : null}
    </main>
  );
}
