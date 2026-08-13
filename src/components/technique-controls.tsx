import type { FC } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
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

  const activeCount = TECHNIQUE_FIELDS.filter((f) => config.techniques[f]).length;

  return (
    <Card aria-labelledby="techniques-heading">
      <CardHeader>
        <CardTitle id="techniques-heading">Techniques</CardTitle>
        <CardDescription>
          {activeCount} of {TECHNIQUE_FIELDS.length} on. The constants below tune the
          ones that are.
        </CardDescription>
        <CardAction>
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({ ...config, techniques: NO_TECHNIQUES })}
            >
              None
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({ ...config, techniques: ALL_TECHNIQUES })}
            >
              All
            </Button>
          </div>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5">
        {/**
         * Switches rather than checkboxes: these change the simulation that is running
         * in front of you, which is what a switch means. As checkboxes they were the
         * browser's own 1rem box tinted with one colour, identical on and off at a
         * glance.
         */}
        <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          {TECHNIQUE_FIELDS.map((field) => {
            const on = config.techniques[field];
            return (
              <li key={field}>
                <Label
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5",
                    "transition-colors hover:bg-muted/50",
                    "has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50 has-data-disabled:hover:bg-transparent",
                  )}
                >
                  <span
                    className={cn(
                      "text-[0.8125rem] transition-colors",
                      on ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {TECHNIQUE_LABELS[field]}
                  </span>
                  {/* named explicitly: the label wraps the switch, but Base UI points
                      `aria-labelledby` at its own generated node rather than at the
                      visible text, so without this the control has no accessible name */}
                  <Switch
                    checked={on}
                    disabled={disabled}
                    onCheckedChange={() => toggle(field)}
                    aria-label={TECHNIQUE_LABELS[field]}
                    data-testid={`technique-${field}`}
                  />
                </Label>
              </li>
            );
          })}
        </ul>

        <Separator />

        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {KNOBS.map(({ key, label, min, max, step, format }) => {
            const requires = REQUIRES[key];
            // a constant whose technique is off still runs, it just changes nothing,
            // so it is dimmed rather than hidden or silently ignored
            const inactive = requires ? !config.techniques[requires] : false;
            return (
              <div key={key} className={cn("space-y-1.5", inactive && "opacity-60")}>
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor={key} className="text-[0.8125rem]">
                    {label}
                  </Label>
                  <span className="tabular text-xs text-muted-foreground">
                    {format(config[key])}
                  </span>
                </div>
                <Slider
                  id={key}
                  min={min}
                  max={max}
                  step={step}
                  value={[config[key]]}
                  disabled={disabled}
                  aria-label={label}
                  onValueChange={(value) => {
                    const next = Array.isArray(value) ? value[0] : value;
                    if (typeof next === "number") setKnob(key, next);
                  }}
                  onKeyUp={(e) => {
                    if (e.key === "Enter") onRun();
                  }}
                />
                {inactive ? (
                  <p className="text-xs text-muted-foreground">
                    No effect while {TECHNIQUE_LABELS[requires as TechniqueField]} is
                    off.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};

export default TechniqueControls;
