import { useCallback, useMemo, type FC } from "react";
import {
  CartesianGrid,
  Label,
  Line,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ScenarioSpec, SweepPoint } from "../sim/types";
import { correctionsPerMinute } from "../sweep/metrics-view";

interface ParetoChartProps {
  points: SweepPoint[];
  frontOrdered: number[];
  scenario: ScenarioSpec;
  selected: number | null;
  compared: number | null;
  onSelect: (index: number, additive: boolean) => void;
}

/**
 * Both axes are in player-visible units, never in the normalized scores the front is
 * computed from. A reader can argue about milliseconds of input latency; they cannot
 * argue about 0.42.
 *
 * The scores still decide the front. The axes are the metric each score actually
 * moves on, so the picture agrees with the ranking.
 *
 * The smoothness axis is the **worst correction**, not divergence p99. Both feed the
 * score, but along the front p99 varies by 0.04 world units while the worst
 * correction varies by 0.94, so plotting p99 draws the tradeoff as a flat line and
 * hides the thing the configuration is buying.
 */
interface Plotted {
  index: number;
  latency: number;
  worstCorrection: number;
  onFront: boolean;
}

/** What Recharts hands a custom scatter shape: the resolved position and the datum. */
interface ScatterDotProps {
  cx?: number;
  cy?: number;
  payload?: Plotted;
}

const COLOURS = {
  front: "#58a6ff",
  dominated: "#3d4653",
  selected: "#e6edf3",
  compared: "#f0883e",
};

/** What Recharts passes a tooltip renderer. Readonly, with its own entry type. */
interface TooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
}

function TooltipBody({
  active,
  payload,
  points,
  scenario,
}: TooltipProps & {
  points: SweepPoint[];
  scenario: ScenarioSpec;
}) {
  const plotted = payload?.[0]?.payload as Plotted | undefined;
  if (!active || !plotted) return null;
  const point = points[plotted.index];
  if (!point) return null;

  return (
    <div className="chart-tooltip">
      <strong>{plotted.onFront ? "On the front" : "Dominated"}</strong>
      <dl>
        <div>
          <dt>Input latency</dt>
          <dd>{point.metrics.inputLatencyMeanMs.toFixed(1)} ms</dd>
        </div>
        <div>
          <dt>Worst rubber-band</dt>
          <dd>{point.metrics.correctionMagnitudeMax.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Divergence p99</dt>
          <dd>{point.metrics.divergenceP99.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Corrections</dt>
          <dd>{correctionsPerMinute(point.metrics, scenario).toFixed(0)} / min</dd>
        </div>
        <div>
          <dt>Input buffer</dt>
          <dd>{point.config.inputBufferTicks} ticks</dd>
        </div>
        <div>
          <dt>Blend</dt>
          <dd>{(point.config.correctionBlendPermille / 10).toFixed(0)}% kept</dd>
        </div>
      </dl>
      <span className="chart-tooltip-hint">Click to select, shift-click to compare</span>
    </div>
  );
}

const ParetoChart: FC<ParetoChartProps> = ({
  points,
  frontOrdered,
  scenario,
  selected,
  compared,
  onSelect,
}) => {
  const front = useMemo(() => new Set(frontOrdered), [frontOrdered]);

  const { dominated, onFront, frontLine } = useMemo(() => {
    const plotted: Plotted[] = points.map((p, index) => ({
      index,
      latency: p.metrics.inputLatencyMeanMs,
      worstCorrection: p.metrics.correctionMagnitudeMax,
      onFront: front.has(index),
    }));
    return {
      dominated: plotted.filter((p) => !p.onFront),
      onFront: plotted.filter((p) => p.onFront),
      // the connecting line follows the front in tradeoff order, so its shape reads
      // as the curve rather than as the order the grid was generated in
      frontLine: frontOrdered
        .map((i) => plotted[i])
        .filter((p): p is Plotted => p !== undefined),
    };
  }, [points, front, frontOrdered]);

  /**
   * Recharts positions a custom shape by handing it the resolved `cx`/`cy`, rather
   * than translating the element it returns. Drawing at the origin puts every point
   * in the chart's top-left corner, which reads as an empty chart with one stray
   * mark rather than as an error.
   *
   * Memoized because Recharts treats `shape` by identity: a fresh closure on every
   * render remounts every point's shape rather than updating it, which is wasted
   * work on a chart of a few hundred points that re-renders on each selection.
   */
  const dot = useCallback(
    ({ cx, cy, payload }: ScatterDotProps) => {
      if (cx == null || cy == null || !payload) return <g />;
      const { index } = payload;
      const chosen = index === selected || index === compared;
      const size = chosen ? 7 : front.has(index) ? 5 : 3;
      const colour =
        index === selected
          ? COLOURS.selected
          : index === compared
            ? COLOURS.compared
            : front.has(index)
              ? COLOURS.front
              : COLOURS.dominated;

      return (
        <circle
          cx={cx}
          cy={cy}
          r={size}
          fill={colour}
          stroke={chosen ? "#0d1117" : "none"}
          strokeWidth={2}
        />
      );
    },
    [front, selected, compared],
  );

  const handleSelect = useCallback(
    (entry: unknown, _index: number, event: unknown) =>
      onSelect(
        (entry as Plotted).index,
        Boolean((event as { shiftKey?: boolean })?.shiftKey),
      ),
    [onSelect],
  );

  const tooltip = useCallback(
    (props: TooltipProps) => <TooltipBody {...props} points={points} scenario={scenario} />,
    [points, scenario],
  );

  return (
    <div className="chart" data-testid="pareto-chart">
      <ResponsiveContainer width="100%" height={340}>
        <ScatterChart margin={{ top: 12, right: 20, bottom: 44, left: 8 }}>
          <CartesianGrid stroke="#262d38" strokeDasharray="2 4" />
          <XAxis
            type="number"
            dataKey="latency"
            name="Input latency"
            unit=" ms"
            stroke="#8b949e"
            fontSize={12}
            tickLine={false}
          >
            <Label
              value="Input latency (ms), lower is more responsive"
              position="bottom"
              offset={16}
              fill="#8b949e"
              fontSize={12}
            />
          </XAxis>
          <YAxis
            type="number"
            dataKey="worstCorrection"
            name="Worst rubber-band"
            stroke="#8b949e"
            fontSize={12}
            tickLine={false}
            width={68}
            // the spread along this axis is under a unit, so the default domain
            // starting at zero would flatten the front into a single line. padded
            // rather than exact so the extreme points are not drawn on the frame
            domain={([min, max]: readonly [number, number]) =>
              [Math.floor((min - 0.3) * 10) / 10, Math.ceil((max + 0.3) * 10) / 10] as [
                number,
                number,
              ]
            }
            tickFormatter={(v: number) => v.toFixed(1)}
          >
            <Label
              value="Worst rubber-band (units), lower is smoother"
              angle={-90}
              position="insideLeft"
              style={{ textAnchor: "middle" }}
              fill="#8b949e"
              fontSize={12}
            />
          </YAxis>
          {/* no cursor: on a scatter chart it draws a rectangle around the plot area
              that reads as a selection box rather than as a hover indicator */}
          <Tooltip cursor={false} content={tooltip} />
          <Scatter
            data={dominated}
            shape={dot as never}
            onClick={handleSelect}
            isAnimationActive={false}
          />
          {/* the line is drawn under the front points so the markers stay readable */}
          <Line
            data={frontLine}
            dataKey="worstCorrection"
            stroke={COLOURS.front}
            strokeWidth={1.5}
            dot={false}
            legendType="none"
            isAnimationActive={false}
          />
          <Scatter
            data={onFront}
            shape={dot as never}
            onClick={handleSelect}
            isAnimationActive={false}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ParetoChart;
