import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FC } from "react";
import { Import, LoaderCircle, Play } from "lucide-react";
import ComparisonTable from "../components/comparison-table";
import PeekersPanel from "../components/peekers-panel";
import ReplayTheatre from "../components/replay-theatre";
import StatusNote from "../components/status-note";
import TechniqueControls from "../components/technique-controls";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
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
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Replay</h1>
          <p className="text-sm text-muted-foreground">
            The same moment on a lossy link, seen three ways: what the server holds, and
            what each client draws while predicting it. Corrections flash red, rollbacks
            violet.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Label htmlFor="replay-scenario" className="text-xs text-muted-foreground">
            Scenario
          </Label>
          <Select
            value={scenario.id}
            disabled={running}
            onValueChange={(value) => {
              if (typeof value === "string") setScenarioId(value);
            }}
          >
            <SelectTrigger id="replay-scenario" className="w-56" data-testid="scenario-pick">
              {/* Base UI renders the raw value unless told otherwise, so the trigger
                  showed the scenario id rather than its name */}
              <SelectValue>{() => scenario.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {scenarios.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {fromSweep ? (
        <p
          className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm"
          data-testid="from-sweep"
        >
          <Import className="size-4 shrink-0 text-primary" aria-hidden />
          Showing a configuration carried in from another page rather than the default.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {scenario.script.length} scripted{" "}
        {scenario.script.length === 1 ? "input" : "inputs"} over{" "}
        {scenario.spec.durationTicks} ticks at {scenario.spec.tickRate} Hz
      </p>

      <ReplayTheatre
        pool={pool}
        config={config}
        scenario={scenario.spec}
        script={scenario.script}
      />

      <Separator />

      <div className="space-y-1.5">
        <h2 className="font-heading text-lg font-semibold tracking-tight">
          Measured across every preset
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Every network preset run twice on one seeded scenario: once with no
          compensation, once with the techniques below. The difference between the two
          is what these techniques buy on that link.
        </p>
      </div>

      <TechniqueControls
        config={config}
        disabled={running}
        onChange={setConfig}
        onRun={() => void run(config)}
      />

      <div className="flex flex-wrap items-center gap-3">
        {/* fixed width: the label swaps between "Run comparison" and "Running", which
            is an 8 character difference and moved the note beside it */}
        <Button
          onClick={() => void run(config)}
          disabled={running}
          data-testid="run-comparison"
          className="w-[10.5rem]"
        >
          {running ? (
            <LoaderCircle className="animate-spin" data-icon="inline-start" />
          ) : (
            <Play className="fill-current" data-icon="inline-start" />
          )}
          {running ? "Running" : "Run comparison"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {enabledCount} of 6 techniques on, seed {String(SEED)}
        </span>
      </div>

      {running ? (
        <StatusNote tone="busy" data-testid="progress">
          <span className="tabular">
            {progress.completed} of {progress.total}
          </span>{" "}
          runs
        </StatusNote>
      ) : null}

      {status === "failed" ? (
        <StatusNote tone="error" data-testid="error">
          {error}
        </StatusNote>
      ) : null}

      {invalid ? (
        <StatusNote tone="error" data-testid="invalid">
          {invalid}
        </StatusNote>
      ) : null}

      {rows.length > 0 && !invalid ? (
        <ComparisonTable rows={rows} scenario={scenario.spec} seed={SEED} />
      ) : null}

      <Separator />

      <PeekersPanel pool={pool} />
    </div>
  );
};

export default ReplayPage;
