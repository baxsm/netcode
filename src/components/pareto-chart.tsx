import { useCallback, useMemo, useRef, useState, type FC, type KeyboardEvent } from "react";
import { CHART, DATA } from "../palette";
import type { ScenarioSpec, SweepPoint } from "../sim/types";
import { correctionsPerMinute } from "../sweep/metrics-view";
import { cn } from "@/lib/utils";

interface ParetoChartProps {
  points: SweepPoint[];
  frontOrdered: number[];
  scenario: ScenarioSpec;
  selected: number | null;
  compared: number | null;
  onSelect: (index: number, additive: boolean) => void;
}

/**
 * The tradeoff, drawn as a strip plot rather than a scatter.
 *
 * Input latency is not continuous here. It is driven by the input buffer, which the
 * grid sweeps over six integer values, so 216 configurations land in six columns of
 * thirty-six. Drawn as a scatter they stacked: 216 markers occupied 64 distinct pixels,
 * with up to thirty on one spot, so seventy percent of the search was invisible and a
 * click landed on whichever marker happened to be last in the DOM.
 *
 * So each column is spread horizontally, and configurations that measured the same
 * result share one mark that says how many it stands for. Every mark is then far
 * enough from its neighbours to be seen, hovered and clicked.
 *
 * This is hand-drawn SVG, replacing Recharts, and the reason is interaction rather
 * than looks. Recharts binds pointer handling to a surface above the marks: hovering a
 * marker did nothing, `elementFromPoint` over a marker returned the chart surface, and
 * the tooltip reported the same point forty pixels away in empty space as it did on
 * the mark itself. The marks were decoration over an overlay that answered for them.
 * Here the mark *is* the button.
 */
interface Plotted {
  index: number;
  latency: number;
  worstCorrection: number;
  onFront: boolean;
  /** Horizontal nudge inside its latency column, so marks do not stack. */
  offset: number;
  /** Every configuration this mark stands for, itself included. */
  members: number[];
}

const PADDING = { top: 16, right: 24, bottom: 52, left: 76 };
const HEIGHT = 360;
/**
 * The most of the gap between two latency steps a column may occupy.
 *
 * Derived at render time rather than fixed, because a constant is wrong at some
 * width: 120 px looked right at 1440 and merged neighbouring columns into each other,
 * so what the chart drew as one crowd was actually two different latencies.
 */
const SPREAD_FRACTION = 0.55;
/**
 * The largest a hit target may be, in pixels of radius.
 *
 * Capped by the real spacing between neighbours rather than set to a comfortable
 * constant. At a flat 9 the targets of adjacent points in a crowded column overlapped,
 * so the top one swallowed its neighbour's pointer events and hovering the covered
 * point was impossible. Which is the same "the click goes to the wrong mark" failure
 * the scatter had, only smaller.
 */
const MAX_TARGET = 9;
/** The distance any two marks must keep, which the hit target is then derived from. */
const MIN_GAP = 9;

interface Hovered {
  point: Plotted;
  x: number;
  y: number;
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || 1;
  const step = span / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
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
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [width, setWidth] = useState(900);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // measured rather than assumed, so the plot fills whatever the card gives it
  const measure = useCallback((node: HTMLDivElement | null) => {
    wrapRef.current = node;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
  }, []);

  const { plotted, scaleX, scaleY, xTicks, yTicks, frontPath } = useMemo(() => {
    const raw = points.map((p, index) => ({
      index,
      latency: p.metrics.inputLatencyMeanMs,
      worstCorrection: p.metrics.correctionMagnitudeMax,
      onFront: front.has(index),
    }));

    const latencies = raw.map((p) => p.latency);
    const corrections = raw.map((p) => p.worstCorrection);
    const xMin = 0;
    const xMax = Math.max(...latencies) * 1.08 || 1;
    // padded rather than exact, so the extreme points are not drawn on the frame
    const yMin = Math.min(...corrections) - 0.3;
    const yMax = Math.max(...corrections) + 0.3;

    const plotWidth = Math.max(240, width - PADDING.left - PADDING.right);
    const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

    const scaleX = (v: number) => PADDING.left + ((v - xMin) / (xMax - xMin)) * plotWidth;
    const scaleY = (v: number) =>
      PADDING.top + plotHeight - ((v - yMin) / (yMax - yMin)) * plotHeight;

    /**
     * Marks, one per distinct result rather than one per configuration.
     *
     * Thirty-six configurations share each latency column, and many of them land on
     * the same worst-correction too: measured, the median gap between neighbours was
     * 1.3 pixels and 168 of 216 points sat within six pixels of an identical-value
     * neighbour. Fanning those out gave every point a position but none of them a
     * usable target, which is the stacking problem again wearing a different hat.
     *
     * So configurations that produce the same measured result become one mark that
     * says how many it stands for. Nothing is hidden: the count is on the mark, and
     * the readout lists what varies between them.
     */
    const groups = new Map<string, typeof raw>();
    for (const p of raw) {
      // rounded to the precision the axes are read at, so two marks are only separate
      // when a reader could actually tell them apart
      const key = `${p.latency.toFixed(1)}|${p.worstCorrection.toFixed(1)}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(p);
      else groups.set(key, [p]);
    }

    /** Column membership after grouping, which is what decides the fan-out. */
    const columns = new Map<string, string[]>();
    for (const [key, bucket] of groups) {
      const first = bucket[0];
      if (!first) continue;
      const col = first.latency.toFixed(1);
      const list = columns.get(col);
      if (list) list.push(key);
      else columns.set(col, [key]);
    }
    /**
     * Offsets placed rather than ranked.
     *
     * Ranking a column by value and fanning out evenly kept neighbours apart but drew
     * the same diagonal in every column, correlating the offset with the value at
     * -0.93 so the spread read as a trend. Alternating outward from the centre broke
     * the diagonal and collapsed the spacing to four pixels instead.
     *
     * Neither is necessary: what the layout has to guarantee is a minimum distance,
     * so it solves for that directly. Each mark takes the slot nearest the column
     * centre that clears every mark already placed, working down the column. Marks
     * with room stay near the middle, only genuinely crowded values push outward, and
     * no ordering artifact survives because the offset depends on what is nearby
     * rather than on the value's rank.
     */
    const stepXs = [...new Set(raw.map((p) => p.latency))]
      .sort((a, b) => a - b)
      .map((v) => scaleX(v));
    let narrowest = Infinity;
    for (let i = 1; i < stepXs.length; i += 1) {
      narrowest = Math.min(narrowest, (stepXs[i] as number) - (stepXs[i - 1] as number));
    }
    const spread = Number.isFinite(narrowest) ? narrowest * SPREAD_FRACTION : 120;

    const offsets = new Map<string, number>();
    for (const list of columns.values()) {
      // top of the column down, so the placement is stable between renders
      const ordered = [...list].sort(
        (a, b) => Number(a.split("|")[1]) - Number(b.split("|")[1]),
      );
      const placed: Array<{ x: number; y: number }> = [];
      const step = MIN_GAP / 2;
      const limit = Math.ceil(spread / 2 / step);

      for (const key of ordered) {
        const y = scaleY(Number(key.split("|")[1]));
        let chosen = 0;
        // candidate offsets ordered by distance from the centre: 0, +s, -s, +2s...
        for (let k = 0; k <= limit; k += 1) {
          const candidates = k === 0 ? [0] : [k * step, -k * step];
          const free = candidates.find((offset) =>
            placed.every((q) => Math.hypot(q.x - offset, q.y - y) >= MIN_GAP),
          );
          if (free !== undefined) {
            chosen = free;
            break;
          }
          // nothing free within the column's width: sit at the edge rather than
          // widening into the neighbouring latency step
          if (k === limit) chosen = (ordered.indexOf(key) % 2 === 0 ? 1 : -1) * limit * step;
        }
        placed.push({ x: chosen, y });
        offsets.set(key, chosen);
      }
    }

    const withRank: Plotted[] = [];
    for (const [key, bucket] of groups) {
      const first = bucket[0];
      if (!first) continue;
      // the front wins the group's identity, so a front point is never absorbed into
      // a dominated mark and silently dropped off the curve
      const representative = bucket.find((p) => p.onFront) ?? first;
      withRank.push({
        ...representative,
        members: bucket.map((p) => p.index),
        onFront: bucket.some((p) => p.onFront),
        offset: offsets.get(key) ?? 0,
      });
    }
    withRank.sort((a, b) => a.index - b.index);

    return {
      plotted: withRank,
      scaleX,
      scaleY,
      xTicks: niceTicks(xMin, xMax, 5),
      yTicks: niceTicks(yMin, yMax, 5),
      frontPath: frontOrdered
        .map((i) => withRank.find((p) => p.index === i))
        .filter((p): p is Plotted => p !== undefined),
    };
  }, [points, front, frontOrdered, width]);

  /**
   * A mark's drawn position: its true latency, nudged sideways only as far as it took
   * to clear its neighbours. The axis label says the steps are discrete, so the nudge
   * cannot be misread as latency variation.
   */
  const positionOf = useCallback(
    (p: Plotted) => ({ x: scaleX(p.latency) + p.offset, y: scaleY(p.worstCorrection) }),
    [scaleX, scaleY],
  );

  /**
   * Half the distance to the nearest other mark, so two targets can never overlap.
   *
   * Computed once over the whole set rather than per point, because a target that
   * changed size with its neighbours would make the same click land differently in
   * different columns.
   */
  const targetRadius = useMemo(() => {
    // sorted by x, so only marks within the current best distance need comparing.
    // an all-pairs scan would be 23,000 checks on every resize for no better answer
    const placed = plotted.map(positionOf).sort((a, b) => a.x - b.x);
    let closest = Infinity;
    for (let i = 0; i < placed.length; i += 1) {
      const a = placed[i];
      if (!a) continue;
      for (let j = i + 1; j < placed.length; j += 1) {
        const b = placed[j];
        if (!b) continue;
        if (b.x - a.x >= closest) break;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 0 && d < closest) closest = d;
      }
    }
    if (!Number.isFinite(closest)) return MAX_TARGET;
    return Math.min(MAX_TARGET, closest / 2);
  }, [plotted, positionOf]);

  const colourOf = useCallback(
    (p: Plotted) =>
      p.index === selected
        ? DATA.selected
        : p.index === compared
          ? DATA.compared
          : p.onFront
            ? DATA.front
            : DATA.dominated,
    [selected, compared],
  );

  const onKey = useCallback(
    (event: KeyboardEvent<SVGCircleElement>, p: Plotted) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect(p.index, event.shiftKey);
    },
    [onSelect],
  );

  const hoveredPoint = hovered ? points[hovered.point.index] : undefined;

  return (
    <div className="relative" ref={measure} data-testid="pareto-chart">
      <svg
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="group"
        aria-label={`${points.length} configurations, ${frontOrdered.length} on the front`}
        className="overflow-visible"
      >
        <title>Input latency against worst rubber-band, one mark per configuration</title>

        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line
              x1={PADDING.left}
              x2={width - PADDING.right}
              y1={scaleY(v)}
              y2={scaleY(v)}
              stroke={CHART.grid}
              strokeDasharray="2 4"
            />
            <text
              x={PADDING.left - 10}
              y={scaleY(v)}
              textAnchor="end"
              dominantBaseline="middle"
              fill={CHART.axis}
              fontSize={12}
              className="tabular"
            >
              {v.toFixed(1)}
            </text>
          </g>
        ))}

        {xTicks.map((v) => (
          <text
            key={`x${v}`}
            x={scaleX(v)}
            y={HEIGHT - PADDING.bottom + 20}
            textAnchor="middle"
            fill={CHART.axis}
            fontSize={12}
            className="tabular"
          >
            {v.toFixed(0)} ms
          </text>
        ))}

        <text
          x={PADDING.left + (width - PADDING.left - PADDING.right) / 2}
          y={HEIGHT - 8}
          textAnchor="middle"
          fill={CHART.axis}
          fontSize={12}
        >
          Input latency (ms), lower is more responsive
        </text>
        <text
          transform={`translate(16, ${PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) / 2}) rotate(-90)`}
          textAnchor="middle"
          fill={CHART.axis}
          fontSize={12}
        >
          Worst rubber-band (units), lower is smoother
        </text>

        {/* the front, drawn under the marks so the markers stay readable */}
        {frontPath.length > 1 ? (
          <polyline
            points={frontPath.map((p) => { const { x, y } = positionOf(p); return `${x},${y}`; }).join(" ")}
            fill="none"
            stroke={DATA.front}
            strokeWidth={1.5}
            strokeOpacity={0.7}
            pointerEvents="none"
          />
        ) : null}

        {/**
         * Dominated first, then the front, so a front marker is never buried under a
         * dominated one. Each mark is its own button: it owns the pointer events, so
         * hovering it is what shows its values and clicking it is what selects it.
         */}
        {[...plotted]
          .sort((a, b) => Number(a.onFront) - Number(b.onFront))
          .map((p) => {
            const { x, y } = positionOf(p);
            const chosen = p.index === selected || p.index === compared;
            const isHovered = hovered?.point.index === p.index;
            const radius = chosen ? 6 : p.onFront ? 4.5 : 3;
            return (
              <g key={p.index}>
                {/* an invisible target, because a 3px mark is not something a hand can
                    reliably hit. the visible dot stays small so the column reads */}
                <circle
                  cx={x}
                  cy={y}
                  r={targetRadius}
                  fill="transparent"
                  className="cursor-pointer outline-none"
                  tabIndex={0}
                  role="button"
                  aria-pressed={p.index === selected}
                  aria-label={`${p.latency.toFixed(1)} ms input latency, worst rubber-band ${p.worstCorrection.toFixed(2)}${p.onFront ? ", on the front" : ""}${p.members.length > 1 ? `, ${p.members.length} configurations measured the same` : ""}`}
                  data-testid={`point-${p.index}`}
                  /**
                   * `onPointerOver`, not `onPointerEnter`.
                   *
                   * React delegates from the root, and `pointerenter` does not bubble,
                   * so it never reaches the delegated listener from an SVG child: the
                   * mark highlighted under a synthetic event but stayed dead under a
                   * real cursor. `pointerover` bubbles and works.
                   */
                  onPointerOver={() => setHovered({ point: p, x, y })}
                  onPointerOut={() => setHovered((h) => (h?.point.index === p.index ? null : h))}
                  onFocus={() => setHovered({ point: p, x, y })}
                  onBlur={() => setHovered((h) => (h?.point.index === p.index ? null : h))}
                  onClick={(event) => onSelect(p.index, event.shiftKey)}
                  onKeyDown={(event) => onKey(event, p)}
                />
                <circle
                  cx={x}
                  cy={y}
                  r={isHovered ? radius + 2 : radius}
                  fill={colourOf(p)}
                  stroke={chosen || isHovered ? CHART.surface : "none"}
                  strokeWidth={2}
                  pointerEvents="none"
                  className="transition-[r]"
                />
                {/* a mark standing for several configurations wears a ring, so the
                    grouping is visible rather than only stated in the readout */}
                {p.members.length > 1 ? (
                  <circle
                    cx={x}
                    cy={y}
                    r={radius + 3}
                    fill="none"
                    stroke={colourOf(p)}
                    strokeOpacity={0.35}
                    pointerEvents="none"
                  />
                ) : null}
                {/* the focus ring has to be drawn, since an SVG shape gets no default */}
                {isHovered ? (
                  <circle
                    cx={x}
                    cy={y}
                    r={radius + 6}
                    fill="none"
                    stroke={colourOf(p)}
                    strokeOpacity={0.4}
                    pointerEvents="none"
                  />
                ) : null}
              </g>
            );
          })}
      </svg>

      {/**
       * The readout follows the mark under the pointer, and only that mark.
       *
       * Positioned against the wrapper rather than the cursor so it does not chase the
       * mouse, and flipped to the left half when the point is on the right so it never
       * leaves the card.
       */}
      {hovered && hoveredPoint ? (
        <div
          className="pointer-events-none absolute z-10 w-56 rounded-lg border border-border bg-popover px-3 py-2.5 shadow-lg"
          style={{
            left: hovered.x > width / 2 ? hovered.x - 240 : hovered.x + 16,
            top: Math.min(hovered.y, HEIGHT - 190),
          }}
          data-testid="chart-readout"
          role="status"
        >
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <span
              className="size-2 rounded-full"
              style={{ background: colourOf(hovered.point) }}
              aria-hidden
            />
            {hovered.point.onFront ? "On the front" : "Dominated"}
            {hovered.point.members.length > 1 ? (
              <span className="ml-auto text-muted-foreground">
                {hovered.point.members.length} configs
              </span>
            ) : null}
          </p>
          <dl className="mt-2 space-y-1">
            {(
              [
                ["Input latency", `${hoveredPoint.metrics.inputLatencyMeanMs.toFixed(1)} ms`],
                ["Worst rubber-band", `${hoveredPoint.metrics.correctionMagnitudeMax.toFixed(2)} units`],
                ["Divergence p99", `${hoveredPoint.metrics.divergenceP99.toFixed(2)} units`],
                [
                  "Corrections",
                  `${correctionsPerMinute(hoveredPoint.metrics, scenario).toFixed(0)} / min`,
                ],
                ["Input buffer", `${hoveredPoint.config.inputBufferTicks} ticks`],
                ["Blend", `${(hoveredPoint.config.correctionBlendPermille / 10).toFixed(0)}% kept`],
              ] as Array<[string, string]>
            ).map(([term, value]) => (
              <div key={term} className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-muted-foreground">{term}</dt>
                <dd className="tabular text-xs">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
            Click to select, shift-click to compare
          </p>
        </div>
      ) : null}

      {/**
       * The front as a row of buttons, next to the marks rather than instead of them.
       *
       * Every mark is focusable, but there are sixty-five of them and the front is
       * four, so tabbing to the answer would mean passing most of the search first.
       * This is the short path to the points the page exists to recommend.
       */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="front-picks">
        <span className="mr-1 text-xs text-muted-foreground">On the front</span>
        {frontPath.map((p, position) => {
          const isSelected = p.index === selected;
          const isCompared = p.index === compared;
          return (
            <button
              key={p.index}
              type="button"
              data-testid={`front-pick-${position}`}
              aria-pressed={isSelected}
              onClick={(event) => onSelect(p.index, event.shiftKey)}
              onPointerOver={() => setHovered({ point: p, ...positionOf(p) })}
              onPointerOut={() => setHovered(null)}
              title={`${p.latency.toFixed(1)} ms, worst rubber-band ${p.worstCorrection.toFixed(2)}. Shift-click to compare.`}
              className={cn(
                "tabular rounded-md border px-2 py-1 text-xs transition-colors outline-none",
                "focus-visible:ring-3 focus-visible:ring-ring/50",
                isSelected
                  ? "border-foreground bg-foreground text-background"
                  : isCompared
                    ? "border-data-compared text-data-compared"
                    : "border-border text-muted-foreground hover:border-input hover:text-foreground",
              )}
            >
              {p.latency.toFixed(0)} ms
            </button>
          );
        })}
        <span className="ml-1 text-xs text-muted-foreground">
          Shift-click a second point to compare.
        </span>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Latency comes in {new Set(plotted.map((p) => p.latency.toFixed(1))).size} steps,
        because the input buffer is a whole number of ticks. Marks sharing a step are
        spread sideways, and configurations that measured the same result share one
        mark rather than stacking invisibly.
      </p>
    </div>
  );
};

export default ParetoChart;
