import type { FC } from "react";
import type { ScenarioSpec } from "../sim/types";
import { LIMITS, type AuthoredScenario, type LimitedField } from "../scenarios/store";

interface ScenarioEditorProps {
  scenario: AuthoredScenario;
  readOnly: boolean;
  problems: string[];
  onChange: (scenario: AuthoredScenario) => void;
}

/**
 * The constants the simulation actually reads.
 *
 * The world holds one controllable body, so there is no entity list here. Offering
 * one would let the editor describe bodies the core never integrates, and every
 * metric would then report on motion that did not happen.
 */
const FIELDS: Array<{ field: LimitedField; label: string; unit: string; note: string }> = [
  {
    field: "tickRate",
    label: "Tick rate",
    unit: "Hz",
    note: "Simulation steps per second, for both server and client.",
  },
  {
    field: "durationTicks",
    label: "Duration",
    unit: "ticks",
    note: "The first 32 ticks are warmup and are not measured.",
  },
  {
    field: "accel",
    label: "Acceleration",
    unit: "units/s²",
    note: "How hard an input pushes the body.",
  },
  {
    field: "maxSpeed",
    label: "Top speed",
    unit: "units/s",
    note: "Speed is clamped to this once friction and acceleration settle.",
  },
  {
    field: "frictionPermille",
    label: "Friction",
    unit: "permille",
    note: "Share of velocity kept each tick. 1000 keeps all of it.",
  },
  {
    field: "bounds",
    label: "Bounds",
    unit: "units",
    note: "The body bounces at this distance from the origin on both axes.",
  },
];

const ScenarioEditor: FC<ScenarioEditorProps> = ({
  scenario,
  readOnly,
  problems,
  onChange,
}) => {
  const setSpec = (field: keyof ScenarioSpec, value: number) => {
    onChange({ ...scenario, spec: { ...scenario.spec, [field]: value } });
  };

  return (
    <section className="panel" aria-labelledby="scenario-editor-heading">
      <div className="panel-head">
        <h2 id="scenario-editor-heading">Scenario</h2>
        {readOnly ? (
          <span className="muted" data-testid="read-only">
            Built in, duplicate it to edit
          </span>
        ) : null}
      </div>

      <div className="sweep-fields">
        <div className="field">
          <label htmlFor="scenario-name">Name</label>
          <input
            id="scenario-name"
            type="text"
            value={scenario.name}
            disabled={readOnly}
            onChange={(e) => onChange({ ...scenario, name: e.target.value })}
          />
          <span className="field-note">How it reads in the picker on every route.</span>
        </div>

        {FIELDS.map(({ field, label, unit, note }) => (
          <div className="field" key={field}>
            <label htmlFor={`scenario-${field}`}>
              {label} <span className="muted">({unit})</span>
            </label>
            <input
              id={`scenario-${field}`}
              type="number"
              value={scenario.spec[field]}
              min={LIMITS[field].min}
              max={LIMITS[field].max}
              disabled={readOnly}
              onChange={(e) => setSpec(field, Math.trunc(Number(e.target.value)))}
            />
            <span className="field-note">{note}</span>
          </div>
        ))}
      </div>

      {/* a scenario that does not validate never reaches the core, so the reason is
          stated in terms of the field the user typed rather than a buffer index */}
      {problems.length > 0 ? (
        <ul className="problems" data-testid="scenario-problems" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};

export default ScenarioEditor;
