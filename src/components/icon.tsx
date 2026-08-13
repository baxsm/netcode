import type { FC } from "react";

/**
 * The interface's icons, drawn here rather than pulled from a set.
 *
 * This many glyphs is well under the point where a library pays for itself, and drawing
 * them here keeps them on one geometry: a 16 unit box, a 1.6 stroke where they are
 * stroked, round caps and joins. A set picked off the shelf would bring its own metrics
 * and the transport row would stop looking like one control.
 *
 * Every glyph inherits `currentColor`, so a button's hover and disabled colours reach
 * the icon without the icon knowing about them.
 */

export type IconName =
  | "play"
  | "pause"
  | "step-back"
  | "step-forward"
  | "check"
  | "cross"
  | "download"
  | "upload"
  | "copy"
  | "external"
  | "run";

/**
 * The paths, in a 16 unit box.
 *
 * `play` and the two step glyphs are filled triangles; everything else is stroked. The
 * two are kept apart by `filled` rather than by drawing strokes around triangles, which
 * at this size renders as a blob.
 */
const PATHS: Record<IconName, { d: string; filled?: boolean }> = {
  play: { d: "M5 3.2 13 8l-8 4.8Z", filled: true },
  pause: { d: "M5.5 3.5v9M10.5 3.5v9" },
  // the bar is the tick the step lands on, so the glyph reads as direction rather than
  // as a second play button. drawn as a rectangle rather than a stroked line because
  // these paths are filled, and a filled path ignores stroke width
  "step-back": { d: "M3.6 3.5h1.5v9H3.6ZM12.4 3.6 6.4 8l6 4.4Z", filled: true },
  "step-forward": { d: "M10.9 3.5h1.5v9h-1.5ZM3.6 3.6 9.6 8l-6 4.4Z", filled: true },
  check: { d: "M3 8.5l3.2 3.2L13 5" },
  cross: { d: "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" },
  download: { d: "M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7M3 12.8h10" },
  upload: { d: "M8 10.2V2.7M4.8 5.9 8 2.7l3.2 3.2M3 12.8h10" },
  copy: { d: "M5.5 5.5h7v7h-7zM10.5 5.5v-2h-7v7h2" },
  external: { d: "M9 3.2h3.8V7M12.4 3.6 7.2 8.8M11 9.4v3.4H3.2V5h3.4" },
  run: { d: "M8 3.2a4.8 4.8 0 1 1-3.4 1.4M4.6 2.4v2.6h2.6" },
};

interface IconProps {
  name: IconName;
  /** Matched to the text it sits beside, in em, so it scales with the button. */
  size?: string;
  className?: string | undefined;
}

/**
 * Decorative by default.
 *
 * Every icon in this app sits beside its own label, or inside a button that carries an
 * accessible name of its own, so announcing the glyph as well would read the control
 * twice.
 */
const Icon: FC<IconProps> = ({ name, size = "1em", className }) => {
  const path = PATHS[name];
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={path.filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={path.filled ? 0 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path.d} />
    </svg>
  );
};

export default Icon;
