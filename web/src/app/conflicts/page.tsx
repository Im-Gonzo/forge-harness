import { AlertTriangle, Scale } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/forge";
import { getConflicts } from "@/lib/forge-bridge";
import { ConflictsView } from "@/components/conflicts/conflicts-view";

// Live forge state (the per-project CONFLICT set + adjudication policy) — render
// on every request, never cache. A CONFLICT is a uid with >= 2 distinct candidate
// records in the catalog READ-VIEW (dedup uid-collision / near-dup). The read path
// deterministically COLLECTS conflicts and CONSUMES already-recorded judge verdicts
// + eval scores; it invokes NO model and fabricates no score (ADR-0020).
//
// Mutations (resolve a winner — the human's T2 pick — and set the per-criticality
// policy) ride POST /api/conflicts and call router.refresh(), which re-runs this
// server read. A resolve that REPLACES an already-admitted library resource stays a
// deliberate human T2 action even under policy "auto" (BR-CAT-003).
export const dynamic = "force-dynamic";

export default async function ConflictsPage() {
  // Fail-soft: a bridge/CLI failure yields a non-ok envelope (never throws); the
  // page renders it as the error card below rather than crashing.
  const env = await getConflicts();
  const bridgeFailed = !env.ok;
  const blocking = env.ok ? env.data.counts.blocking : 0;

  return (
    <PageShell
      title="Conflicts"
      description="Adjudicate uids with >= 2 candidate records in the read-view (ADR-0020). Deterministic collection — consumes recorded judge verdicts + eval scores, never invokes a model."
      actions={
        <StatusPill
          tone={blocking > 0 ? "warn" : "ok"}
          icon={<Scale className="size-3" />}
        >
          {blocking} blocking
        </StatusPill>
      }
    >
      {bridgeFailed ? (
        <Card className="ring-1 ring-state-attention/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-mono text-sm text-state-attention">
              <AlertTriangle className="size-4" />
              Could not load the conflicts
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs text-muted-foreground">
            {env.findings.length ? (
              env.findings.map((f, i) => <p key={i}>{f.message}</p>)
            ) : (
              <p>forge conflict list returned no data.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <ConflictsView data={env.data} />
      )}
    </PageShell>
  );
}
