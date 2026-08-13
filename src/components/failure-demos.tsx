import { useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import type { SimPool } from "../workers/pool";
import { useNavigate } from "../router";
import { useScenarios } from "../scenarios/use-scenarios";
import { FAILURE_DEMOS, demonstrates, type FailureDemo } from "../verify/demos";
import { encodeConfigParams } from "../verify/link";

interface FailureDemosProps {
  pool: () => SimPool;
}

interface Measured {
  demo: FailureDemo;
  broken: number;
  fixed: number;
}

const SEED = 7n;

/** Hit accuracy is a fraction; every other metric here is world units. */
function format(demo: FailureDemo, value: number): string {
  return demo.metric === "hitRegistrationAccuracy"
    ? `${(value * 100).toFixed(0)}%`
    : value.toFixed(2);
}

/**
 * The three failure modes, each measured rather than described.
 *
 * Every demo runs twice: once with the configuration that causes the failure, once
 * with the cause removed. Showing only the broken run would leave a number with
 * nothing to be bad relative to, and a caption claiming a failure with no measurement
 * behind it would be exactly the kind of thing this page exists to disprove.
 */
const FailureDemos: FC<FailureDemosProps> = ({ pool }) => {
  const navigate = useNavigate();
  const { scenarioFor } = useScenarios();
  const [rows, setRows] = useState<Measured[]>([]);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState("");

  /**
   * False once this mount has been torn down. See `determinism-panel.tsx`: six
   * simulations outlive a route change, and a discarded mount's run must not write
   * over the result the visible one is waiting for.
   */
  const live = useRef(true);

  const run = useCallback(async (alive: () => boolean = () => true) => {
    setRunning(true);
    setError("");
    try {
      const active = pool();
      const measured = await Promise.all(
        FAILURE_DEMOS.map(async (demo) => {
          const scenario = scenarioFor(demo.scenarioId);
          const [broken, fixed] = await Promise.all([
            active.runCustom(scenario.spec, demo.segment, SEED, demo.broken, scenario.script),
            active.runCustom(scenario.spec, demo.segment, SEED, demo.fixed, scenario.script),
          ]);
          return { demo, broken: broken[demo.metric], fixed: fixed[demo.metric] };
        }),
      );
      if (!alive()) return;
      setRows(measured);
      setRunning(false);
    } catch (cause) {
      if (!alive()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setRunning(false);
    }
  }, [pool, scenarioFor]);

  useEffect(() => {
    live.current = true;
    void run(() => live.current);
    return () => {
      live.current = false;
    };
  }, [run]);

  return (
    <section className="panel" aria-labelledby="demos-heading">
      <div className="panel-head">
        <h2 id="demos-heading">Failure modes</h2>
      </div>

      <p className="note">
        Each of these runs the same scenario twice on the same seed and link: once with
        the configuration that causes the failure, once with that cause removed. The
        numbers are what the run measured, so a demo that stopped reproducing its own
        failure would say so here rather than keep its caption.
      </p>

      {error ? (
        <p className="state error" role="alert">
          {error}{" "}
          <button type="button" className="ghost" onClick={() => void run()}>
            Try again
          </button>
        </p>
      ) : null}

      {running && rows.length === 0 ? (
        <p className="state" data-testid="demos-loading">
          Running {FAILURE_DEMOS.length * 2} simulations.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="demo-list" data-testid="demo-list">
          {rows.map(({ demo, broken, fixed }) => {
            const holds = demonstrates(demo, broken, fixed);
            const scenario = scenarioFor(demo.scenarioId);
            return (
              <li key={demo.id} data-testid="demo">
                <div className="demo-head">
                  <h3>{demo.title}</h3>
                  <span className={holds ? "verdict pass" : "verdict fail"}>
                    {holds ? "Reproduces" : "Did not reproduce"}
                  </span>
                </div>

                <p>{demo.symptom}</p>
                <p className="muted">{demo.cause}</p>

                <dl className="demo-numbers">
                  <div>
                    <dt>{demo.metricLabel}, broken</dt>
                    <dd className="tabular">{format(demo, broken)}</dd>
                  </div>
                  <div>
                    <dt>{demo.metricLabel}, fixed</dt>
                    <dd className="tabular">{format(demo, fixed)}</dd>
                  </div>
                  <div>
                    <dt>Scenario</dt>
                    <dd>{scenario.name}</dd>
                  </div>
                  <div>
                    <dt>Link</dt>
                    <dd>
                      {demo.segment.rttMeanMs} ms, {demo.segment.lossPct}% loss
                    </dd>
                  </div>
                </dl>

                <button
                  type="button"
                  className="ghost"
                  data-testid={`open-${demo.id}`}
                  onClick={() =>
                    navigate("/", {
                      scenario: demo.scenarioId,
                      ...encodeConfigParams(demo.broken),
                    })
                  }
                >
                  Open the broken run in replay
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
};

export default FailureDemos;
