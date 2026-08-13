import type { FC } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import type { CustomSegmentSpec } from "../sim/types";

interface ConditionControlsProps {
  segment: CustomSegmentSpec;
  disabled: boolean;
  onChange: (segment: CustomSegmentSpec) => void;
}

interface Knob {
  field: "rttMeanMs" | "rttJitterMs" | "lossPct";
  label: string;
  max: number;
  unit: string;
}

const KNOBS: Knob[] = [
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
const ConditionControls: FC<ConditionControlsProps> = ({
  segment,
  disabled,
  onChange,
}) => (
  <div className="grid items-end gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
    {KNOBS.map(({ field, label, max, unit }) => (
      <div className="space-y-1.5" key={field}>
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={`condition-${field}`} className="text-[0.8125rem]">
            {label}
          </Label>
          {/* the number is what changes, so it carries the weight and the unit does
              not. tabular so dragging the slider does not shuffle the digits */}
          <span className="text-xs text-muted-foreground">
            <span className="tabular text-foreground">{segment[field]}</span> {unit}
          </span>
        </div>
        <Slider
          id={`condition-${field}`}
          min={0}
          max={max}
          step={1}
          value={[segment[field]]}
          disabled={disabled}
          aria-label={label}
          data-testid={`condition-${field}`}
          onValueChange={(value) => {
            const next = Array.isArray(value) ? value[0] : value;
            if (typeof next === "number") onChange({ ...segment, [field]: next });
          }}
        />
      </div>
    ))}

    <Label className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 transition-colors hover:bg-muted/50 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50 has-data-disabled:hover:bg-transparent">
      <Checkbox
        checked={segment.burstLoss}
        disabled={disabled}
        data-testid="condition-burst"
        onCheckedChange={(checked) =>
          onChange({ ...segment, burstLoss: checked === true })
        }
      />
      <span className="text-[0.8125rem]">Burst loss</span>
    </Label>
  </div>
);

export default ConditionControls;
