import { useEffect, useRef, type FC } from "react";
import { drawView, resize, type View } from "../replay/draw";
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
    <figure className="view">
      <figcaption>
        <span className="view-glyph" style={{ background: view.colour }} aria-hidden="true">
          {view.glyph}
        </span>
        {view.title}
      </figcaption>
      <canvas
        ref={canvasRef}
        data-testid={`view-${view.glyph}`}
        role="img"
        aria-label={`${view.title}, tick ${cursor.tick}`}
      />
    </figure>
  );
};

export default ReplayView;
