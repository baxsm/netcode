import type { FC } from "react";
import Verdict from "./verdict";
import { TOLERANCE_MS, allPassed, type OracleRow } from "../verify/oracle";

interface OracleTableProps {
  rows: readonly OracleRow[];
  running: boolean;
}

const OracleTable: FC<OracleTableProps> = ({ rows, running }) => (
  <section className="panel" aria-labelledby="oracle-heading">
    <div className="panel-head">
      <h2 id="oracle-heading">The published reproduction</h2>
      {rows.length > 0 ? (
        <Verdict passed={allPassed(rows)} testId="oracle-verdict">
          {allPassed(rows) ? "All three match" : "A row is outside tolerance"}
        </Verdict>
      ) : null}
    </div>

    <p className="note">
      Peeker&apos;s advantage is round trip plus two frames of server buffering and
      three of client buffering. These three points come from Riot&apos;s VALORANT
      article, computed by a different team from a different implementation, so
      agreement tests this one from outside rather than against itself.
    </p>

    {running && rows.length === 0 ? (
      <p className="state" data-testid="oracle-loading">
        Measuring.
      </p>
    ) : null}

    {rows.length > 0 ? (
      <div className="table-wrap">
        <table data-testid="oracle-table">
          <caption>
            A row passes when the measured figure is within {TOLERANCE_MS} ms of the
            published one. The article rounds every figure to the millisecond and says it
            hand-waves the buffering term, so the tolerance covers that. One frame is
            7.8 ms at 128 tick, so an off-by-one-frame error is three times this and
            still fails.
          </caption>
          <thead>
            <tr>
              <th scope="col">Condition</th>
              <th scope="col">RTT</th>
              <th scope="col">Tick</th>
              <th scope="col">FPS</th>
              <th scope="col">Measured</th>
              <th scope="col">Published</th>
              <th scope="col">Difference</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} data-testid="oracle-row">
                <th scope="row">
                  {row.label}
                  <span className="row-note">{row.note}</span>
                </th>
                <td>{row.rttMs} ms</td>
                <td>{row.tickRate}</td>
                <td>{row.clientFps}</td>
                <td>{row.measuredMs.toFixed(1)} ms</td>
                <td className="muted">{row.publishedMs} ms</td>
                <td>
                  {row.deltaMs >= 0 ? "+" : ""}
                  {row.deltaMs.toFixed(1)} ms
                </td>
                <td>
                  <Verdict passed={row.passed}>{row.passed ? "Pass" : "Fail"}</Verdict>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : null}
  </section>
);

export default OracleTable;
