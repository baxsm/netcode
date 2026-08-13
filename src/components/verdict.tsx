import type { FC } from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface VerdictProps {
  passed: boolean;
  children: string;
  /** Only the panel-level verdicts are addressed by tests, so most sites pass nothing. */
  testId?: string;
  /** `lg` is for the one verdict that answers a whole panel. */
  size?: "sm" | "lg";
  className?: string;
}

/**
 * A pass or fail, wherever one is shown.
 *
 * The word carries the result and the colour reinforces it, never the reverse, so the
 * glyph is a third channel rather than the only one: a reader who cannot separate the
 * green from the red still has the tick against the cross, and both against the text.
 */
const Verdict: FC<VerdictProps> = ({
  passed,
  children,
  testId,
  size = "sm",
  className,
}) => {
  const Glyph = passed ? Check : X;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium whitespace-nowrap",
        size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs",
        passed
          ? "border-pass/30 bg-pass/10 text-pass"
          : "border-destructive/30 bg-destructive/10 text-destructive",
        className,
      )}
      data-testid={testId}
    >
      <Glyph className={size === "lg" ? "size-4" : "size-3"} aria-hidden />
      {children}
    </span>
  );
};

export default Verdict;
