import type { FC } from "react";
import {
  ALL_TECHNIQUES,
  NO_TECHNIQUES,
  TECHNIQUE_FIELDS,
  TECHNIQUE_LABELS,
  type NetcodeConfig,
  type TechniqueField,
} from "../sim/types";

interface TechniqueControlsProps {
  config: NetcodeConfig;
  disabled: boolean;
  onChange: (config: NetcodeConfig) => void;
  onRun: () => void;
}

/** Which constant belongs to which technique, so a knob with no effect is dimmed. */
const REQUIRES: Record<string, TechniqueField> = {
  interpolationDelayTicks: "entityInterpolation",
  rollbackWindowTicks: "rollback",
  correctionBlendPermille: "serverReconciliation",
  snapThresholdPermille: "serverReconciliation",
  serverRewindLimitMs: "serverRewind",
  extrapolationLimitTicks: "extrapolation",
};

interface Knob {
  key: keyof Omit<NetcodeConfig, "techniques">;
  label: string;
  min: number;
  max: number;
  step: number;
  /** How the stored integer reads to a person. */
  format: (value: number) => string;
}

const KNOBS: Knob[] = [
  {
    key: "interpolationDelayTicks",
    label: "Interpolation delay",
    min: 0,
    max: 16,
    step: 1,
    format: (v) => `${v} ticks`,
  },
  {
    key: "inputBufferTicks",
    label: "Input buffer",
    min: 0,
    max: 16,
    step: 1,
    format: (v) => `${v} ticks`,
  },
  {
    key: "rollbackWindowTicks",
    label: "Rollback window",
    min: 0,
    max: 32,
    step: 1,
    format: (v) => `${v} ticks`,
  },
  {
    key: "correctionBlendPermille",
    label: "Correction blend",
    min: 0,
    max: 990,
    step: 10,
    // stored as permille to keep decimals out of the fixed-point core
    format: (v) => `${(v / 1000).toFixed(2)} kept per tick`,
  },
  {
    key: "snapThresholdPermille",
    label: "Snap threshold",
    min: 1000,
    max: 200_000,
    step: 1000,
    format: (v) => `${(v / 1000).toFixed(0)} units`,
  },
  {
    key: "serverRewindLimitMs",
    label: "Server rewind limit",
    min: 0,
    max: 500,
    step: 10,
    format: (v) => `${v} ms`,
  },
  {
    key: "extrapolationLimitTicks",
    label: "Extrapolation limit",
    min: 0,
    max: 32,
    step: 1,
    format: (v) => `${v} ticks`,
  },
];

const TechniqueControls: FC<TechniqueControlsProps> = ({
  config,
  disabled,
  onChange,
  onRun,
}) => {
  const toggle = (field: TechniqueField) => {
    onChange({
      ...config,
      techniques: { ...config.techniques, [field]: !config.techniques[field] },
    });
  };

  const setKnob = (key: Knob["key"], value: number) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <section className="panel" aria-labelledby="techniques-heading">
      <div className="panel-head">
        <h2 id="techniques-heading">Techniques</h2>
        <div className="panel-actions">
          <button
            type="button"
            className="ghost"
            disabled={disabled}
            onClick={() => onChange({ ...config, techniques: NO_TECHNIQUES })}
          >
            None
          </button>
          <button
            type="button"
            className="ghost"
            disabled={disabled}
            onClick={() => onChange({ ...config, techniques: ALL_TECHNIQUES })}
          >
            All
          </button>
        </div>
      </div>

      <ul className="toggles">
        {TECHNIQUE_FIELDS.map((field) => (
          <li key={field}>
            <label>
              <input
                type="checkbox"
                checked={config.techniques[field]}
                disabled={disabled}
                onChange={() => toggle(field)}
              />
              <span>{TECHNIQUE_LABELS[field]}</span>
            </label>
          </li>
        ))}
      </ul>

      <div className="knobs">
        {KNOBS.map(({ key, label, min, max, step, format }) => {
          const requires = REQUIRES[key];
          // a constant whose technique is off still runs, it just changes nothing,
          // so it is dimmed rather than hidden or silently ignored
          const inactive = requires ? !config.techniques[requires] : false;
          return (
            <div className={inactive ? "knob inactive" : "knob"} key={key}>
              <label htmlFor={key}>
                {label}
                <span className="knob-value">{format(config[key])}</span>
              </label>
              <input
                id={key}
                type="range"
                min={min}
                max={max}
                step={step}
                value={config[key]}
                disabled={disabled}
                onChange={(e) => setKnob(key, Number(e.target.value))}
                onKeyUp={(e) => {
                  if (e.key === "Enter") onRun();
                }}
              />
              {inactive ? (
                <span className="knob-note">
                  no effect while {TECHNIQUE_LABELS[requires as TechniqueField]} is off
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default TechniqueControls;
