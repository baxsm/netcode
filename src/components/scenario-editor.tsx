import type { FC } from "react";
import { Lock, TriangleAlert } from "lucide-react";
import Field from "./field";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
    <Card aria-labelledby="scenario-editor-heading">
      <CardHeader>
        <CardTitle id="scenario-editor-heading">Scenario</CardTitle>
        <CardDescription>
          The body the core integrates, and how long it runs for.
        </CardDescription>
        {readOnly ? (
          <CardAction>
            <Badge
              variant="outline"
              className="font-normal text-muted-foreground"
              data-testid="read-only"
            >
              <Lock className="size-3" aria-hidden />
              Built in, duplicate it to edit
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            id="scenario-name"
            label="Name"
            note="How it reads in the picker on every route."
          >
            <Input
              id="scenario-name"
              type="text"
              value={scenario.name}
              disabled={readOnly}
              onChange={(e) => onChange({ ...scenario, name: e.target.value })}
            />
          </Field>

          {FIELDS.map(({ field, label, unit, note }) => (
            <Field
              key={field}
              id={`scenario-${field}`}
              label={`${label} (${unit})`}
              note={note}
            >
              <Input
                id={`scenario-${field}`}
                type="number"
                className="tabular"
                value={scenario.spec[field]}
                min={LIMITS[field].min}
                max={LIMITS[field].max}
                disabled={readOnly}
                onChange={(e) => setSpec(field, Math.trunc(Number(e.target.value)))}
              />
            </Field>
          ))}
        </div>

        {/* a scenario that does not validate never reaches the core, so the reason is
            stated in terms of the field the user typed rather than a buffer index */}
        {problems.length > 0 ? (
          <ul
            className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2"
            data-testid="scenario-problems"
            role="alert"
          >
            {problems.map((problem) => (
              <li
                key={problem}
                className="flex items-start gap-2 text-sm text-destructive"
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {problem}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
};

export default ScenarioEditor;
