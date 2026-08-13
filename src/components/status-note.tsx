import type { FC, ReactNode } from "react";
import { Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "info" | "busy" | "error";

interface StatusNoteProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  /** Passed through so a spec can wait on a specific message. */
  "data-testid"?: string;
}

const TONES: Record<Tone, { box: string; icon: string; role?: "alert" | "status" }> = {
  info: { box: "border-border bg-card text-muted-foreground", icon: "text-muted-foreground" },
  busy: {
    box: "border-border bg-card text-muted-foreground",
    icon: "text-primary",
    role: "status",
  },
  error: {
    box: "border-destructive/40 bg-destructive/10 text-destructive",
    icon: "text-destructive",
    role: "alert",
  },
};

/**
 * One treatment for every "nothing yet", "working" and "that failed" message.
 *
 * These were previously bare paragraphs whose only difference was a class name, so an
 * error and an empty state read at the same weight. Distinguishing them is the point:
 * an empty list and a list that failed to load are not the same thing, and a reader
 * who cannot tell them apart assumes there is no data.
 */
const StatusNote: FC<StatusNoteProps> = ({
  tone = "info",
  children,
  className,
  "data-testid": testId,
}) => {
  const { box, icon, role } = TONES[tone];
  const Glyph = tone === "error" ? TriangleAlert : tone === "busy" ? LoaderCircle : Info;

  return (
    <p
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        box,
        className,
      )}
      role={role}
      data-testid={testId}
    >
      <Glyph
        className={cn("size-4 shrink-0", icon, tone === "busy" && "animate-spin")}
        aria-hidden
      />
      {children}
    </p>
  );
};

export default StatusNote;
