import type { FC } from "react";
import { Check, Download, ExternalLink, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
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
    <Card aria-labelledby="result-heading" data-testid="sweep-result">
      <CardHeader>
        <CardTitle id="result-heading" className="flex items-center gap-2">
          Selected configuration
          {onFront ? (
            <Badge variant="secondary" className="gap-1 font-normal">
              <Check className="size-3 text-pass" aria-hidden />
              On the front
            </Badge>
          ) : (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              Dominated
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {onFront
            ? "Nothing in the search is better on both axes at once."
            : "Beaten on both axes by at least one other point. Shown so the shape of the tradeoff reads, but a point on the front is strictly better."}
        </CardDescription>
        <CardAction>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={onOpenReplay}>
              <ExternalLink data-icon="inline-start" />
              Open in replay
            </Button>
            <Button variant="outline" size="sm" onClick={onExportConfig}>
              <Download data-icon="inline-start" />
              Export config
            </Button>
            <Button variant="outline" size="sm" onClick={onExportReport}>
              <Download data-icon="inline-start" />
              Export report
            </Button>
          </div>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              What a player gets
              {comparedTo ? " vs compared" : ""}
            </h3>
            <dl className="divide-y divide-border" data-testid="result-metrics">
              {rows.map((row, i) => {
                const other = otherRows?.[i];
                const delta = other ? deltaLabel(row.value, other.value) : null;
                return (
                  <div key={row.label} className="py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-[0.8125rem]">{row.label}</dt>
                      <dd className="tabular flex items-baseline gap-2 text-[0.8125rem]">
                        {row.value}
                        {delta ? (
                          <span
                            className={cn(
                              "rounded px-1 py-0.5 text-xs",
                              delta.tone === "better"
                                ? "bg-pass/15 text-pass"
                                : "bg-destructive/15 text-destructive",
                            )}
                          >
                            {delta.text}
                          </span>
                        ) : null}
                      </dd>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{row.note}</p>
                  </div>
                );
              })}
            </dl>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              The configuration
            </h3>
            <dl className="divide-y divide-border" data-testid="result-config">
              {configRows(point.config).map((row) => (
                <div
                  key={row.label}
                  className="flex items-baseline justify-between gap-3 py-2"
                >
                  <dt className="text-[0.8125rem]">{row.label}</dt>
                  <dd className="tabular text-[0.8125rem]">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        {comparedTo ? (
          <div className="space-y-3 border-t border-border pt-5" data-testid="config-diff">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                What differs between the two
              </h3>
              <Button variant="ghost" size="sm" onClick={onClearComparison}>
                <X data-icon="inline-start" />
                Clear comparison
              </Button>
            </div>

            {configDiff.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                The two configurations are identical. Their results differ only by the
                seeds they ran on.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Setting</TableHead>
                      <TableHead>Selected</TableHead>
                      <TableHead>Compared</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {configDiff.map((row) => (
                      <TableRow key={row.label}>
                        <TableHead scope="row" className="font-normal">
                          {row.label}
                        </TableHead>
                        <TableCell className="tabular">{row.left}</TableCell>
                        <TableCell className="tabular text-data-compared">
                          {row.right}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <p className="text-xs leading-relaxed text-muted-foreground">
              Score gaps narrower than {RESOLUTION_FLOOR.toFixed(3)} are inside the
              run-to-run noise at this seed count, so a difference smaller than that is
              not a real one.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

export default SweepResult;
