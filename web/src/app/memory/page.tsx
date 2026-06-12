import { Database } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { MemoryGraph } from "@/components/memory/memory-graph";
import { MemoryVaultDashboard } from "@/components/memory/memory-vault-dashboard";
import { MemoryCurate } from "@/components/memory/memory-curate";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { readMemoryVault, readProjectMemoryVault } from "@/lib/forge-bridge";
import { analyzeCuration } from "@/lib/forge-bridge/memory-vault";
import { getActiveHarness } from "@/lib/harness";

// Live on-disk vault state — render on every request, never cache.
export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  // PRIMARY (#6 scope fix): the SELECTED PROJECT's `forge` memory, read through
  // the scoped CLI (cwd = getActiveRoot). With a project selected this shows
  // THAT project's entries (e.g. research/'s 2 entries), not the empty global
  // vault. SECONDARY: the global ~/.claude/memory-vault, kept as a labeled tab
  // only when it actually has entries. Both reads are fail-soft (never throw).
  const [harness, project, global] = await Promise.all([
    getActiveHarness(),
    readProjectMemoryVault(),
    readMemoryVault(),
  ]);

  // Read-only curation reports computed server-side (pure; never writes).
  const projectAnalysis = analyzeCuration(project);
  const globalAnalysis = analyzeCuration(global);

  const isProject = harness.kind === "project";
  const scopeLabel = isProject ? harness.label : "Library";
  // Only surface the global vault as a secondary tab when it is non-empty —
  // otherwise it is noise (the global vault is empty on most machines).
  const showGlobal = global.entries.length > 0;

  return (
    <PageShell
      title="Memory Vault"
      description={`${
        isProject ? `${scopeLabel}'s` : "Library"
      } memory — entries cross-linked into a graph, with a vault inventory and curation preview.`}
      actions={
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">
            {project.entries.length}{" "}
            {project.entries.length === 1 ? "entry" : "entries"}
          </Badge>
          <Badge
            variant={isProject ? "default" : "outline"}
            className="font-mono text-[10px]"
          >
            {scopeLabel}
          </Badge>
        </div>
      }
    >
      {/* Full-height, edge-to-edge wrapper so the Graph tab's @xyflow/react
          canvas has a sized parent to fill — mirrors the /graph route. The
          Tabs root fills it; only the Graph panel is a sized canvas, the
          Vault/Curate panels scroll within their own region. */}
      <div className="-m-5 h-[calc(100%+2.5rem)]">
        <Tabs defaultValue="graph" className="flex h-full flex-col gap-0">
          <div className="flex items-center border-b border-border px-4 py-2">
            <TabsList>
              <TabsTrigger value="graph">Graph</TabsTrigger>
              <TabsTrigger value="vault">Vault</TabsTrigger>
              <TabsTrigger value="curate">Curate</TabsTrigger>
              {showGlobal ? (
                <TabsTrigger value="global">
                  Global
                  <Badge variant="secondary" className="ml-1.5 text-[9px]">
                    {global.entries.length}
                  </Badge>
                </TabsTrigger>
              ) : null}
            </TabsList>
          </div>

          {/* Graph — keeps a sized full-height canvas (project-scoped). */}
          <TabsContent value="graph" className="min-h-0 flex-1">
            <div className="h-full min-h-0">
              {project.entries.length > 0 ? (
                <MemoryGraph data={project} />
              ) : (
                <EmptyProjectMemory scopeLabel={scopeLabel} isProject={isProject} />
              )}
            </div>
          </TabsContent>

          {/* Vault — scrollable inventory (project-scoped). */}
          <TabsContent value="vault" className="min-h-0 flex-1">
            <MemoryVaultDashboard data={project} />
          </TabsContent>

          {/* Curate — scrollable, read-only curation preview (project-scoped). */}
          <TabsContent value="curate" className="min-h-0 flex-1">
            <MemoryCurate data={project} analysis={projectAnalysis} />
          </TabsContent>

          {/* Global — the secondary ~/.claude/memory-vault, only when non-empty. */}
          {showGlobal ? (
            <TabsContent value="global" className="min-h-0 flex-1">
              <MemoryCurate data={global} analysis={globalAnalysis} />
            </TabsContent>
          ) : null}
        </Tabs>
      </div>
      <span className="sr-only">
        {project.entries.length} entries, {project.links.length} links in{" "}
        {scopeLabel}
      </span>
    </PageShell>
  );
}

/** Clear empty state for a scope with no memory entries on disk. */
function EmptyProjectMemory({
  scopeLabel,
  isProject,
}: {
  scopeLabel: string;
  isProject: boolean;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center font-mono">
      <Database className="size-9 text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">
        No memory entries in {scopeLabel}
      </p>
      <p className="max-w-md text-[11px] text-muted-foreground/70">
        {isProject
          ? "This project's `.claude/memory` has no entries yet. Add one with `forge memory add`, or seed from another vault with `forge memory import`."
          : "Select a project to view its memory, or add an entry with `forge memory add`."}
      </p>
    </div>
  );
}
