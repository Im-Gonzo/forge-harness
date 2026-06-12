import { AlertTriangle, Layers } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/forge";
import { getComposition, getConflicts, getTailoring } from "@/lib/forge-bridge";
import { CompositionView } from "@/components/composition/composition-view";

// Live forge state (the per-project COMPOSITION: the set of read-view resources
// this project has ADOPTED, joined to their catalog records) — render on every
// request, never cache. Mutations (adopt on /browse, remove here) ride POST
// /api/composition and call router.refresh(), which re-runs this server read.
//
// COMPOSITION is a SEPARATE, additive layer from the global library: adopt !=
// admit — it records a per-project selection in .forge/composition.json and never
// writes the library or runs the admission/T2 gate (ADR-0019).
export const dynamic = "force-dynamic";

export default async function CompositionPage() {
  // Two fail-soft reads: the composition itself, and the per-project CONFLICT set
  // (ADR-0020). The conflict read drives the Slice 3 SEAM — when any conflict is
  // BLOCKING (state === "blocking"), the composition is not yet resolvable and the
  // banner flips to the attention-toned "Composition blocked — N conflict(s)" form
  // (link to /conflicts). The blocking uids also mark their rows with the ⚖
  // affordance. A bridge/CLI failure yields a non-ok envelope (never throws).
  const [env, conflictsEnv, tailoringEnv] = await Promise.all([
    getComposition(),
    getConflicts(),
    getTailoring(),
  ]);
  const bridgeFailed = !env.ok;
  const adoptedCount = env.ok ? env.data.counts.adopted : 0;

  // Blocking conflicts gate the composition. Surface only the count + the set of
  // conflicted uids (for the ⚖ row marker); the full adjudication lives on /conflicts.
  const blockingCount = conflictsEnv.ok ? conflictsEnv.data.counts.blocking : 0;
  const conflictedUids: string[] = conflictsEnv.ok
    ? conflictsEnv.data.conflicts
        .filter((c) => c.state === "blocking")
        .map((c) => c.uid)
    : [];

  // Slice 4 SEAM — tailored entry keys ("<sourceId|'lib'>:<uid>") from
  // `forge tailor list` (ADR-0021). Drives the dashed, project-toned "tailored"
  // chip on the adopted rows. A tailored resource carries >= 1 overlay (a recorded
  // intention in .forge/tailoring.json) — the chip is a marker, never an action;
  // tailoring is managed on /tailoring. Also feeds the "tailored" stat panel.
  const tailoredKeys: string[] = tailoringEnv.ok
    ? tailoringEnv.data.tailored.map((t) => `${t.sourceId ?? "lib"}:${t.uid}`)
    : [];

  return (
    <PageShell
      title="Composition"
      description="The per-project set of resources adopted from the catalog read-view (ADR-0019). Additive — adopt never touches the library."
      actions={
        <StatusPill tone="neutral" icon={<Layers className="size-3" />}>
          {adoptedCount} adopted
        </StatusPill>
      }
    >
      {bridgeFailed ? (
        <Card className="ring-1 ring-state-attention/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-mono text-sm text-state-attention">
              <AlertTriangle className="size-4" />
              Could not load the composition
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs text-muted-foreground">
            {env.findings.length ? (
              env.findings.map((f, i) => <p key={i}>{f.message}</p>)
            ) : (
              <p>forge compose list returned no data.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <CompositionView
          data={env.data}
          blockingCount={blockingCount}
          conflictedUids={conflictedUids}
          tailoredKeys={tailoredKeys}
        />
      )}
    </PageShell>
  );
}
