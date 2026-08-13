import { useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import { ArrowRight, ExternalLink, RotateCcw } from "lucide-react";
import StatusNote from "./status-note";
import Verdict from "./verdict";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
    <Card aria-labelledby="demos-heading">
      <CardHeader>
        <CardTitle id="demos-heading">Failure modes</CardTitle>
        <CardDescription>
          Each of these runs the same scenario twice on the same seed and link: once
          with the configuration that causes the failure, once with that cause removed.
          The numbers are what the run measured, so a demo that stopped reproducing its
          own failure would say so here rather than keep its caption.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <StatusNote tone="error" className="justify-between gap-4">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void run()}>
              <RotateCcw data-icon="inline-start" />
              Try again
            </Button>
          </StatusNote>
        ) : null}

        {running && rows.length === 0 ? (
          <StatusNote tone="busy" data-testid="demos-loading">
            Running {FAILURE_DEMOS.length * 2} simulations.
          </StatusNote>
        ) : null}

        {rows.length > 0 ? (
          /* divider separated rather than a card each, because a card inside a card
             gives every demo a second frame it does not need */
          <ul data-testid="demo-list">
            {rows.map(({ demo, broken, fixed }) => {
              const holds = demonstrates(demo, broken, fixed);
              const scenario = scenarioFor(demo.scenarioId);
              return (
                <li
                  key={demo.id}
                  data-testid="demo"
                  className="space-y-3 border-t border-border py-5 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <div className="flex items-start justify-between gap-4">
                    <h3 className="font-heading text-sm leading-snug font-medium text-foreground">
                      {demo.title}
                    </h3>
                    <Verdict passed={holds}>
                      {holds ? "Reproduces" : "Did not reproduce"}
                    </Verdict>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-sm leading-relaxed text-foreground">
                      {demo.symptom}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {demo.cause}
                    </p>
                  </div>

                  {/* the pair is one measurement read twice, so the two figures sit on
                      one line with the arrow between them. four equal cells would have
                      hidden the only thing the demo is claiming, which is the
                      difference from the broken run to the fixed one */}
                  <dl className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border bg-raised px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          {demo.metricLabel}, broken
                        </dt>
                        <dd className="tabular text-base font-medium text-destructive">
                          {format(demo, broken)}
                        </dd>
                      </div>
                      <ArrowRight
                        className="size-4 shrink-0 self-end pb-1 text-muted-foreground"
                        aria-hidden
                      />
                      <div>
                        <dt className="text-xs text-muted-foreground">fixed</dt>
                        <dd className="tabular text-base font-medium text-pass">
                          {format(demo, fixed)}
                        </dd>
                      </div>
                    </div>

                    <div className="ml-auto flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">Scenario</dt>
                        <dd className="text-foreground">{scenario.name}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Link</dt>
                        <dd className="tabular text-foreground">
                          {demo.segment.rttMeanMs} ms, {demo.segment.lossPct}% loss
                        </dd>
                      </div>
                    </div>
                  </dl>

                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`open-${demo.id}`}
                    onClick={() =>
                      navigate("/", {
                        scenario: demo.scenarioId,
                        ...encodeConfigParams(demo.broken),
                      })
                    }
                  >
                    <ExternalLink data-icon="inline-start" />
                    Open the broken run in replay
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
};

export default FailureDemos;
