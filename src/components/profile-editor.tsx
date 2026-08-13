import type { FC } from "react";
import { Lock, Plus, Trash2, TriangleAlert } from "lucide-react";
import Field from "./field";
import StatusNote from "./status-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SEGMENTS } from "../palette";
import type { WeightedSegment } from "../sim/types";
import { FULL_WEIGHT, totalWeight, weightsAreWhole, type NetworkProfile } from "../sweep/profiles";

interface ProfileEditorProps {
  profile: NetworkProfile;
  readOnly: boolean;
  problems: string[];
  onChange: (profile: NetworkProfile) => void;
}

/** The numeric conditions on a segment, each with the unit it is argued in. */
const CONDITIONS: Array<{
  field: keyof Omit<WeightedSegment, "burstLoss">;
  label: string;
  max: number;
}> = [
  { field: "weightPermille", label: "Share", max: 1000 },
  { field: "rttMeanMs", label: "RTT ms", max: 60_000 },
  { field: "rttJitterMs", label: "Jitter ms", max: 60_000 },
  { field: "lossPct", label: "Loss %", max: 100 },
  { field: "reorderPct", label: "Reorder %", max: 100 },
  { field: "duplicatePct", label: "Duplicate %", max: 100 },
];

/**
 * Distinguishable at a glance and reused per index, so a segment keeps its colour
 * between the bar and the rows below it. From the shared palette rather than a local
 * list, so the same segment reads the same colour on every screen that shows it.
 */
const SEGMENT_COLOURS = SEGMENTS;

function colourFor(index: number): string {
  return SEGMENT_COLOURS[index % SEGMENT_COLOURS.length] as string;
}

const EMPTY_SEGMENT: WeightedSegment = {
  weightPermille: 100,
  rttMeanMs: 60,
  rttJitterMs: 15,
  lossPct: 1,
  reorderPct: 0,
  duplicatePct: 0,
  burstLoss: false,
};

const ProfileEditor: FC<ProfileEditorProps> = ({ profile, readOnly, problems, onChange }) => {
  const total = totalWeight(profile.segments);
  const whole = weightsAreWhole(profile.segments);

  const setSegment = (index: number, patch: Partial<WeightedSegment>) => {
    onChange({
      ...profile,
      segments: profile.segments.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    });
  };

  return (
    <Card aria-labelledby="profile-editor-heading">
      <CardHeader>
        <CardTitle id="profile-editor-heading">Network profile</CardTitle>
        <CardDescription>
          The links your players are actually on, and what share of them is on each.
        </CardDescription>
        <CardAction>
          {readOnly ? (
            <Badge
              variant="outline"
              className="font-normal text-muted-foreground"
              data-testid="profile-read-only"
            >
              <Lock className="size-3" aria-hidden />
              Built in, duplicate it to edit
            </Badge>
          ) : (
            <Button
              variant="outline"
              size="sm"
              data-testid="add-segment"
              onClick={() =>
                onChange({ ...profile, segments: [...profile.segments, EMPTY_SEGMENT] })
              }
            >
              <Plus data-icon="inline-start" />
              Add segment
            </Button>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          <Field id="profile-name" label="Name">
            <Input
              id="profile-name"
              type="text"
              value={profile.name}
              disabled={readOnly}
              onChange={(e) => onChange({ ...profile, name: e.target.value })}
            />
          </Field>
          <Field
            id="profile-description"
            label="Description"
            note="Who these players are, in one line."
          >
            <Input
              id="profile-description"
              type="text"
              value={profile.description}
              disabled={readOnly}
              onChange={(e) => onChange({ ...profile, description: e.target.value })}
            />
          </Field>
        </div>

        {/* the population as one bar, because a distribution is the input that decides
            which configuration wins and a column of numbers does not show its shape */}
        {profile.segments.length > 0 ? (
          <div
            className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
            data-testid="segment-bar"
            role="img"
            aria-label={`Population split across ${profile.segments.length} segments, totalling ${(total / 10).toFixed(0)} percent`}
          >
            {profile.segments.map((segment, index) => (
              <span
                key={index}
                className="first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${(segment.weightPermille / Math.max(total, 1)) * 100}%`,
                  background: colourFor(index),
                }}
              />
            ))}
          </div>
        ) : null}

        {profile.segments.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="profile-empty">
            No segments. Add one to describe a group of players.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Segment</TableHead>
                  {CONDITIONS.map((condition) => (
                    <TableHead key={condition.field} className="text-right">
                      {condition.label}
                    </TableHead>
                  ))}
                  <TableHead className="text-center">Burst</TableHead>
                  {readOnly ? null : (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {profile.segments.map((segment, index) => (
                  <TableRow key={index} data-testid="segment-row">
                    <TableHead scope="row" className="font-normal whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: colourFor(index) }}
                          aria-hidden
                        />
                        Segment {index + 1}
                      </span>
                    </TableHead>
                    {CONDITIONS.map(({ field, label, max }) => (
                      <TableCell key={field} className="text-right">
                        <Input
                          type="number"
                          className="tabular h-7 w-20 text-right"
                          aria-label={`Segment ${index + 1} ${label}`}
                          value={segment[field]}
                          min={0}
                          max={max}
                          disabled={readOnly}
                          onChange={(e) =>
                            setSegment(index, {
                              [field]: Math.trunc(Number(e.target.value)),
                            })
                          }
                        />
                      </TableCell>
                    ))}
                    <TableCell className="text-center">
                      <Checkbox
                        aria-label={`Segment ${index + 1} burst loss`}
                        checked={segment.burstLoss}
                        disabled={readOnly}
                        onCheckedChange={(checked) =>
                          setSegment(index, { burstLoss: checked === true })
                        }
                      />
                    </TableCell>
                    {readOnly ? null : (
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Remove segment ${index + 1}`}
                                onClick={() =>
                                  onChange({
                                    ...profile,
                                    segments: profile.segments.filter(
                                      (_, i) => i !== index,
                                    ),
                                  })
                                }
                              >
                                <Trash2 />
                              </Button>
                            }
                          />
                          <TooltipContent>Remove this segment</TooltipContent>
                        </Tooltip>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* the core renormalizes whatever it is given, so a profile that does not sum
            to a whole population still runs. it would just answer a different question
            than the one on screen, which is why this says so rather than silently
            correcting */}
        {whole || profile.segments.length === 0 ? null : (
          <StatusNote tone="error" data-testid="weight-warning">
            Segment shares total {(total / 10).toFixed(1)}% rather than 100%. The run
            will scale them to a whole population, so the shares are treated as relative
            rather than as the numbers entered.
          </StatusNote>
        )}

        {problems.length > 0 ? (
          <ul
            className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2"
            data-testid="profile-problems"
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

        <p className="text-xs leading-relaxed text-muted-foreground">
          Shares are permille, so a whole population sums to {FULL_WEIGHT}. Burst loss
          replaces independent drops with a two-state model, where losses arrive in runs
          rather than spread evenly.
        </p>
      </CardContent>
    </Card>
  );
};

export default ProfileEditor;
