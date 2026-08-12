import type { FC } from "react";
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

const ComparisonTable: FC<ComparisonTableProps> = ({ rows, scenario, seed }) => (
  <div className="table-wrap">
    <table data-testid="results">
      <caption>
        Seed {String(seed)}, {scenario.durationTicks} ticks at {scenario.tickRate} Hz.
        Each cell shows the compensated run, with its change against the same run with
        no compensation.
      </caption>
      <thead>
        <tr>
          <th scope="col">Network</th>
          {COLUMNS.map(({ label }) => (
            <th scope="col" key={label}>
              {label}
            </th>
          ))}
          <th scope="col">Packets lost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ segmentIndex, baseline, configured }) => (
          <tr key={segmentIndex}>
            <th scope="row">{SEGMENT_PRESETS[segmentIndex]}</th>
            {COLUMNS.map(({ label, read, format, lowerIsBetter, context }) => {
              const after = read(configured);
              if (context) {
                return (
                  <td key={label}>
                    <span className="value">{format(after)}</span>
                    <span className="change flat">both runs</span>
                  </td>
                );
              }
              const change = changeLabel(read(baseline), after, lowerIsBetter);
              return (
                <td key={label}>
                  <span className="value">{format(after)}</span>
                  <span className={`change ${change.tone}`}>{change.text}</span>
                </td>
              );
            })}
            <td>
              <span className="value">{configured.packetsDropped}</span>
              <span className="change flat">of {configured.packetsSent}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default ComparisonTable;
