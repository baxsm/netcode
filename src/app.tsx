import { useCallback, useEffect, useRef, useState } from "react";
import { SimPool } from "./workers/pool";
import { DEFAULT_SCENARIO, SEGMENT_PRESETS, type Metrics } from "./sim/types";

interface Row {
  preset: string;
  metrics: Metrics;
}

type Status = "idle" | "running" | "done" | "failed";

const SEEDS = [42n, 43n, 44n];

export default function App() {
  const poolRef = useRef<SimPool | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
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

  const run = useCallback(async () => {
    const pool = poolFor();

    setStatus("running");
    setError("");
    setRows([]);
    setProgress({ completed: 0, total: SEGMENT_PRESETS.length * SEEDS.length });

    try {
      setVersion(await pool.version());

      const indices = SEGMENT_PRESETS.map((_, i) => i);
      const results = await pool.runMany(DEFAULT_SCENARIO, indices, SEEDS, setProgress);

      // results come back in job order: every seed for segment 0, then segment 1...
      const next: Row[] = SEGMENT_PRESETS.map((preset, segment) => {
        const first = results[segment * SEEDS.length];
        if (!first) throw new Error(`no result for ${preset}`);
        return { preset, metrics: first };
      });

      setRows(next);
      setStatus("done");
    } catch (cause) {
      // a run in flight when the pool is disposed rejects, and reporting that as a
      // failure would show an error the user never caused
      if (poolRef.current !== pool) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("failed");
    }
  }, [poolFor]);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <main>
      <header>
        <h1>netcode</h1>
        <p>
          Baseline run with no latency compensation. Every preset shares one seeded
          scenario, so the differences below are the network conditions alone.
        </p>
      </header>

      <section className="controls">
        <button type="button" onClick={() => void run()} disabled={status === "running"}>
          {status === "running" ? "Running" : "Run again"}
        </button>
        {version ? <code data-testid="version">{version}</code> : null}
      </section>

      {status === "running" ? (
        <p className="state" data-testid="progress">
          {progress.completed} of {progress.total} runs
        </p>
      ) : null}

      {status === "failed" ? (
        <p className="state error" data-testid="error" role="alert">
          {error}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <table data-testid="results">
          <caption>Seed 42, {DEFAULT_SCENARIO.durationTicks} ticks at {DEFAULT_SCENARIO.tickRate} Hz</caption>
          <thead>
            <tr>
              <th scope="col">Network</th>
              <th scope="col">Divergence mean</th>
              <th scope="col">Divergence p99</th>
              <th scope="col">Corrections</th>
              <th scope="col">Input latency</th>
              <th scope="col">Packets lost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ preset, metrics }) => (
              <tr key={preset}>
                <th scope="row">{preset}</th>
                <td>{metrics.divergenceMean.toFixed(2)}</td>
                <td>{metrics.divergenceP99.toFixed(2)}</td>
                <td>{metrics.correctionCount}</td>
                <td>{metrics.inputLatencyMeanMs.toFixed(1)} ms</td>
                <td>
                  {metrics.packetsDropped}
                  <span className="muted"> / {metrics.packetsSent}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {status === "done" ? (
        <p className="note">
          Divergence is world units between the server and client bodies. It grows with
          latency and loss because nothing is correcting for either yet.
        </p>
      ) : null}
    </main>
  );
}
