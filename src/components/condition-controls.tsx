import type { FC } from "react";
import type { CustomSegmentSpec } from "../sim/types";

interface ConditionControlsProps {
  segment: CustomSegmentSpec;
  disabled: boolean;
  onChange: (segment: CustomSegmentSpec) => void;
}

interface Slider {
  field: "rttMeanMs" | "rttJitterMs" | "lossPct";
  label: string;
  max: number;
  unit: string;
}

const SLIDERS: Slider[] = [
  { field: "rttMeanMs", label: "Round trip", max: 400, unit: "ms" },
  { field: "rttJitterMs", label: "Jitter", max: 150, unit: "ms" },
  { field: "lossPct", label: "Packet loss", max: 25, unit: "%" },
];

/**
 * Live network conditions.
 *
 * Every change re-runs the simulation from the same seed, so the difference on screen
 * is caused by the condition and not by a different sequence of random draws.
 */
const ConditionControls: FC<ConditionControlsProps> = ({ segment, disabled, onChange }) => (
  <div className="conditions">
    {SLIDERS.map(({ field, label, max, unit }) => (
      <div className="knob" key={field}>
        <label htmlFor={`condition-${field}`}>
          {label}
          <span className="knob-value">
            {segment[field]} {unit}
          </span>
        </label>
        <input
          id={`condition-${field}`}
          type="range"
          min={0}
          max={max}
          step={1}
          value={segment[field]}
          disabled={disabled}
          data-testid={`condition-${field}`}
          onChange={(event) => onChange({ ...segment, [field]: Number(event.target.value) })}
        />
      </div>
    ))}

    <label className="burst">
      <input
        type="checkbox"
        checked={segment.burstLoss}
        disabled={disabled}
        data-testid="condition-burst"
        onChange={(event) => onChange({ ...segment, burstLoss: event.target.checked })}
      />
      Burst loss
    </label>
  </div>
);

export default ConditionControls;
