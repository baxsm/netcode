import { useCallback, useEffect, useState, type FC } from "react";
import type { SimPool } from "../workers/pool";

interface PeekersPanelProps {
  pool: () => SimPool;
}

interface Row {
  label: string;
  rttMs: number;
  tickRate: number;
  clientFps: number;
  /** The figure Riot published for this condition, for comparison. */
  published: number;
}

/**
 * The three operating points from Riot's article.
 *
 * The middle row runs at 75 ms rather than the 35 ms the phase document first
 * recorded. 35 ms is a stated infrastructure goal in the article, not the condition
 * the 141 ms figure was computed under, and at 35 ms the model produces 100.6 ms.
 * See docs/phases/phase-2.md.
 */
const ROWS: Row[] = [
  { label: "Baseline", rttMs: 100, tickRate: 64, clientFps: 60, published: 181 },
  { label: "Riot Direct, 128 tick", rttMs: 75, tickRate: 128, clientFps: 60, published: 141 },
  { label: "144 FPS client", rttMs: 35, tickRate: 128, clientFps: 144, published: 71 },
];

const PeekersPanel: FC<PeekersPanelProps> = ({ pool }) => {
  const [values, setValues] = useState<number[]>([]);
  const [failed, setFailed] = useState(false);

  const compute = useCallback(async () => {
    try {
      const p = pool();
      setValues(
        await Promise.all(
          ROWS.map((r) => p.peekersAdvantage(r.rttMs, r.tickRate, r.clientFps)),
        ),
      );
      setFailed(false);
    } catch {
      // the panel is secondary, so a failure here reports itself rather than
      // taking down the comparison above it
      setFailed(true);
    }
  }, [pool]);

  useEffect(() => {
    void compute();
  }, [compute]);

  return (
    <section className="panel" aria-labelledby="peekers-heading">
      <div className="panel-head">
        <h2 id="peekers-heading">Peeker&apos;s advantage</h2>
      </div>
      <p className="note">
        Extra reaction time the peeking player gets, as round trip plus two frames of
        server buffering and three of client buffering. Reproduced from Riot&apos;s
        published VALORANT figures, which come from a different implementation and so
        test this one from outside.
      </p>

      {failed ? (
        <p className="state error" role="alert">
          Could not reach the core. Run the comparison again.
        </p>
      ) : values.length === 0 ? (
        <p className="state">Calculating.</p>
      ) : (
        <div className="table-wrap">
          <table data-testid="peekers">
            <thead>
              <tr>
                <th scope="col">Condition</th>
                <th scope="col">RTT</th>
                <th scope="col">Tick</th>
                <th scope="col">FPS</th>
                <th scope="col">Computed</th>
                <th scope="col">Published</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, i) => {
                const computed = values[i] ?? 0;
                return (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{row.rttMs} ms</td>
                    <td>{row.tickRate}</td>
                    <td>{row.clientFps}</td>
                    <td>
                      <span className="value">{computed.toFixed(1)} ms</span>
                    </td>
                    <td>
                      <span className="muted">~{row.published} ms</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

export default PeekersPanel;
