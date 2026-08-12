import { useCallback, useEffect, useRef, useState, type FC } from "react";
import ConditionControls from "./condition-controls";
import ConfigStrip from "./config-strip";
import ReplayView from "./replay-view";
import TransportControls from "./transport-controls";
import { COLOURS, VIEWS } from "../replay/draw";
import {
  advance,
  atEnd,
  seek,
  START,
  stepBack,
  stepForward,
  type Cursor,
} from "../replay/playback";
import type { SimPool } from "../workers/pool";
import type {
  CustomSegmentSpec,
  Frame,
  InputEventSpec,
  NetcodeConfig,
  ScenarioSpec,
} from "../sim/types";

interface ReplayTheatreProps {
  pool: () => SimPool;
  config: NetcodeConfig;
  scenario: ScenarioSpec;
  script: readonly InputEventSpec[];
}

/** A link with enough latency and loss that the techniques have visible work to do. */
const DEFAULT_SEGMENT: CustomSegmentSpec = {
  rttMeanMs: 120,
  rttJitterMs: 30,
  lossPct: 3,
  reorderPct: 1,
  duplicatePct: 0,
  burstLoss: true,
};

const TRAIL_TICKS = 24;

/**
 * The replay theatre.
 *
 * Owns the playback clock and the captured frames. One cursor drives all three views,
 * because three independent cursors would drift and the panels would stop being
 * comparable.
 *
 * The simulation runs once per configuration change and is then scrubbed. Re-running
 * per frame would make playback a function of how fast the machine is.
 */
const ReplayTheatre: FC<ReplayTheatreProps> = ({ pool, config, scenario, script }) => {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [cursor, setCursor] = useState<Cursor>(START);
  const [playing, setPlaying] = useState(true);
  const [segment, setSegment] = useState<CustomSegmentSpec>(DEFAULT_SEGMENT);
  const [seed, setSeed] = useState("42");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // read inside the animation frame callback and the transport handlers, which capture
  // their scope once. reading the state directly there would pin the first value
  // forever, which is the stale closure this component would otherwise be full of
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  /** Keeps the ref and the state in step, so no handler ever reads a stale cursor. */
  const moveTo = useCallback((next: Cursor) => {
    cursorRef.current = next;
    setCursor(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const parsed = BigInt(/^\d+$/.test(seed) ? seed : "0");

    setLoading(true);
    pool()
      .runFrames(scenario, segment, parsed, config, script)
      .then((next) => {
        if (cancelled) return;
        setFrames(next);
        // the cursor is held rather than reset, so changing a condition shows the same
        // moment under the new conditions. resetting to tick zero would land on the
        // opening frame where nothing has diverged yet, and the control would read as
        // having done nothing
        moveTo(seek(cursorRef.current.tick, next.length));
        setError("");
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pool, config, segment, seed, moveTo, scenario, script]);

  // the loop is keyed on the frame count as well as on playing, because on the first
  // mount there are no frames yet. without the restart it would start, find nothing to
  // play, stop, and never run again once the run landed
  const frameCount = frames.length;

  // playback runs at the scenario's own rate, so an authored scenario at 128 Hz plays
  // in the same wall-clock time a 64 Hz one does rather than at half speed
  const tickRate = scenario.tickRate;

  useEffect(() => {
    if (!playing || frameCount === 0) return;
    let raf = 0;
    let previous = performance.now();

    const tick = (now: number) => {
      const elapsed = now - previous;
      previous = now;

      const count = framesRef.current.length;
      const next = advance(cursorRef.current, elapsed, tickRate, count);
      moveTo(next);

      // stop at the end rather than looping, so a finished run reads as finished.
      // decided out here rather than inside a state updater, because an updater that
      // sets other state is a side effect in what has to be a pure function and React
      // is free to call it more than once
      if (atEnd(next, count)) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frameCount, moveTo, tickRate]);

  const onPlayPause = useCallback(() => {
    if (playingRef.current) {
      setPlaying(false);
      return;
    }
    // pressing play at the end restarts, since resuming a finished run does nothing
    if (atEnd(cursorRef.current, framesRef.current.length)) moveTo(START);
    setPlaying(true);
  }, [moveTo]);

  const onSeek = useCallback(
    (tick: number) => {
      setPlaying(false);
      moveTo(seek(tick, framesRef.current.length));
    },
    [moveTo],
  );

  const onStepForward = useCallback(() => {
    setPlaying(false);
    moveTo(stepForward(cursorRef.current, framesRef.current.length));
  }, [moveTo]);

  const onStepBack = useCallback(() => {
    setPlaying(false);
    moveTo(stepBack(cursorRef.current));
  }, [moveTo]);

  const frame = frames[Math.min(cursor.tick, Math.max(0, frames.length - 1))];
  const owner = frame?.clients[0];

  /**
   * A distance in world units.
   *
   * Small values keep a significant digit instead of rounding to "0.00", which would
   * report a correction of nothing on a tick that corrected.
   */
  const units = (value: number): string =>
    `${value >= 0.01 || value === 0 ? value.toFixed(2) : value.toExponential(1)} units`;

  return (
    <section className="theatre" data-testid="theatre">
      <div className="views">
        {VIEWS.map((view) => (
          <ReplayView
            key={view.glyph}
            frames={frames}
            cursor={cursor}
            view={view}
            trailTicks={TRAIL_TICKS}
          />
        ))}
      </div>

      {error ? (
        <p className="state error" role="alert" data-testid="replay-error">
          {error}
        </p>
      ) : null}

      <ul className="legend" data-testid="legend">
        <li>
          <span className="swatch ring" /> Server state this client had received
        </li>
        <li>
          <span className="swatch" style={{ background: COLOURS.correction }} /> Correction, drawn
          from where it jumped
        </li>
        <li>
          <span className="swatch" style={{ background: COLOURS.rollback }} /> Rollback, labelled
          with its depth
        </li>
        <li>
          <span className="swatch" style={{ background: COLOURS.rewind }} /> Rewind target on the
          server view
        </li>
      </ul>

      <TransportControls
        cursor={cursor}
        frameCount={frames.length}
        tickRate={tickRate}
        playing={playing}
        seed={seed}
        disabled={loading || frames.length === 0}
        onPlayPause={onPlayPause}
        onStepBack={onStepBack}
        onStepForward={onStepForward}
        onSeek={onSeek}
        onSeedChange={setSeed}
      />

      <dl className="frame-readout" data-testid="frame-readout">
        <div>
          <dt>Correction</dt>
          <dd>{owner ? units(owner.correctionMagnitude) : "-"}</dd>
        </div>
        <div>
          <dt>Rollback depth</dt>
          <dd>{owner ? `${owner.rollbackDepth} ticks` : "-"}</dd>
        </div>
        <div>
          <dt>Client A behind server</dt>
          <dd>
            {frame && owner
              ? units(Math.hypot(frame.server.x - owner.position.x, frame.server.y - owner.position.y))
              : "-"}
          </dd>
        </div>
      </dl>

      <ConditionControls segment={segment} disabled={loading} onChange={setSegment} />
      <ConfigStrip config={config} firesShots={script.some((e) => e.action === "fire")} />
    </section>
  );
};

export default ReplayTheatre;
