import type { FC } from "react";
import StatusNote from "./status-note";
import Verdict from "./verdict";
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
import { TOLERANCE_MS, allPassed, type OracleRow } from "../verify/oracle";

interface OracleTableProps {
  rows: readonly OracleRow[];
  running: boolean;
}

const OracleTable: FC<OracleTableProps> = ({ rows, running }) => (
  <Card aria-labelledby="oracle-heading">
    <CardHeader>
      <CardTitle id="oracle-heading">The published reproduction</CardTitle>
      <CardDescription>
        Measured against Riot&apos;s published VALORANT figures. A different team and a
        different implementation, so agreement tests this one from outside rather than
        against itself.
      </CardDescription>
      {rows.length > 0 ? (
        <CardAction>
          <Verdict passed={allPassed(rows)} testId="oracle-verdict" size="lg">
            {allPassed(rows) ? "All three match" : "A row is outside tolerance"}
          </Verdict>
        </CardAction>
      ) : null}
    </CardHeader>

    <CardContent className="space-y-4">
      {running && rows.length === 0 ? (
        <StatusNote tone="busy" data-testid="oracle-loading">
          Measuring.
        </StatusNote>
      ) : null}

      {rows.length > 0 ? (
        <>
          <div className="overflow-x-auto">
            <Table data-testid="oracle-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Condition</TableHead>
                  <TableHead className="text-right">RTT</TableHead>
                  <TableHead className="text-right">Tick</TableHead>
                  <TableHead className="text-right">FPS</TableHead>
                  <TableHead className="text-right">Measured</TableHead>
                  <TableHead className="text-right">Published</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                  <TableHead className="text-right">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.label} data-testid="oracle-row">
                    <TableHead scope="row" className="font-normal">
                      <span className="block text-[0.8125rem] font-medium text-foreground">
                        {row.label}
                      </span>
                      <span className="mt-0.5 block max-w-64 text-xs font-normal text-muted-foreground">
                        {row.note}
                      </span>
                    </TableHead>
                    <TableCell className="tabular text-right">{row.rttMs} ms</TableCell>
                    <TableCell className="tabular text-right">{row.tickRate}</TableCell>
                    <TableCell className="tabular text-right">{row.clientFps}</TableCell>
                    {/* the measured figure is the claim, so it is the one that reads
                        loudest and the published one sits beside it as the reference */}
                    <TableCell className="tabular text-right text-sm font-medium">
                      {row.measuredMs.toFixed(1)} ms
                    </TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">
                      {row.publishedMs} ms
                    </TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">
                      {row.deltaMs >= 0 ? "+" : ""}
                      {row.deltaMs.toFixed(1)} ms
                    </TableCell>
                    <TableCell className="text-right">
                      <Verdict passed={row.passed}>
                        {row.passed ? "Pass" : "Fail"}
                      </Verdict>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Peeker&apos;s advantage is round trip plus two frames of server buffering
            and three of client buffering. A row passes when the measured figure is
            within {TOLERANCE_MS} ms of the published one. The article rounds every
            figure to the millisecond and says it hand-waves the buffering term, so the
            tolerance covers that. One frame is 7.8 ms at 128 tick, so an
            off-by-one-frame error is three times this and still fails.
          </p>
        </>
      ) : null}
    </CardContent>
  </Card>
);

export default OracleTable;
