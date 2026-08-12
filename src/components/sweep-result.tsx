import type { FC } from "react";
import type { ScenarioSpec, SweepPoint } from "../sim/types";
import { configRows, metricRows } from "../sweep/metrics-view";
import { differences } from "../sweep/pareto";
import { RESOLUTION_FLOOR } from "../sweep/grid";

interface SweepResultProps {
  point: SweepPoint;
  comparedTo: SweepPoint | null;
  scenario: ScenarioSpec;
  onFront: boolean;
  onOpenReplay: () => void;
  onExportConfig: () => void;
  onExportReport: () => void;
  onClearComparison: () => void;
}

/** Change against the compared point, in the same unit as the row. */
function deltaLabel(left: string, right: string): { text: string; tone: string } | null {
  const a = Number.parseFloat(left);
  const b = Number.parseFloat(right);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  const delta = a - b;
  return {
    text: `${delta > 0 ? "+" : ""}${delta.toFixed(Math.abs(delta) < 10 ? 2 : 0)}`,
    tone: delta < 0 ? "better" : "worse",
  };
}

const SweepResult: FC<SweepResultProps> = ({
  point,
  comparedTo,
  scenario,
  onFront,
  onOpenReplay,
  onExportConfig,
  onExportReport,
  onClearComparison,
}) => {
  const rows = metricRows(point.metrics, scenario);
  const otherRows = comparedTo ? metricRows(comparedTo.metrics, scenario) : null;
  const configDiff = comparedTo ? differences(point, comparedTo, configRows) : [];

  return (
    <section className="panel" aria-labelledby="result-heading" data-testid="sweep-result">
      <div className="panel-head">
        <h2 id="result-heading">
          {onFront ? "Selected configuration" : "Selected (dominated)"}
        </h2>
        <div className="panel-actions">
          <button type="button" className="ghost" onClick={onOpenReplay}>
            Open in replay
          </button>
          <button type="button" className="ghost" onClick={onExportConfig}>
            Export config
          </button>
          <button type="button" className="ghost" onClick={onExportReport}>
            Export report
          </button>
        </div>
      </div>

      {onFront ? null : (
        <p className="note">
          This point is beaten on both axes by at least one other. It is shown so the
          shape of the tradeoff reads, but a configuration on the front is strictly
          better.
        </p>
      )}

      <div className="result-grid">
        <div>
          <h3 className="sub-heading">
            What a player gets
            {comparedTo ? <span className="muted"> vs compared</span> : null}
          </h3>
          <dl className="metric-list" data-testid="result-metrics">
            {rows.map((row, i) => {
              const other = otherRows?.[i];
              const delta = other ? deltaLabel(row.value, other.value) : null;
              return (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>
                    {row.value}
                    {delta ? (
                      <span className={`change ${delta.tone}`}>{delta.text}</span>
                    ) : null}
                  </dd>
                  <span className="metric-note">{row.note}</span>
                </div>
              );
            })}
          </dl>
        </div>

        <div>
          <h3 className="sub-heading">The configuration</h3>
          <dl className="config-list" data-testid="result-config">
            {configRows(point.config).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {comparedTo ? (
        <div className="diff" data-testid="config-diff">
          <div className="panel-head">
            <h3 className="sub-heading">What differs between the two</h3>
            <button type="button" className="ghost" onClick={onClearComparison}>
              Clear comparison
            </button>
          </div>
          {configDiff.length === 0 ? (
            <p className="note">
              The two configurations are identical. Their results differ only by the
              seeds they ran on.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Setting</th>
                    <th scope="col">Selected</th>
                    <th scope="col">Compared</th>
                  </tr>
                </thead>
                <tbody>
                  {configDiff.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      <td>{row.left}</td>
                      <td>{row.right}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="note">
            Score gaps narrower than {RESOLUTION_FLOOR.toFixed(3)} are inside the
            run-to-run noise at this seed count, so a difference smaller than that is
            not a real one.
          </p>
        </div>
      ) : null}
    </section>
  );
};

export default SweepResult;
