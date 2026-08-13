import type { FC } from "react";
import Icon from "./icon";
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
    <div className="transport">
      <div className="transport-buttons">
        <button type="button" onClick={onPlayPause} disabled={disabled} data-testid="play">
          <Icon name={playing ? "pause" : "play"} />
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onStepBack}
          disabled={disabled || cursor.tick <= 0}
          data-testid="step-back"
        >
          <Icon name="step-back" />
          Step back
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onStepForward}
          disabled={disabled || cursor.tick >= last}
          data-testid="step-forward"
        >
          <Icon name="step-forward" />
          Step forward
        </button>
      </div>

      <label className="scrub">
        <span className="sr-only">Timeline</span>
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={cursor.tick}
          disabled={disabled}
          data-testid="scrub"
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </label>

      <output className="transport-readout" data-testid="tick-readout">
        tick {cursor.tick} of {last}
        <span className="muted"> · {seconds}s</span>
      </output>

      <label className="seed-field">
        Seed
        <input
          type="number"
          min={0}
          value={seed}
          disabled={disabled}
          data-testid="seed"
          onChange={(event) => onSeedChange(event.target.value)}
        />
      </label>
    </div>
  );
};

export default TransportControls;
