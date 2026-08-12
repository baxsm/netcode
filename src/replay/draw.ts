/**
 * Canvas drawing for the three replay views.
 *
 * Pure in the sense that matters: it reads frames and writes pixels, and never
 * advances or mutates simulation state. Every position it draws came out of the core.
 *
 * The world is drawn letterboxed at a fixed aspect ratio. Stretching to fit the panel
 * would misrepresent distance, and distance error is the quantity this whole screen
 * exists to show.
 */

import type { ClientFrame, Frame, Point } from "../sim/types";
import { flashAt, lerp, type Cursor } from "./playback";

/**
 * Reserved so a flash is unambiguous. A correction is the only red on screen and a
 * rollback the only violet, which is what lets a glance identify an event without a
 * legend lookup.
 */
export const COLOURS = {
  server: "#8b949e",
  clientA: "#58a6ff",
  clientB: "#3fb950",
  correction: "#f85149",
  rollback: "#bc8cff",
  rewind: "#f0883e",
  grid: "#1c2430",
  ghost: "#8b949e",
} as const;

/** How long an event stays visible, in ticks. See `flashAt`. */
export const FLASH_HOLD_TICKS = 10;

/**
 * World units across the visible area. The scenario runs along x from zero.
 *
 * Sized to the quantity being shown rather than to the world. Divergence between a
 * client and the server runs to a few units, so a viewport wide enough to hold the
 * whole run would render that gap sub-pixel and the screen would show three identical
 * dots. At this width a one unit error is clearly visible, which is the point.
 */
export const VIEW_WIDTH = 32;

/**
 * Shorter than the panel would otherwise be, because the scenario moves along x only.
 * A square-ish view spends most of its height on empty space above and below a body
 * that never leaves the centre line.
 */
export const VIEW_HEIGHT = 12;

export interface View {
  title: string;
  /** Absent for the server view, which has no client of its own. */
  clientIndex: number | null;
  colour: string;
  /** Drawn alongside the colour, so identity survives greyscale and colour blindness. */
  glyph: string;
}

export const VIEWS: View[] = [
  { title: "Server truth", clientIndex: null, colour: COLOURS.server, glyph: "S" },
  { title: "Client A", clientIndex: 0, colour: COLOURS.clientA, glyph: "A" },
  { title: "Client B", clientIndex: 1, colour: COLOURS.clientB, glyph: "B" },
];

export interface Layout {
  /** Pixels per world unit. */
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/**
 * Fits the world into the canvas without distorting it.
 *
 * The smaller of the two ratios wins, so the world always fits whole and the leftover
 * space becomes letterbox rather than stretch.
 */
export function layoutFor(width: number, height: number): Layout {
  const scale = Math.min(width / VIEW_WIDTH, height / VIEW_HEIGHT);
  return {
    scale,
    offsetX: (width - VIEW_WIDTH * scale) / 2,
    offsetY: (height - VIEW_HEIGHT * scale) / 2,
    width,
    height,
  };
}

/**
 * World to canvas.
 *
 * The camera follows the body along x, because the scenario runs in a straight line
 * far past the visible width and a fixed camera would leave the body off screen for
 * most of the run. Y is centred, since the scenario does not move vertically.
 */
function project(p: Point, layout: Layout, cameraX: number): Point {
  return {
    x: layout.offsetX + (p.x - cameraX + VIEW_WIDTH / 2) * layout.scale,
    y: layout.offsetY + (VIEW_HEIGHT / 2 - p.y) * layout.scale,
  };
}

/**
 * Sizes the backing store to the device pixel ratio.
 *
 * Without this the canvas is soft on every high-DPI display, and since this screen is
 * the project's first screenshot, soft here means soft everywhere. Returns the CSS
 * size, which is what the drawing code works in.
 */
export function resize(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  dpr: number,
): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const backingWidth = Math.round(width * dpr);
  const backingHeight = Math.round(height * dpr);

  // reassigning width or height clears the canvas, so only touch it on a real change
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height };
}

function drawGrid(ctx: CanvasRenderingContext2D, layout: Layout, cameraX: number): void {
  // without a reference, smooth motion and stuttering motion look identical, because
  // there is nothing on screen for the body to move relative to
  const spacing = 4;
  const top = layout.offsetY;
  const bottom = layout.offsetY + VIEW_HEIGHT * layout.scale;
  ctx.strokeStyle = COLOURS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();

  const first = Math.floor((cameraX - VIEW_WIDTH / 2) / spacing) * spacing;
  for (let x = first; x < cameraX + VIEW_WIDTH / 2 + spacing; x += spacing) {
    const at = Math.round(project({ x, y: 0 }, layout, cameraX).x) + 0.5;
    ctx.moveTo(at, top);
    ctx.lineTo(at, bottom);
  }
  for (let y = -VIEW_HEIGHT; y <= VIEW_HEIGHT; y += spacing) {
    const at = Math.round(project({ x: cameraX, y }, layout, cameraX).y) + 0.5;
    if (at < top || at > bottom) continue;
    ctx.moveTo(layout.offsetX, at);
    ctx.lineTo(layout.offsetX + VIEW_WIDTH * layout.scale, at);
  }
  ctx.stroke();
}

/**
 * A short fading trail behind the body.
 *
 * Interpolated and extrapolated motion look alike in a single frame and differ in how
 * they move, so the trail is what makes the difference legible without stepping.
 */
function drawTrail(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  cameraX: number,
  points: Point[],
  colour: string,
): void {
  if (points.length < 2) return;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (let i = 1; i < points.length; i += 1) {
    const from = project(points[i - 1] as Point, layout, cameraX);
    const to = project(points[i] as Point, layout, cameraX);
    ctx.globalAlpha = (i / points.length) * 0.5;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawBody(
  ctx: CanvasRenderingContext2D,
  at: Point,
  colour: string,
  glyph: string,
  radius: number,
): void {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  ctx.fill();

  // the label rides the body so identity never depends on colour alone
  ctx.fillStyle = "#04101f";
  ctx.font = `600 ${Math.round(radius * 1.1)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, at.x, at.y + 0.5);
}

/** The authoritative position behind the predicted one, hollow so it reads as a ghost. */
function drawGhost(ctx: CanvasRenderingContext2D, at: Point, colour: string, radius: number): void {
  ctx.strokeStyle = colour;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/**
 * The line between where the client is and where the server says it should be.
 *
 * The gap is the measured quantity, so it is drawn as a span rather than left for the
 * eye to estimate between two circles.
 */
function drawGap(ctx: CanvasRenderingContext2D, from: Point, to: Point, colour: string): void {
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  if (span < 2) return;
  ctx.strokeStyle = colour;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export interface DrawOptions {
  frames: readonly Frame[];
  cursor: Cursor;
  view: View;
  /** CSS pixel size of the canvas. */
  width: number;
  height: number;
  /** Trail length in ticks. Zero disables it. */
  trailTicks: number;
}

/**
 * Draws one view for the current cursor position.
 *
 * Everything drawn is read from the captured frames. The only value computed here is
 * the display interpolation between two frames, which never leaves this function.
 */
export function drawView(ctx: CanvasRenderingContext2D, options: DrawOptions): void {
  const { frames, cursor, view, width, height, trailTicks } = options;
  const layout = layoutFor(width, height);

  ctx.clearRect(0, 0, width, height);

  const index = Math.min(Math.max(cursor.tick, 0), frames.length - 1);
  const frame = frames[index];
  if (!frame) return;
  const next = frames[index + 1] ?? frame;
  const t = next === frame ? 0 : cursor.fraction;

  const clientIndex = view.clientIndex;
  const bodyOf = (f: Frame): Point =>
    clientIndex === null ? f.server : (f.clients[clientIndex]?.position ?? f.server);

  const at = lerp(bodyOf(frame), bodyOf(next), t);
  const cameraX = at.x;

  drawGrid(ctx, layout, cameraX);

  // large enough that the glyph inside it is readable, which is what carries identity
  // when colour is unavailable
  const radius = Math.max(9, layout.scale * 0.9);

  if (trailTicks > 0) {
    const from = Math.max(0, index - trailTicks);
    const trail: Point[] = [];
    for (let i = from; i <= index; i += 1) {
      const f = frames[i];
      if (f) trail.push(bodyOf(f));
    }
    drawTrail(ctx, layout, cameraX, trail, view.colour);
  }

  const client: ClientFrame | undefined =
    clientIndex === null ? undefined : frame.clients[clientIndex];

  // the ghost is the authoritative state this client had actually received, drawn at
  // the tick it arrived from. drawing it from the current tick instead would look
  // plausible and show a position the client did not have
  if (client?.ghost) {
    const ghostAt = project(client.ghost, layout, cameraX);
    drawGap(ctx, project(at, layout, cameraX), ghostAt, COLOURS.ghost);
    drawGhost(ctx, ghostAt, COLOURS.ghost, radius);
  }

  // the correction, drawn as the jump it made. the magnitude is the point, so the line
  // is held for several ticks rather than the single frame it occurred on
  if (clientIndex !== null) {
    const strength = flashAt(
      frames,
      index,
      clientIndex,
      (c) => c.correctionMagnitude > 0,
      FLASH_HOLD_TICKS,
    );
    if (strength > 0) {
      const source = frames
        .slice(Math.max(0, index - FLASH_HOLD_TICKS), index + 1)
        .reverse()
        .find((f) => (f.clients[clientIndex]?.correctionMagnitude ?? 0) > 0);
      const corrected = source?.clients[clientIndex];
      const before = corrected?.preCorrection;
      if (before && corrected) {
        const a = project(before, layout, cameraX);
        const b = project(at, layout, cameraX);
        ctx.globalAlpha = strength;
        ctx.strokeStyle = COLOURS.correction;
        ctx.lineWidth = 2;

        // a single tick's correction is often a fraction of a unit, which at this scale
        // is a marker sitting on top of the body saying nothing. the magnitude is the
        // point, so below a separable distance it is stated as a number instead of
        // drawn as a line too short to read
        if (Math.hypot(b.x - a.x, b.y - a.y) >= radius) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          drawGhost(ctx, a, COLOURS.correction, radius * 0.7);
        } else {
          // enough precision that the number is never printed as zero. a label reading
          // "correction 0.00" states that nothing happened while flagging that
          // something did, which is worse than drawing nothing
          const magnitude = corrected.correctionMagnitude;
          const shown = magnitude >= 0.01 ? magnitude.toFixed(2) : magnitude.toExponential(1);
          ctx.fillStyle = COLOURS.correction;
          ctx.font = "600 11px ui-monospace, monospace";
          ctx.textAlign = "right";
          ctx.textBaseline = "top";
          ctx.fillText(
            `correction ${shown}`,
            layout.offsetX + VIEW_WIDTH * layout.scale - 8,
            layout.offsetY + 8,
          );
        }
        ctx.globalAlpha = 1;
      }
    }

    // a rollback resimulates history rather than moving the body somewhere visible, so
    // it is labelled with its depth. a bare border flash would be indistinguishable
    // from a selection highlight and would not say how far back it went
    const rolled = flashAt(frames, index, clientIndex, (c) => c.rollbackDepth > 0, FLASH_HOLD_TICKS);
    if (rolled > 0 && client) {
      const depth =
        client.rollbackDepth > 0
          ? client.rollbackDepth
          : (frames
              .slice(Math.max(0, index - FLASH_HOLD_TICKS), index + 1)
              .reverse()
              .find((f) => (f.clients[clientIndex]?.rollbackDepth ?? 0) > 0)?.clients[clientIndex]
              ?.rollbackDepth ?? 0);

      ctx.globalAlpha = rolled;
      ctx.fillStyle = COLOURS.rollback;
      ctx.font = "600 11px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(`rollback ${depth}`, layout.offsetX + 8, layout.offsetY + 8);
      ctx.globalAlpha = 1;
    }
  }

  // the rewind target sits on the server view, because rewinding is what the server
  // did rather than something a client saw
  if (clientIndex === null && frame.rewindTarget != null) {
    const target = frames[frame.rewindTarget];
    if (target) {
      const to = project(target.server, layout, cameraX);
      ctx.strokeStyle = COLOURS.rewind;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(to.x, to.y, radius * 1.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawBody(ctx, project(at, layout, cameraX), view.colour, view.glyph, radius);
}
