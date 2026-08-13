import type { FC } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Comparison } from "../workers/pool";
import { SEGMENT_PRESETS, type Metrics, type ScenarioSpec } from "../sim/types";

interface ComparisonTableProps {
  rows: Comparison[];
  scenario: ScenarioSpec;
  seed: bigint;
}

interface Column {
  label: string;
  /** Whether a smaller number is the better outcome, which fixes the arrow. */
  lowerIsBetter: boolean;
  read: (m: Metrics) => number;
  format: (value: number) => string;
  /**
   * Set when the value cannot differ between the two runs, so no change is shown.
   *
   * Transport latency is the same on both sides by construction: it is how long a
   * packet took to arrive, which the client's techniques cannot influence. Printing
   * "same" against it every time would read as a technique failing to help, when in
   * fact the column is context for the others rather than a result.
   */
  context?: boolean;
}

/**
 * Correction *count* is deliberately absent.
 *
 * Both runs receive the same packets on the same seed, so both record a correction
 * on the same ticks and the count is identical by construction. Showing it would
 * print "same" on every row and read as a technique that achieved nothing. What the
 * techniques actually change is how far the client had drifted when the correction
 * landed, which is the magnitude below.
 */
const COLUMNS: Column[] = [
  {
    label: "Divergence mean",
    lowerIsBetter: true,
    read: (m) => m.divergenceMean,
    format: (v) => v.toFixed(2),
  },
  {
    label: "Divergence p99",
    lowerIsBetter: true,
    read: (m) => m.divergenceP99,
    format: (v) => v.toFixed(2),
  },
  {
    label: "Worst rubber-band",
    lowerIsBetter: true,
    read: (m) => m.correctionMagnitudeMax,
    format: (v) => v.toFixed(2),
  },
  {
    label: "Transport latency",
    lowerIsBetter: true,
    read: (m) => m.inputLatencyMeanMs,
    format: (v) => `${v.toFixed(1)} ms`,
    context: true,
  },
];

/** Percentage change from baseline, guarding the divide when the baseline is zero. */
function changeLabel(baseline: number, configured: number, lowerIsBetter: boolean) {
  if (baseline === configured) return { text: "same", tone: "flat" as const };
  if (baseline === 0) {
    // going from nothing to something has no meaningful percentage, so the
    // direction is reported without inventing one
    return {
      text: configured > 0 ? "new" : "same",
      tone: lowerIsBetter ? ("worse" as const) : ("better" as const),
    };
  }
  const delta = ((configured - baseline) / baseline) * 100;
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return {
    text: `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`,
    tone: improved ? ("better" as const) : ("worse" as const),
  };
}

/** How a change reads: green when the techniques helped, red when they cost. */
const TONES: Record<string, string> = {
  better: "text-pass",
  worse: "text-destructive",
  flat: "text-muted-foreground",
};

const ComparisonTable: FC<ComparisonTableProps> = ({ rows, scenario, seed }) => (
  <Card>
    <CardHeader>
      <CardTitle>Run comparison</CardTitle>
      <CardDescription>
        Seed {String(seed)}, {scenario.durationTicks} ticks at {scenario.tickRate} Hz.
        Each cell is the compensated run, with its change against the same run with no
        compensation. Distances are in world units.
      </CardDescription>
    </CardHeader>

    <CardContent>
      <div className="overflow-x-auto">
        <Table data-testid="results">
          <TableHeader>
            <TableRow>
              <TableHead>Network</TableHead>
              {COLUMNS.map(({ label }) => (
                <TableHead key={label} className="text-right">
                  {label}
                </TableHead>
              ))}
              <TableHead className="text-right">Packets lost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ segmentIndex, baseline, configured }) => (
              <TableRow key={segmentIndex}>
                <TableHead scope="row" className="font-normal whitespace-nowrap">
                  {SEGMENT_PRESETS[segmentIndex]}
                </TableHead>
                {COLUMNS.map(({ label, read, format, lowerIsBetter, context }) => {
                  const after = read(configured);
                  /**
                   * A context column is identical in both runs by construction, so it
                   * carries no change. It used to print the words "both runs" in every
                   * one of its cells, which read as data and filled a column with prose.
                   */
                  if (context) {
                    return (
                      <TableCell key={label} className="tabular text-right">
                        {format(after)}
                      </TableCell>
                    );
                  }
                  const change = changeLabel(read(baseline), after, lowerIsBetter);
                  return (
                    <TableCell key={label} className="text-right">
                      <span className="tabular block text-sm" data-testid="cell-value">
                        {format(after)}
                      </span>
                      <span
                        data-testid="cell-change"
                        className={cn(
                          "tabular mt-0.5 block text-xs",
                          TONES[change.tone] ?? "text-muted-foreground",
                        )}
                      >
                        {change.text}
                      </span>
                    </TableCell>
                  );
                })}
                <TableCell className="text-right">
                  <span className="tabular block text-sm" data-testid="cell-value">
                    {configured.packetsDropped}
                  </span>
                  <span
                    className="tabular mt-0.5 block text-xs text-muted-foreground"
                    data-testid="cell-change"
                  >
                    of {configured.packetsSent} sent
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </CardContent>
  </Card>
);

export default ComparisonTable;
