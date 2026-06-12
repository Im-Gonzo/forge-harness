"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EvalGradeTable } from "@/components/eval/grade-table";
import { EvalRunControls } from "@/components/eval/eval-run-controls";
import { EvalHistory } from "@/components/eval/eval-history";
import { EvalCoverageGaps } from "@/components/eval/eval-coverage-gaps";
import type { EvalArtifact, EvalReportData } from "@/components/eval/types";
import type { EvalLedgerRecord } from "@/lib/forge-bridge";

interface EvalWorkspaceProps {
  /** The `forge eval-harness --report` payload (undefined when the report failed). */
  report?: EvalReportData;
  /** Covered artifacts (ship a golden set) — the grade-table rows. */
  artifacts: EvalArtifact[];
  /** Uncovered artifacts (no golden set), pre-sorted by criticality. */
  gaps: EvalArtifact[];
  /** Per-uid run history from the append-only ledger, most-recent-first. */
  ledgerByUid: Record<string, EvalLedgerRecord[]>;
  /** uid → true when the graded-against hash has drifted (re-eval needed). */
  staleByUid?: Record<string, boolean>;
  /** The honest, copy-able MANUAL model-reviewer command (surfaced, never run). */
  manualCommand?: string;
}

/**
 * Client state container for the /eval cockpit — mirrors GraphWorkspace /
 * BudgetWorkspace: server props seed the view, a single piece of owned state
 * drives the leaves, and a soft re-nav re-reads fresh server data.
 *
 * Owns the SHARED RUN CONTRACT:
 *   runningTarget — the uid currently grading, or "--all"/"--changed", or null.
 *   onRun(target) — POSTs to /api/eval to trigger the SAFE deterministic
 *                   grading pass (`eval-harness <target>` — code grader + ledger
 *                   append, NEVER a model call). Sets runningTarget for the
 *                   duration, then router.refresh() re-reads report + ledger.
 *
 * Leaf components receive { onRun, runningTarget } and render their own
 * triggers/spinners against it; EvalWorkspace is the single owner.
 */
export function EvalWorkspace({
  report,
  artifacts,
  gaps,
  ledgerByUid,
  staleByUid,
  manualCommand,
}: EvalWorkspaceProps) {
  const router = useRouter();
  const [runningTarget, setRunningTarget] = useState<string | null>(null);

  const onRun = useCallback(
    async (target: string) => {
      // Guard against concurrent runs — one grading pass at a time.
      if (runningTarget !== null) return;
      setRunningTarget(target);
      try {
        await fetch("/api/eval", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target }),
          cache: "no-store",
        });
      } catch {
        // Fail-soft: the refresh below re-reads authoritative server state, so a
        // dropped POST surfaces as "no change" rather than a thrown error.
      } finally {
        setRunningTarget(null);
        // Re-read the --report envelope + the ledger from the server.
        router.refresh();
      }
    },
    [runningTarget, router],
  );

  const coverage = report?.coverage;
  const covered = coverage?.covered ?? 0;
  const total = coverage?.total ?? 0;
  const ratioPct =
    coverage && total > 0
      ? Math.round((coverage.ratio ?? covered / total) * 100)
      : 0;
  const evaluated = report?.health.evaluated ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Coverage summary (kept from the server page). */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Card className="flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              Golden-set coverage
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="font-mono text-3xl font-semibold leading-none tracking-tight">
              {covered}
              <span className="text-muted-foreground">/{total}</span>
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              {ratioPct}% of catalogued artifacts ship a golden set
            </p>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${ratioPct}%` }}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              Evaluated
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="font-mono text-3xl font-semibold leading-none tracking-tight">
              {evaluated}
              <span className="text-muted-foreground">/{covered}</span>
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              artifacts with a graded live reviewer run
            </p>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">
              <FlaskConical className="size-3" />
              Harness eval
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="font-mono text-xs text-foreground">
              Behavioral eval of agents/skills against their golden sets.
            </p>
            <p className="font-mono text-[11px] text-muted-foreground">
              Run live with{" "}
              <code className="text-foreground">forge eval-harness --all</code>.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Global run controls + the honest manual command block. */}
      <EvalRunControls
        onRun={onRun}
        runningTarget={runningTarget}
        manualCommand={manualCommand}
      />

      {/* Per-artifact grades — triage + per-row run + drill-down. */}
      <div className="flex flex-col gap-2">
        <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
          Per-artifact grades
        </h2>
        {artifacts.length ? (
          <EvalGradeTable
            artifacts={artifacts}
            onRun={onRun}
            runningTarget={runningTarget}
            ledgerByUid={ledgerByUid}
            staleByUid={staleByUid}
          />
        ) : (
          <Card>
            <CardContent className="py-6 font-mono text-xs text-muted-foreground">
              No artifacts ship a golden set yet.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Run history (ledger) + coverage gaps. */}
      <EvalHistory ledgerByUid={ledgerByUid} />
      <EvalCoverageGaps gaps={gaps} />
    </div>
  );
}
