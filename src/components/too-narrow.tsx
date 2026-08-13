import type { FC } from "react";
import { MonitorX } from "lucide-react";

/**
 * The message shown below tablet width.
 *
 * A deliberate choice rather than an omission. The product is three side-by-side
 * simulation views and dense numeric tables read at a workstation, and squeezing
 * those onto a phone would mean shipping a layout nobody could use while implying it
 * was supported. Saying so is more honest than degrading quietly.
 *
 * Rendered in the document rather than as a CSS-only overlay so the app below it is
 * not also mounted and running a simulation nobody can see.
 */
const TooNarrow: FC = () => (
  <div
    className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 px-6 text-center"
    data-testid="too-narrow"
  >
    <span className="text-sm font-semibold tracking-tight">netcode</span>
    <MonitorX className="size-8 text-muted-foreground/60" aria-hidden />
    <h1 className="font-heading text-xl font-semibold tracking-tight">
      This needs a wider window
    </h1>
    <p className="text-sm leading-relaxed text-muted-foreground">
      The replay puts the server and two clients side by side, and the sweep plots a
      front you pick points off. Both need room to be read. Open this at 700 pixels or
      wider.
    </p>
  </div>
);

export default TooNarrow;
