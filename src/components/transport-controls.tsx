import type { FC } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tickToMs, type Cursor } from "../replay/playback";

interface TransportControlsProps {
  cursor: Cursor;
  frameCount: number;
  tickRate: number;
  playing: boolean;
  seed: string;
  disabled: boolean;
  onPlayPause: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onSeek: (tick: number) => void;
  onSeedChange: (seed: string) => void;
}

const TransportControls: FC<TransportControlsProps> = ({
  cursor,
  frameCount,
  tickRate,
  playing,
  seed,
  disabled,
  onPlayPause,
  onStepBack,
  onStepForward,
  onSeek,
  onSeedChange,
}) => {
  const last = Math.max(0, frameCount - 1);
  const seconds = (tickToMs(cursor.tick, tickRate) / 1000).toFixed(2);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        {/**
         * Fixed width, because the label swaps between "Play" and "Pause".
         *
         * Without it the button was 93px playing and 82px paused, and every toggle
         * shoved the two step buttons and the scrub bar sideways mid-playback. The
         * width is set once here rather than left to the longer of the two strings.
         */}
        <Button
          onClick={onPlayPause}
          disabled={disabled}
          data-testid="play"
          className="w-[5.75rem]"
        >
          {playing ? (
            <Pause className="fill-current" data-icon="inline-start" />
          ) : (
            <Play className="fill-current" data-icon="inline-start" />
          )}
          {playing ? "Pause" : "Play"}
        </Button>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                onClick={onStepBack}
                disabled={disabled || cursor.tick <= 0}
                data-testid="step-back"
                aria-label="Step back one tick"
              >
                <SkipBack />
              </Button>
            }
          />
          <TooltipContent>Step back one tick</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                onClick={onStepForward}
                disabled={disabled || cursor.tick >= last}
                data-testid="step-forward"
                aria-label="Step forward one tick"
              >
                <SkipForward />
              </Button>
            }
          />
          <TooltipContent>Step forward one tick</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-w-56 flex-1 items-center gap-3">
        <Slider
          min={0}
          // before the first run lands there are no frames, so `last` is 0 and a
          // zero-width range is not a range. held at 1 until there is something to
          // scrub, which is also when the control is still disabled
          max={Math.max(1, last)}
          step={1}
          value={[cursor.tick]}
          disabled={disabled}
          aria-label="Timeline"
          data-testid="scrub"
          onValueChange={(value) => {
            const next = Array.isArray(value) ? value[0] : value;
            if (typeof next === "number") onSeek(next);
          }}
          className="flex-1"
        />

        {/* tabular so the digits do not jitter as the tick counts up, and a fixed
            width so the seed field beside it never moves */}
        <output
          className="tabular w-[9.5rem] shrink-0 text-right text-xs text-muted-foreground"
          data-testid="tick-readout"
        >
          tick <span className="text-foreground">{cursor.tick}</span> of {last}
          {" · "}
          <span>{seconds}s</span>
        </output>
      </div>

      <div className="flex items-center gap-2">
        <Label htmlFor="seed" className="text-xs text-muted-foreground">
          Seed
        </Label>
        <Input
          id="seed"
          type="number"
          min={0}
          value={seed}
          disabled={disabled}
          data-testid="seed"
          onChange={(event) => onSeedChange(event.target.value)}
          className="tabular h-8 w-20"
        />
      </div>
    </div>
  );
};

export default TransportControls;
