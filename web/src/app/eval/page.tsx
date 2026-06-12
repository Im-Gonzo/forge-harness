import { Info, AlertTriangle } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EvalWorkspace } from "@/components/eval/eval-workspace";
import type { EvalArtifact, EvalReportData } from "@/components/eval/types";
import { runForge, readEvalLedger, groupLedgerByUid } from "@/lib/forge-bridge";

// Live forge state — render on every request, never cache.
export const dynamic = "force-dynamic";

/** Criticality sort weight — higher is more urgent (unknown ⇒ lowest). */
const CRITICALITY_RANK: Record<string, number> = {
  safety: 3,
  compliance: 2,
  standard: 1,
};

function criticalityRank(c: string | undefined): number {
  return c ? (CRITICALITY_RANK[c] ?? 0) : 0;
}

export default async function EvalPage() {
  // The read-only coverage/grade report + the append-only ledger, in parallel.
  // The ledger is FAIL-SOFT (missing/empty ⇒ []), so it never blocks the page.
  const [envelope, ledger] = await Promise.all([
    runForge<EvalReportData>("eval-harness", ["--report"]),
    readEvalLedger(),
  ]);

  const bridgeFailed = !envelope.ok && envelope.bridgeError;
  const data = envelope.ok ? envelope.data : undefined;
  const coverage = data?.coverage;
  const allArtifacts = data?.artifacts ?? [];

  const covered = coverage?.covered ?? 0;
  const total = coverage?.total ?? 0;

  // Per-uid run history (most-recent-first) for the history + drill-down.
  const ledgerByUid = groupLedgerByUid(ledger);

  // Covered = artifacts that ship a golden set (the grade-table rows).
  // Coverage gaps = catalogued artifacts WITHOUT a golden set, sorted by
  // criticality (most urgent first) so the "author the eval" rail leads with
  // the riskiest uncovered artifacts.
  const covered_artifacts: EvalArtifact[] = allArtifacts.filter(
    (a) => a.hasGoldenSet,
  );
  const gaps: EvalArtifact[] = allArtifacts
    .filter((a) => !a.hasGoldenSet)
    .sort(
      (a, b) =>
        criticalityRank(b.criticality) - criticalityRank(a.criticality) ||
        a.uid.localeCompare(b.uid),
    );

  // Staleness: an artifact is stale when the hash it was graded against drifts
  // from the latest hash the ledger graded for that uid (registry hash !=
  // eval.graded_against_hash → "re-eval needed"). Derived per-uid, fail-soft.
  const staleByUid: Record<string, boolean> = {};
  for (const a of covered_artifacts) {
    const latest = ledgerByUid[a.uid]?.[0];
    const latestHash = latest?.aut_hash;
    const gradedAgainst = a.eval.graded_against_hash;
    staleByUid[a.uid] =
      Boolean(latestHash) &&
      Boolean(gradedAgainst) &&
      String(latestHash) !== String(gradedAgainst);
  }

  // Every artifact is "U" until a live reviewer run produces metrics.
  const allUnevaluated =
    covered_artifacts.length > 0 &&
    covered_artifacts.every(
      (a) => a.eval.grade === "U" || a.eval.grade === "UNEVALUATED",
    );

  return (
    <PageShell
      title="Eval"
      description="forge eval-harness --report — coverage + per-artifact grades."
      actions={
        <Badge variant="outline" className="font-mono text-[10px]">
          coverage {covered}/{total}
        </Badge>
      }
    >
      {bridgeFailed ? (
        <Card className="mb-4 border-red-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-mono text-sm text-red-500">
              <AlertTriangle className="size-4" />
              Bridge could not reach the forge CLI
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs text-muted-foreground">
            {envelope.findings.map((f, i) => (
              <p key={i}>{f.message}</p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {!bridgeFailed ? (
        <div className="flex flex-col gap-4">
          <EvalWorkspace
            report={data}
            artifacts={covered_artifacts}
            gaps={gaps}
            ledgerByUid={ledgerByUid}
            staleByUid={staleByUid}
          />

          {/* U-until-live note (server-rendered context, not interactive). */}
          {allUnevaluated ? (
            <Card className="border-border bg-muted/20">
              <CardContent className="flex items-start gap-2 py-3">
                <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                  All grades show{" "}
                  <span className="text-foreground">&ldquo;—&rdquo;</span> (grade
                  &ldquo;U&rdquo;, unevaluated). A grade is assigned only after a{" "}
                  <span className="text-foreground">live reviewer run</span> scores
                  each artifact&rsquo;s golden set — until then there is no metric to
                  report (rendered as an em-dash, never <code>0</code>).
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}
    </PageShell>
  );
}
