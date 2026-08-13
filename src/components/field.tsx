import type { FC, ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface FieldProps {
  /** Matches the `id` on the control inside, so the label points at it. */
  id: string;
  label: string;
  /** What the field means, or what changing it costs. */
  note?: string;
  children: ReactNode;
  className?: string;
}

/**
 * A labelled control with its explanation underneath.
 *
 * One component rather than the same three-element pattern written out at each call
 * site, which is how the app ended up with selects at two different heights and notes
 * at two different sizes.
 */
const Field: FC<FieldProps> = ({ id, label, note, children, className }) => (
  <div className={cn("space-y-1.5", className)}>
    <Label htmlFor={id} className="text-[0.8125rem]">
      {label}
    </Label>
    {children}
    {note ? (
      <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>
    ) : null}
  </div>
);

export default Field;
