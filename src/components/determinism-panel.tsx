import { useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import { RotateCcw } from "lucide-react";
import StatusNote from "./status-note";
import Verdict from "./verdict";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
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
import type { SimPool } from "../workers/pool";
import { BUILT_IN_SCENARIOS } from "../scenarios/store";
import { DEFAULT_CONFIG } from "../sim/types";

interface DeterminismPanelProps {
  pool: () => SimPool;
  coreVersion: string;
}

/** Repeats of one seed. Enough that a run varying only sometimes still shows up. */
const REPEATS = 5;

/** A second seed, so a hash that is constant regardless of input cannot pass. */
const SEEDS = [42n, 43n] as const;

/** A lossy preset, since a clean link exercises far less of the run. */
const SEGMENT_INDEX = 6;

interface Result {
  seed: bigint;
  hashes: string[];
}

/**
 * The determinism check, run in the browser.
 *
 * Cross-engine agreement is a CI concern and is gated in Playwright across Chromium
 * and Firefox. What this adds is making the property visible in the product, next to
 * the build that produced it, because a hash without its build fingerprint says
 * nothing about which core it came from.
 */
const DeterminismPanel: FC<DeterminismPanelProps> = ({ pool, coreVersion }) => {
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState("");

  /**
   * False once this mount has been torn down.
   *
   * A check is ten simulations, so it easily outlives a route change or the StrictMode
   * remount that starts a second one. Without this, the run belonging to the mount
   * that was discarded still writes its result, and the panel shows whichever finished
   * last rather than the one the visible mount asked for.
   */
  const live = useRef(true);

  const check = useCallback(async (alive: () => boolean = () => true) => {
    setRunning(true);
    setError("");
    try {
      const active = pool();
      const scenario = BUILT_IN_SCENARIOS[0];
      if (!scenario) throw new Error("no built-in scenario to check against");

      const measured = await Promise.all(
        SEEDS.map(async (seed) => ({
          seed,
          hashes: await Promise.all(
            Array.from({ length: REPEATS }, () =>
              active
                .checkDeterminism(
                  scenario.spec,
                  SEGMENT_INDEX,
                  seed,
                  DEFAULT_CONFIG,
                  scenario.script,
                )
                .then((hash) => hash.toString(16).padStart(16, "0")),
            ),
          ),
        })),
      );
      if (!alive()) return;
      setResults(measured);
      setRunning(false);
    } catch (cause) {
      if (!alive()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setRunning(false);
    }
  }, [pool]);

  useEffect(() => {
    live.current = true;
    void check(() => live.current);
    return () => {
      live.current = false;
    };
  }, [check]);

  const stable = results.every((r) => new Set(r.hashes).size === 1);
  const distinct = new Set(results.map((r) => r.hashes[0])).size === results.length;
  const held = results.length > 0 && stable && distinct;

  return (
    <Card aria-labelledby="determinism-heading">
      <CardHeader>
        <CardTitle id="determinism-heading">Determinism</CardTitle>
        <CardDescription>
          The same seed run {REPEATS} times must produce one hash, and two seeds must
          produce different ones. The first property is what makes a result
          reproducible; the second is what stops a hash that ignores its input from
          passing as stable. Agreement across engines is checked in CI, against Chromium
          and Firefox.
        </CardDescription>
        {results.length > 0 ? (
          <CardAction>
            <Verdict passed={held} testId="determinism-verdict" size="lg">
              {held ? "Stable and seed dependent" : "Hashes disagree"}
            </Verdict>
          </CardAction>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <StatusNote tone="error" className="justify-between gap-4">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void check()}>
              <RotateCcw data-icon="inline-start" />
              Try again
            </Button>
          </StatusNote>
        ) : null}

        {running && results.length === 0 ? (
          <StatusNote tone="busy" data-testid="determinism-loading">
            Running {REPEATS * SEEDS.length} simulations.
          </StatusNote>
        ) : null}

        {results.length > 0 ? (
          <div className="overflow-x-auto">
            <Table data-testid="determinism-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Seed</TableHead>
                  <TableHead>State hash</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="text-right">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((result) => {
                  const unique = new Set(result.hashes).size;
                  return (
                    <TableRow key={String(result.seed)} data-testid="determinism-row">
                      <TableHead scope="row" className="tabular font-medium">
                        {String(result.seed)}
                      </TableHead>
                      <TableCell>
                        <code className="rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-[0.6875rem] text-foreground">
                          {result.hashes[0]}
                        </code>
                      </TableCell>
                      <TableCell className="tabular text-right text-muted-foreground">
                        {result.hashes.length}
                      </TableCell>
                      <TableCell className="text-right">
                        <Verdict passed={unique === 1}>
                          {unique === 1 ? "Identical" : `${unique} different hashes`}
                        </Verdict>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {/* a hash is only meaningful next to the core that produced it, so the build
            fingerprint sits with the result rather than only in the top bar */}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Produced by core{" "}
          <code className="rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-[0.6875rem] text-foreground">
            {coreVersion || "unknown"}
          </code>
          . Relaxed SIMD is reported in that string because its instructions may return
          different results for the same inputs, which would break every guarantee on
          this page.
        </p>
      </CardContent>
    </Card>
  );
};

export default DeterminismPanel;
