import type { FC } from "react";
import { LoaderCircle, Play } from "lucide-react";
import Field from "./field";
import StatusNote from "./status-note";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SEGMENTS } from "../palette";
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
  <Card aria-labelledby="sweep-controls-heading">
    <CardHeader>
      <CardTitle id="sweep-controls-heading">What to search</CardTitle>
      <CardDescription>
        The scenario, the players it runs against, and how many seeds each point gets.
      </CardDescription>
    </CardHeader>

    <CardContent className="space-y-6">
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          id="sweep-scenario"
          label="Scenario"
          note={`${scenario.script.length} scripted ${
            scenario.script.length === 1 ? "input" : "inputs"
          }, run over the first ${sweepTicks} ticks.`}
        >
          <Select
            value={scenario.id}
            disabled={running}
            onValueChange={(v) => {
              if (typeof v === "string") onScenario(v);
            }}
          >
            <SelectTrigger id="sweep-scenario" className="w-full">
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
        </Field>

        <Field id="profile" label="Player population" note={profile.description}>
          <Select
            value={profile.id}
            disabled={running}
            onValueChange={(v) => {
              if (typeof v === "string") onProfile(v);
            }}
          >
            <SelectTrigger id="profile" className="w-full">
              <SelectValue>{() => profile.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {profiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          id="preset"
          label="Technique set"
          note="Which techniques are on. The sweep tunes the constants around them."
        >
          <Select
            value={presetLabel}
            disabled={running}
            onValueChange={(v) => {
              if (typeof v === "string") onPreset(v);
            }}
          >
            <SelectTrigger id="preset" className="w-full">
              <SelectValue>{() => presetLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TECHNIQUE_PRESETS.map((p) => (
                <SelectItem key={p.label} value={p.label}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          id="seeds"
          label="Seeds per configuration"
          note="More seeds narrow the noise floor and cost proportionally more runs."
        >
          <Select
            value={seedCount}
            disabled={running}
            onValueChange={(v) => {
              if (typeof v === "number") onSeedCount(v);
            }}
          >
            <SelectTrigger id="seeds" className="w-full">
              <SelectValue>
                {() =>
                  `${seedCount}${seedCount === DEFAULT_SEED_COUNT ? " (measured default)" : ""}`
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SEED_CHOICES.map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                  {n === DEFAULT_SEED_COUNT ? " (measured default)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Separator />

      {/**
       * The population, as a share of players per link.
       *
       * The bar is data, so it uses the segment palette rather than the interactive
       * accent. Previously it was drawn in the same colour as the run button.
       */}
      <ul className="space-y-1" data-testid="segment-list">
        {profile.segments.map((s, i) => (
          <li
            key={`${s.rttMeanMs}-${s.lossPct}-${i}`}
            className="relative flex items-center gap-3 overflow-hidden rounded-md px-2.5 py-1.5"
          >
            {/* the bar is a magnitude behind the row, so it stays quiet enough that
                the text on top is what is read first */}
            <span
              className="absolute inset-y-0 left-0 rounded-md opacity-[0.14]"
              style={{
                width: `${(s.weightPermille / 1000) * 100}%`,
                background: SEGMENTS[i % SEGMENTS.length],
              }}
              aria-hidden="true"
            />
            <span
              className="absolute inset-y-0 left-0 w-0.5 rounded-full"
              style={{ background: SEGMENTS[i % SEGMENTS.length] }}
              aria-hidden="true"
            />
            <span className="tabular relative w-10 shrink-0 text-right text-xs font-medium">
              {(s.weightPermille / 10).toFixed(0)}%
            </span>
            <span className="relative text-xs text-muted-foreground">
              {describeSegment(s)}
            </span>
          </li>
        ))}
      </ul>

      {/* the core renormalizes whatever it is given, so a profile that does not sum to
          a whole population still runs. it would just answer a different question than
          the one on screen, which is why this says so rather than silently correcting */}
      {weightsAreWhole(profile.segments) ? null : (
        <StatusNote tone="error">
          Segment weights total {(totalWeight(profile.segments) / 10).toFixed(0)}%
          rather than 100%. Results will be scaled to a whole population.
        </StatusNote>
      )}

      <Separator />

      <div className="flex flex-wrap items-center gap-3">
        {/* fixed width so the count beside it does not move when the label changes */}
        <Button
          onClick={onRun}
          disabled={running}
          data-testid="run-sweep"
          className="w-[8.5rem]"
        >
          {running ? (
            <LoaderCircle className="animate-spin" data-icon="inline-start" />
          ) : (
            <Play className="fill-current" data-icon="inline-start" />
          )}
          {running ? "Sweeping" : "Run sweep"}
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="sweep-size">
          <span className="tabular text-foreground">{plan.configs.length}</span>{" "}
          configurations,{" "}
          <span className="tabular text-foreground">
            {plan.runCount.toLocaleString()}
          </span>{" "}
          simulations
        </span>
      </div>
    </CardContent>

    {/* a bounded search must never read as full coverage */}
    <CardFooter>
      <p className="coverage text-xs leading-relaxed text-muted-foreground">
        This searches {plan.configs.length} points on a coarse grid over{" "}
        {plan.axes.map((a) => a.label.toLowerCase()).join(", ")}. It is a sample of the
        parameter space, not an exhaustive search of it.
        {plan.inert.length > 0 ? (
          <>
            {" "}
            {plan.inert.map((a) => a.label.toLowerCase()).join(" and ")} is held at its
            default because a predicting client draws its own simulation rather than
            the buffer that constant indexes into, so varying it would produce
            identical results under different labels.
          </>
        ) : null}
      </p>
    </CardFooter>
  </Card>
);

export default SweepControls;
