import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FC } from "react";
import ParetoChart from "../components/pareto-chart";
import SweepControls from "../components/sweep-controls";
import SweepResult from "../components/sweep-result";
import type { SimPool } from "../workers/pool";
import { useNavigate } from "../router";
import { useScenarios } from "../scenarios/use-scenarios";
import type { NetcodeConfig, SweepPoint } from "../sim/types";
import {
  DEFAULT_SEED_COUNT,
  planSweep,
  RESOLUTION_FLOOR,
  TECHNIQUE_PRESETS,
} from "../sweep/grid";
import { balancedIndex, frontOrder, paretoIndices } from "../sweep/pareto";
import { PROFILES } from "../sweep/profiles";
import { buildReport, downloadJson } from "../sweep/report";
import { configJson } from "../sweep/metrics-view";
import { encodeConfigParams } from "../verify/link";

interface TunePageProps {
  pool: () => SimPool;
  coreVersion: string;
}

type Status = "idle" | "running" | "done" | "failed";

/**
 * Ticks a swept run covers.
 *
 * Shorter than the scenario's own duration, because a sweep runs it thousands of
 * times and the tradeoff being measured has settled well before then. Capped rather
 * than replaced, so a scenario authored shorter than this keeps its own length.
 */
const SWEEP_TICKS = 300;

const TunePage: FC<TunePageProps> = ({ pool, coreVersion }) => {
  const navigate = useNavigate();
  const { scenarios, profiles, scenarioFor, profileFor } = useScenarios();
  const [scenarioId, setScenarioId] = useState(() => scenarioFor(null).id);
  const [profileId, setProfileId] = useState(PROFILES[0]?.id ?? "mixed");
  const [presetLabel, setPresetLabel] = useState(TECHNIQUE_PRESETS[0]?.label ?? "Full stack");
  const [seedCount, setSeedCount] = useState(DEFAULT_SEED_COUNT);

  const [points, setPoints] = useState<SweepPoint[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [compared, setCompared] = useState<number | null>(null);

  const chosen = scenarioFor(scenarioId);
  const profile = profileFor(profileId);

  /**
   * The scenario as the sweep runs it, capped for cost.
   *
   * Held in a memo so the object identity is stable, since it is a dependency of the
   * run callback and a fresh object every render would make that callback new every
   * render too.
   */
  const sweepScenario = useMemo(
    () => ({
      ...chosen.spec,
      durationTicks: Math.min(chosen.spec.durationTicks, SWEEP_TICKS),
    }),
    [chosen.spec],
  );
  const techniques = useMemo(
    () =>
      TECHNIQUE_PRESETS.find((p) => p.label === presetLabel)?.techniques ??
      (TECHNIQUE_PRESETS[0]?.techniques as NetcodeConfig["techniques"]),
    [presetLabel],
  );
  const plan = useMemo(
    () => planSweep(techniques, seedCount, profile.segments.length),
    [techniques, seedCount, profile.segments.length],
  );

  const front = useMemo(() => paretoIndices(points), [points]);
  const frontOrdered = useMemo(() => frontOrder(points, front), [points, front]);
  const frontSet = useMemo(() => new Set(front), [front]);

  /** Kept in a ref so the ticker does not restart on every progress update. */
  const startedAt = useRef(0);

  useEffect(() => {
    if (status !== "running") return;
    const id = window.setInterval(
      () => setElapsed((performance.now() - startedAt.current) / 1000),
      100,
    );
    return () => window.clearInterval(id);
  }, [status]);

  const run = useCallback(async () => {
    const active = pool();
    setStatus("running");
    setError("");
    setSelected(null);
    setCompared(null);
    setProgress({ completed: 0, total: plan.configs.length });
    startedAt.current = performance.now();
    setElapsed(0);

    try {
      const result = await active.runSweep(
        sweepScenario,
        plan.configs,
        profile.segments,
        plan.configs.length > 0 ? Array.from({ length: seedCount }, (_, i) => i + 1) : [],
        setProgress,
        chosen.script,
      );
      setPoints(result);
      // the balanced point is a starting suggestion, not the answer. which end of
      // the front to take is the tradeoff the page exists to show
      setSelected(balancedIndex(result, paretoIndices(result)));
      setElapsed((performance.now() - startedAt.current) / 1000);
      setStatus("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("failed");
    }
  }, [plan.configs, pool, profile.segments, seedCount, sweepScenario, chosen.script]);

  const select = useCallback(
    (index: number, additive: boolean) => {
      if (additive) {
        setCompared((current) => (current === index ? null : index));
        return;
      }
      setSelected(index);
    },
    [],
  );

  const point = selected !== null ? points[selected] : undefined;
  const other = compared !== null ? points[compared] : undefined;
  const running = status === "running";

  const openInReplay = useCallback(() => {
    if (!point) return;
    // the replay reads the constants off the hash, so the chosen point opens as the
    // configuration it actually is rather than as the page default
    navigate("/", { scenario: chosen.id, ...encodeConfigParams(point.config) });
  }, [navigate, point, chosen.id]);

  return (
    <>
      <header>
        <h1>Tune</h1>
        <p>
          Every configuration on the grid, run against every seed and every segment of
          the population, then aggregated by how many players each segment represents.
          Points where responsiveness cannot improve without costing smoothness are the
          front.
        </p>
      </header>

      <SweepControls
        scenario={chosen}
        scenarios={scenarios}
        profile={profile}
        profiles={profiles}
        presetLabel={presetLabel}
        seedCount={seedCount}
        sweepTicks={sweepScenario.durationTicks}
        plan={plan}
        running={running}
        onScenario={setScenarioId}
        onProfile={setProfileId}
        onPreset={setPresetLabel}
        onSeedCount={setSeedCount}
        onRun={() => void run()}
      />

      {running ? (
        <p className="state" data-testid="sweep-progress" role="status">
          {progress.completed} of {progress.total} configurations, {elapsed.toFixed(1)} s
          elapsed
        </p>
      ) : null}

      {status === "failed" ? (
        <p className="state error" data-testid="sweep-error" role="alert">
          {error}
        </p>
      ) : null}

      {status === "idle" ? (
        <p className="state" data-testid="sweep-empty">
          No sweep yet. Pick a population and run one.
        </p>
      ) : null}

      {points.length > 0 ? (
        <section className="panel" aria-labelledby="front-heading">
          <div className="panel-head">
            <h2 id="front-heading">The tradeoff</h2>
            <span className="muted" data-testid="front-size">
              {front.length} of {points.length} on the front, {elapsed.toFixed(1)} s
            </span>
          </div>

          <ParetoChart
            points={points}
            frontOrdered={frontOrdered}
            scenario={sweepScenario}
            selected={selected}
            compared={compared}
            onSelect={select}
          />

          <ul className="legend">
            <li>
              <span className="swatch" style={{ background: "#58a6ff" }} />
              On the front
            </li>
            <li>
              <span className="swatch" style={{ background: "#3d4653" }} />
              Dominated
            </li>
            <li>
              <span className="swatch" style={{ background: "#e6edf3" }} />
              Selected
            </li>
            <li>
              <span className="swatch" style={{ background: "#f0883e" }} />
              Compared
            </li>
          </ul>

          <p className="note">
            Differences smaller than {RESOLUTION_FLOOR.toFixed(3)} on either score sit
            inside the run-to-run spread at {seedCount} seeds, so points that close
            together are not meaningfully apart.
          </p>
        </section>
      ) : null}

      {point ? (
        <SweepResult
          point={point}
          comparedTo={other ?? null}
          scenario={sweepScenario}
          onFront={selected !== null && frontSet.has(selected)}
          onOpenReplay={openInReplay}
          onExportConfig={() =>
            downloadJson("netcode-config.json", configJson(point.config))
          }
          onExportReport={() =>
            downloadJson(
              "netcode-report.json",
              buildReport({
                scenario: sweepScenario,
                scenarioId: chosen.id,
                scenarioName: chosen.name,
                script: chosen.script,
                profile,
                seeds: Array.from({ length: seedCount }, (_, i) => i + 1),
                points,
                frontIndices: front,
                chosenIndex: selected ?? 0,
                coreVersion,
                resolutionFloor: RESOLUTION_FLOOR,
              }),
            )
          }
          onClearComparison={() => setCompared(null)}
        />
      ) : null}
    </>
  );
};

export default TunePage;
