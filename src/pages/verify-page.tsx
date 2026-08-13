import { useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  /**
   * False once this mount has been torn down. See `determinism-panel.tsx`: a
   * discarded mount's measurement must not write over the one the visible mount is
   * waiting for.
   */
  const live = useRef(true);

  const measure = useCallback(async (alive: () => boolean = () => true) => {
    setStatus("running");
    setError("");
    try {
      const active = pool();
      const measured = await Promise.all(
        ORACLE_POINTS.map((point) =>
          active.peekersAdvantage(point.rttMs, point.tickRate, point.clientFps),
        ),
      );
      if (!alive()) return;
      setRows(ORACLE_POINTS.map((point, i) => judge(point, measured[i] ?? 0)));
      setStatus("done");
    } catch (cause) {
      if (!alive()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("failed");
    }
  }, [pool]);

  useEffect(() => {
    live.current = true;
    void measure(() => live.current);
    return () => {
      live.current = false;
    };
  }, [measure]);

  return (
    <div className="space-y-6">
      <header className="max-w-3xl space-y-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Verify</h1>
        <p className="text-sm text-muted-foreground">
          Three checks, run in this browser when the page loads. The reproduction tests
          the model against figures published by another team, the determinism panel
          tests it against itself, and the failure demos show that the effects the tool
          reports are ones it can actually produce.
        </p>
      </header>

      {status === "failed" ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2"
          data-testid="verify-error"
          role="alert"
        >
          <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
          <span className="text-sm text-destructive">{error}</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => void measure()}
          >
            <RotateCw data-icon="inline-start" />
            Try again
          </Button>
        </div>
      ) : null}

      <OracleTable rows={rows} running={status === "running"} />
      <DeterminismPanel pool={pool} coreVersion={coreVersion} />
      <FailureDemos pool={pool} />
    </div>
  );
};

export default VerifyPage;
