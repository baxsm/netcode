import type { FC } from "react";
import Icon from "./icon";
import type { AuthoredScenario } from "../scenarios/store";
import { DEFAULT_SEED_COUNT, TECHNIQUE_PRESETS, type SweepPlan } from "../sweep/grid";
import { describeSegment, totalWeight, weightsAreWhole } from "../sweep/profiles";
import type { NetworkProfile } from "../sweep/profiles";

interface SweepControlsProps {
  scenario: AuthoredScenario;
  scenarios: readonly AuthoredScenario[];
  profile: NetworkProfile;
  profiles: readonly NetworkProfile[];
  presetLabel: string;
  seedCount: number;
  sweepTicks: number;
  plan: SweepPlan;
  running: boolean;
  onScenario: (id: string) => void;
  onProfile: (id: string) => void;
  onPreset: (label: string) => void;
  onSeedCount: (count: number) => void;
  onRun: () => void;
}

const SEED_CHOICES = [4, 8, 16];

const SweepControls: FC<SweepControlsProps> = ({
  scenario,
  scenarios,
  profile,
  profiles,
  presetLabel,
  seedCount,
  sweepTicks,
  plan,
  running,
  onScenario,
  onProfile,
  onPreset,
  onSeedCount,
  onRun,
}) => (
  <section className="panel" aria-labelledby="sweep-controls-heading">
    <div className="panel-head">
      <h2 id="sweep-controls-heading">What to search</h2>
    </div>

    <div className="sweep-fields">
      <div className="field">
        <label htmlFor="sweep-scenario">Scenario</label>
        <select
          id="sweep-scenario"
          value={scenario.id}
          disabled={running}
          onChange={(e) => onScenario(e.target.value)}
        >
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="field-note">
          {scenario.script.length} scripted{" "}
          {scenario.script.length === 1 ? "input" : "inputs"}, run over the first{" "}
          {sweepTicks} ticks.
        </span>
      </div>

      <div className="field">
        <label htmlFor="profile">Player population</label>
        <select
          id="profile"
          value={profile.id}
          disabled={running}
          onChange={(e) => onProfile(e.target.value)}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="field-note">{profile.description}</span>
      </div>

      <div className="field">
        <label htmlFor="preset">Technique set</label>
        <select
          id="preset"
          value={presetLabel}
          disabled={running}
          onChange={(e) => onPreset(e.target.value)}
        >
          {TECHNIQUE_PRESETS.map((p) => (
            <option key={p.label} value={p.label}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="field-note">
          Which techniques are on. The sweep tunes the constants around them.
        </span>
      </div>

      <div className="field">
        <label htmlFor="seeds">Seeds per configuration</label>
        <select
          id="seeds"
          value={seedCount}
          disabled={running}
          onChange={(e) => onSeedCount(Number(e.target.value))}
        >
          {SEED_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n}
              {n === DEFAULT_SEED_COUNT ? " (measured default)" : ""}
            </option>
          ))}
        </select>
        <span className="field-note">
          More seeds narrow the noise floor and cost proportionally more runs.
        </span>
      </div>
    </div>

    <ul className="segment-list">
      {profile.segments.map((s, i) => (
        <li key={`${s.rttMeanMs}-${s.lossPct}-${i}`}>
          <span
            className="segment-share"
            style={{ width: `${(s.weightPermille / 1000) * 100}%` }}
            aria-hidden="true"
          />
          <span className="segment-weight">{(s.weightPermille / 10).toFixed(0)}%</span>
          <span className="segment-conditions">{describeSegment(s)}</span>
        </li>
      ))}
    </ul>

    {/* the core renormalizes whatever it is given, so a profile that does not sum to
        a whole population still runs. it would just answer a different question than
        the one on screen, which is why this says so rather than silently correcting */}
    {weightsAreWhole(profile.segments) ? null : (
      <p className="state error" role="alert">
        Segment weights total {(totalWeight(profile.segments) / 10).toFixed(0)}% rather
        than 100%. Results will be scaled to a whole population.
      </p>
    )}

    <div className="sweep-run">
      <button type="button" onClick={onRun} disabled={running} data-testid="run-sweep">
        <Icon name="run" className={running ? "spin" : undefined} />
        {running ? "Sweeping" : "Run sweep"}
      </button>
      <span className="muted" data-testid="sweep-size">
        {plan.configs.length} configurations, {plan.runCount.toLocaleString()} simulations
      </span>
    </div>

    {/* a bounded search must never read as full coverage */}
    <p className="note coverage">
      This searches {plan.configs.length} points on a coarse grid over{" "}
      {plan.axes.map((a) => a.label.toLowerCase()).join(", ")}. It is a sample of the
      parameter space, not an exhaustive search of it.
      {plan.inert.length > 0 ? (
        <>
          {" "}
          {plan.inert.map((a) => a.label.toLowerCase()).join(" and ")} is held at its
          default because a predicting client draws its own simulation rather than the
          buffer that constant indexes into, so varying it would produce identical
          results under different labels.
        </>
      ) : null}
    </p>
  </section>
);

export default SweepControls;
