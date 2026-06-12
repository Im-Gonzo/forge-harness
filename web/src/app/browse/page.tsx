import { AlertTriangle, Layers, PackageSearch } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/forge";
import {
  getCatalogDedup,
  getComposition,
  getConflicts,
  getSlices,
  getTailoring,
} from "@/lib/forge-bridge";
import { CatalogTable } from "@/components/catalog/catalog-table";
import { SliceSubscriptions } from "@/components/browse/slice-subscriptions";

// The PROJECT-plane BROWSE & ADOPT surface (Fix B). Scoped to the SELECTED
// project: it lists the catalog filtered to this project's READ-VIEW (the curated
// core library ∪ the slices this project subscribes to, ADR-0018) with two
// project-plane actions — SUBSCRIBE (the slice panel) and ADOPT/Remove (the per-
// row composition action, ADR-0019). The library ADMIT lifecycle is a GLOBAL
// concern and lives on /catalog. Live state — render on every request, never
// cache; mutations ride POST /api/slices | /api/composition + router.refresh().
export const dynamic = "force-dynamic";

export default async function BrowsePage() {
  // Five live, fail-soft reads (the bridge synthesizes an ok:false envelope
  // rather than throwing, so a degraded CLI surfaces as the error card below):
  //   1. the unified catalog (dedup-classified records — core ∪ all sources),
  //   2. the per-project slice subscriptions — the SUBSCRIBE panel + the table's
  //      read-view filter (core ∪ subscribed source slices, ADR-0018),
  //   3. the per-project COMPOSITION — which read-view records this project has
  //      ADOPTED (ADR-0019). Drives the per-row Adopt/Remove toggle,
  //   4. the conflict set (ADR-0020) — the per-row ⚖ marker,
  //   5. tailoring (ADR-0021) — the per-row "tailored" chip.
  const [env, slicesEnv, compEnv, conflictsEnv, tailoringEnv] =
    await Promise.all([
      getCatalogDedup(),
      getSlices(),
      getComposition(),
      getConflicts(),
      getTailoring(),
    ]);
  const records = env.ok ? env.data.records : [];
  const bridgeFailed = !env.ok;

  // Flatten the subscribed slice ids to a flat set the client table filters by.
  const subscribedSlices: string[] = slicesEnv.ok
    ? slicesEnv.data.sources.flatMap((src) =>
        src.slices.filter((sl) => sl.subscribed).map((sl) => sl.id),
      )
    : [];

  // Adopted entry keys: "<sourceId|'lib'>:<uid>" — the same composite key the
  // client table derives per row to decide Adopt (not yet adopted) vs. Remove
  // (already adopted). null sourceId (library-local copy) maps to "lib".
  const adoptedKeys: string[] = compEnv.ok
    ? compEnv.data.adopted.map((e) => `${e.sourceId ?? "lib"}:${e.uid}`)
    : [];

  // Conflicted uids — uids with >= 2 distinct candidate records in the read-view
  // (ADR-0020). Drives the per-row ⚖ affordance. The full adjudication lives on
  // /conflicts.
  const conflictedUids: string[] = conflictsEnv.ok
    ? conflictsEnv.data.conflicts.map((c) => c.uid)
    : [];

  // Tailored entry keys ("<sourceId|'lib'>:<uid>") from `forge tailor list`
  // (ADR-0021) — an adopted resource carrying >= 1 overlay. Drives the dashed
  // "tailored" chip on the rows; tailoring is managed on /tailoring.
  const tailoredKeys: string[] = tailoringEnv.ok
    ? tailoringEnv.data.tailored.map((t) => `${t.sourceId ?? "lib"}:${t.uid}`)
    : [];

  return (
    <PageShell
      title="Browse & Adopt"
      description="This project's read-view — the curated core library ∪ the source slices it subscribes to. Subscribe to slices, then adopt resources into the composition (ADR-0018/0019)."
      actions={
        <div className="flex items-center gap-2">
          <StatusPill tone="neutral" icon={<Layers className="size-3" />}>
            {subscribedSlices.length} subscribed slice
            {subscribedSlices.length === 1 ? "" : "s"}
          </StatusPill>
          <StatusPill tone="neutral" icon={<PackageSearch className="size-3" />}>
            {records.length} catalog records
          </StatusPill>
        </div>
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
        <div className="flex flex-col gap-6">
          {/* SUBSCRIBE — the per-source slice grid (moved off /sources). Scopes
              this project's read-view: core resources always appear; a source's
              resources appear once its slice is subscribed. */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
              source slices · subscribe
            </h2>
            <SliceSubscriptions
              data={
                slicesEnv.ok
                  ? slicesEnv.data
                  : { subscriptionsPath: "", sources: [] }
              }
            />
          </section>

          {/* ADOPT — the read-view catalog (core ∪ subscribed slices) with the
              per-row Adopt/Remove composition action. */}
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
              read-view · adopt into composition
            </h2>
            <CatalogTable
              mode="project"
              records={records}
              subscribedSlices={subscribedSlices}
              adoptedKeys={adoptedKeys}
              conflictedUids={conflictedUids}
              tailoredKeys={tailoredKeys}
            />
          </section>
        </div>
      )}
    </PageShell>
  );
}
