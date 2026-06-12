import { Boxes, AlertTriangle } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRegistry, getValidation, runForge } from "@/lib/forge-bridge";
import { RegistryTable } from "@/components/registry/registry-table";
import type {
  CostByUid,
  DependentsByUid,
  FindingsByUid,
} from "@/components/registry/registry-helpers";
import type { AnalyzeData } from "@/app/budget/analyze-types";

// Live forge state — render on every request, never cache.
export const dynamic = "force-dynamic";

export default async function RegistryPage() {
  // Three live reads in parallel; each is fail-soft (the bridge synthesizes an
  // ok:false envelope rather than throwing), so a degraded analyze/validate
  // never blocks the catalog — the maps just come back empty for that source.
  const [registryEnv, analyzeEnv, validateEnv] = await Promise.all([
    getRegistry(),
    runForge<AnalyzeData>("analyze"),
    getValidation(),
  ]);

  const artifacts = registryEnv.ok ? registryEnv.data.artifacts : [];
  const bridgeFailed = !registryEnv.ok;

  // costByUid — join `forge analyze` artifacts onto the registry by uid. We keep
  // alwaysOn only for the always-on residency (the headline cost); other
  // residencies report null cost but still carry their residency label.
  const costByUid: CostByUid = {};
  if (analyzeEnv.ok) {
    for (const a of analyzeEnv.data.artifacts ?? []) {
      costByUid[a.uid] = {
        alwaysOn: a.residency === "always-on" ? a.estTokens : null,
        residency: a.residency ?? null,
      };
    }
  }

  // dependentsByUid — reverse index of dependsOn across ALL artifacts. Synthetic
  // "module:" dependency targets are not real artifacts, so we skip them.
  const dependentsByUid: DependentsByUid = {};
  for (const a of artifacts) {
    for (const dep of a.dependsOn ?? []) {
      if (dep.startsWith("module:")) continue;
      (dependentsByUid[dep] ??= []).push(a.uid);
    }
  }

  // findingsByUid — bucket `forge validate` findings by the artifact whose file
  // path they concern. Findings carry a repo-relative path; match it to the
  // artifact's `path` (hooks encode "hooks/hooks.json#<id>", so compare on the
  // path portion before any "#").
  const findingsByUid: FindingsByUid = {};
  if (validateEnv.findings.length) {
    const pathToUid = new Map<string, string>();
    for (const a of artifacts) {
      if (!a.path) continue;
      pathToUid.set(a.path.split("#")[0], a.uid);
    }
    for (const f of validateEnv.findings) {
      if (!f.path) continue;
      const uid = pathToUid.get(f.path.split("#")[0]);
      if (!uid) continue;
      (findingsByUid[uid] ??= []).push(f);
    }
  }

  return (
    <PageShell
      title="Registry"
      description="Artifact catalog over forge registry ls — uid / kind / version / status / criticality / modules / hash."
      actions={
        <Badge variant="outline" className="font-mono text-[10px]">
          <Boxes className="size-3" />
          {artifacts.length} artifacts
        </Badge>
      }
    >
      {bridgeFailed ? (
        <Card className="border-red-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-mono text-sm text-red-500">
              <AlertTriangle className="size-4" />
              Could not load the registry
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs text-muted-foreground">
            {registryEnv.findings.length ? (
              registryEnv.findings.map((f, i) => <p key={i}>{f.message}</p>)
            ) : (
              <p>forge registry ls returned no artifacts.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <RegistryTable
          artifacts={artifacts}
          costByUid={costByUid}
          dependentsByUid={dependentsByUid}
          findingsByUid={findingsByUid}
        />
      )}
    </PageShell>
  );
}
