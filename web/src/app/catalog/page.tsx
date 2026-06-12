import { AlertTriangle, PackageSearch } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/forge";
import { getCatalogDedup, getConflicts } from "@/lib/forge-bridge";
import { CatalogTable } from "@/components/catalog/catalog-table";

// Live forge state (the unified GLOBAL catalog: the curated core library ∪ every
// federated source resource, with the deterministic dedup classification applied)
// — render on every request, never cache. This is the GLOBAL browse + library
// ADMIT lifecycle ONLY (Fix B): admit/revoke/verdict on federated SOURCE
// candidates, ride POST /api/catalog and call router.refresh(). SUBSCRIBE + ADOPT
// are PROJECT-plane actions and live on /browse — never here.
export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  // Two live, fail-soft reads (the bridge synthesizes an ok:false envelope rather
  // than throwing, so a degraded CLI surfaces as the error card below):
  //   1. the unified catalog (dedup-classified records — core ∪ all sources),
  //   2. the conflict set (ADR-0020) — surfaced as the per-row ⚖ marker. The
  //      GLOBAL catalog is UNFILTERED: it shows every catalog record regardless of
  //      any project's subscriptions. Subscription + composition (adopt) are
  //      PROJECT-plane concerns and are NOT read here.
  const [env, conflictsEnv] = await Promise.all([
    getCatalogDedup(),
    getConflicts(),
  ]);
  const records = env.ok ? env.data.records : [];
  const bridgeFailed = !env.ok;

  // Conflicted uids — uids with >= 2 distinct candidate records (ADR-0020). Drives
  // the per-row ⚖ affordance. We surface ALL conflicts (not just blocking ones),
  // since any conflict means this uid does not resolve to a single source. The full
  // adjudication lives on /conflicts.
  const conflictedUids: string[] = conflictsEnv.ok
    ? conflictsEnv.data.conflicts.map((c) => c.uid)
    : [];

  return (
    <PageShell
      title="Catalog"
      description="The unified global catalog — the curated core library ∪ federated source resources, plus the library admission lifecycle (ADR-0017)."
      scope="global"
      actions={
        <StatusPill tone="neutral" icon={<PackageSearch className="size-3" />}>
          {records.length} records
        </StatusPill>
      }
    >
      {bridgeFailed ? (
        <Card className="ring-1 ring-state-attention/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-mono text-sm text-state-attention">
              <AlertTriangle className="size-4" />
              Could not load the catalog
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs text-muted-foreground">
            {env.findings.length ? (
              env.findings.map((f, i) => <p key={i}>{f.message}</p>)
            ) : (
              <p>forge catalog dedup returned no data.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <CatalogTable
          mode="global"
          records={records}
          conflictedUids={conflictedUids}
        />
      )}
    </PageShell>
  );
}
