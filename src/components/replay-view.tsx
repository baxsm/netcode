import { useEffect, useRef, type FC } from "react";
import { CANVAS } from "../palette";
import { drawView, resize, VIEW_HEIGHT, VIEW_WIDTH, type View } from "../replay/draw";
import type { Cursor } from "../replay/playback";
import type { Frame } from "../sim/types";

interface ReplayViewProps {
  frames: readonly Frame[];
  cursor: Cursor;
  view: View;
  trailTicks: number;
}

/**
 * One canvas panel.
 *
 * Redraws on every cursor change rather than running its own loop. The parent owns the
 * clock, so all three panels are drawn from one cursor and cannot drift apart.
 */
const ReplayView: FC<ReplayViewProps> = ({ frames, cursor, view, trailTicks }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const paint = () => {
      const { width, height } = resize(canvas, ctx, window.devicePixelRatio || 1);
      drawView(ctx, { frames, cursor, view, width, height, trailTicks });
    };
    paint();

    // the panel is laid out by CSS, so its pixel size changes without React
    // re-rendering. observing it keeps the backing store correct on resize
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [frames, cursor, view, trailTicks]);

  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="flex items-center gap-2">
        <span
          className="flex size-5 items-center justify-center rounded font-mono text-[0.6875rem] font-semibold"
          style={{ background: view.colour, color: CANVAS.glyphInk }}
          aria-hidden="true"
        >
          {view.glyph}
        </span>
        <span className="text-[0.8125rem] font-medium">{view.title}</span>
      </figcaption>
      {/**
       * The aspect ratio has to come from CSS, not from the canvas attributes.
       *
       * A canvas with no CSS height falls back to sizing from its own backing store,
       * which `resize` sets from the observed box: the observer then reports a new
       * size, which resizes the backing store, which fires the observer again. That
       * loop is what "ResizeObserver loop completed with undelivered notifications"
       * means, and it fired on every frame until this was pinned.
       *
       * `sim-canvas` is what the reduced-motion rule spares: the simulation is the
       * content, so it keeps moving when the chrome stops. See styles.css.
       */}
      <canvas
        ref={canvasRef}
        className="sim-canvas block w-full rounded-lg border border-border bg-background"
        // taken from the world constants rather than written as a literal, so the box
        // and the projection inside it can never disagree about the shape
        style={{ aspectRatio: `${VIEW_WIDTH} / ${VIEW_HEIGHT}` }}
        data-testid={`view-${view.glyph}`}
        role="img"
        aria-label={`${view.title}, tick ${cursor.tick}`}
      />
    </figure>
  );
};

export default ReplayView;
