import { AlertTriangle, SlidersHorizontal } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/forge";
import { getComposition, getTailoring } from "@/lib/forge-bridge";
import { TailoringView } from "@/components/tailoring/tailoring-view";

// Live forge state (the per-project TAILORING set: adopted resources carrying >= 1
// overlay, joined to their catalog records + a deterministic RESOLVED PREVIEW) —
// render on every request, never cache. A TAILORING OVERLAY is a per-adopted-
// resource modifier (ADR-0021): only an ADOPTED resource (in .forge/composition.json)
// may be tailored. Overlays are RECORDED INTENTIONS in a SEPARATE additive store
// (.forge/tailoring.json) — they are NEVER applied to real .claude/ files here (that
// is Slice 5). The CLI computes the resolved preview as a display-only VIEW.
//
// Mutations (add/remove an overlay) ride POST /api/tailoring and call
// router.refresh(), which re-runs this server read. We also read the COMPOSITION so
// the view can offer EVERY adopted resource as tailorable (not just those that
// already carry overlays), the same join the CLI does.
export const dynamic = "force-dynamic";

export default async function TailoringPage() {
  // Two fail-soft reads: the tailoring set itself (entries already carrying
  // overlays, joined to records + resolved), and the per-project COMPOSITION — so
  // the list can surface ALL adopted resources as "tailorable" even before they
  // carry any overlay. A bridge/CLI failure yields a non-ok envelope (never throws);
  // the page renders it as the error card below rather than crashing.
  const [env, compEnv] = await Promise.all([getTailoring(), getComposition()]);
  const bridgeFailed = !env.ok;
  const tailoredCount = env.ok ? env.data.counts.tailored : 0;

  // Adopted entries (uid, sourceId, kind, version, criticality) — the tailorable
  // universe. The view JOINs these to the already-tailored entries (by uid +
  // sourceId) so a resource with no overlays still appears, ready to tailor.
  const adopted = compEnv.ok ? compEnv.data.adopted : [];

  return (
    <PageShell
      title="Tailoring"
      description="Per-adopted-resource overlays — pin · override · gate · layer · fork · disable (ADR-0021). Recorded intentions in a separate store; the resolved preview is a display-only view, never applied here."
      actions={
        <StatusPill
          tone={tailoredCount > 0 ? "ok" : "neutral"}
          icon={<SlidersHorizontal className="size-3" />}
        >
          {tailoredCount} tailored
        </StatusPill>
      }
    >
      {bridgeFailed ? (
        <Card className="ring-1 ring-state-attention/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-mono text-sm text-state-attention">
              <AlertTriangle className="size-4" />
              Could not load the tailoring set
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs text-muted-foreground">
            {env.findings.length ? (
              env.findings.map((f, i) => <p key={i}>{f.message}</p>)
            ) : (
              <p>forge tailor list returned no data.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <TailoringView data={env.data} adopted={adopted} />
      )}
    </PageShell>
  );
}
