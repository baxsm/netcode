import type { FC } from "react";
import { Check, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  TECHNIQUE_FIELDS,
  TECHNIQUE_LABELS,
  type NetcodeConfig,
  type TechniqueField,
} from "../sim/types";

interface ConfigStripProps {
  config: NetcodeConfig;
  /** True when the scenario fires, which is what makes the rewind limit act. */
  firesShots: boolean;
}

/**
 * The constants worth reading at a glance while watching the replay.
 *
 * A constant appears only where it can change what is on screen. Printing one next to
 * motion it cannot affect would imply it was part of the result, which is how the
 * input buffer went four phases carried, hashed and never read.
 *
 * The rewind limit is the case that varies: it only resolves shots, so it appears for
 * a scenario that fires and is left out of one that does not.
 */
const CONSTANTS: Array<{
  label: string;
  read: (c: NetcodeConfig) => string;
  needsShots?: boolean;
}> = [
  { label: "input buffer", read: (c) => `${c.inputBufferTicks} ticks` },
  { label: "blend", read: (c) => `${c.correctionBlendPermille / 10}%` },
  { label: "snap", read: (c) => `${(c.snapThresholdPermille / 1000).toFixed(1)} units` },
  { label: "interp delay", read: (c) => `${c.interpolationDelayTicks} ticks` },
  { label: "rewind limit", read: (c) => `${c.serverRewindLimitMs} ms`, needsShots: true },
];

/**
 * What is running, compact and always visible.
 *
 * A technique that is off is shown struck through rather than removed, so the strip
 * keeps a stable width and reads as a set with something missing rather than as a
 * shorter list.
 */
const ConfigStrip: FC<ConfigStripProps> = ({ config, firesShots }) => (
  <div
    className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-border bg-card px-3.5 py-3"
    data-testid="config-strip"
  >
    <ul className="flex flex-wrap items-center gap-1.5">
      {TECHNIQUE_FIELDS.map((field: TechniqueField) => {
        const on = config.techniques[field];
        return (
          <li key={field}>
            <Badge
              variant={on ? "secondary" : "outline"}
              className={cn(
                "gap-1.5 font-normal",
                on ? "text-foreground" : "text-muted-foreground/70",
              )}
            >
              {on ? (
                <Check className="size-3 text-pass" aria-hidden />
              ) : (
                <Minus className="size-3 opacity-60" aria-hidden />
              )}
              {TECHNIQUE_LABELS[field]}
              <span className="sr-only">{on ? " on" : " off"}</span>
            </Badge>
          </li>
        );
      })}
    </ul>

    <Separator orientation="vertical" className="hidden h-5 lg:block" />

    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {CONSTANTS.filter(({ needsShots }) => !needsShots || firesShots).map(
        ({ label, read }) => (
          <li key={label} className="text-xs text-muted-foreground">
            {label} <span className="tabular text-foreground">{read(config)}</span>
          </li>
        ),
      )}
    </ul>
  </div>
);

export default ConfigStrip;
