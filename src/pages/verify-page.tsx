import { useCallback, useEffect, useState } from "react";
import type { FC } from "react";
import DeterminismPanel from "../components/determinism-panel";
import FailureDemos from "../components/failure-demos";
import OracleTable from "../components/oracle-table";
import type { SimPool } from "../workers/pool";
import { ORACLE_POINTS, judge, type OracleRow } from "../verify/oracle";

interface VerifyPageProps {
  pool: () => SimPool;
  coreVersion: string;
}

type Status = "running" | "done" | "failed";

/**
 * The page that makes the tool trustworthy.
 *
 * Everything here is measured on load rather than recorded. A table of numbers typed
 * into the source would look identical and prove nothing, which is the difference
 * between asserting the simulation is right and showing it.
 */
const VerifyPage: FC<VerifyPageProps> = ({ pool, coreVersion }) => {
  const [rows, setRows] = useState<OracleRow[]>([]);
  const [status, setStatus] = useState<Status>("running");
  const [error, setError] = useState("");

  const measure = useCallback(async () => {
    setStatus("running");
    setError("");
    try {
      const active = pool();
      const measured = await Promise.all(
        ORACLE_POINTS.map((point) =>
          active.peekersAdvantage(point.rttMs, point.tickRate, point.clientFps),
        ),
      );
      setRows(ORACLE_POINTS.map((point, i) => judge(point, measured[i] ?? 0)));
      setStatus("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("failed");
    }
  }, [pool]);

  useEffect(() => {
    void measure();
  }, [measure]);

  return (
    <>
      <header>
        <h1>Verify</h1>
        <p>
          Three checks, run in this browser when the page loads. The reproduction tests
          the model against figures published by another team, the determinism panel
          tests it against itself, and the failure demos show that the effects the tool
          reports are ones it can actually produce.
        </p>
      </header>

      {status === "failed" ? (
        <p className="state error" data-testid="verify-error" role="alert">
          {error}{" "}
          <button type="button" className="ghost" onClick={() => void measure()}>
            Try again
          </button>
        </p>
      ) : null}

      <OracleTable rows={rows} running={status === "running"} />
      <DeterminismPanel pool={pool} coreVersion={coreVersion} />
      <FailureDemos pool={pool} />
    </>
  );
};

export default VerifyPage;
