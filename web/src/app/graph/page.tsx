import { PageShell } from "@/components/page-shell";
import { GraphWorkspace } from "@/components/graph/graph-workspace";
import {
  getRegistry,
  getDangling,
  getOrphans,
  readComposition,
} from "@/lib/forge-bridge";
import type { GraphData, CompositionData } from "@/components/graph/types";

// Live forge state — render on every request, never cache.
export const dynamic = "force-dynamic";

export default async function GraphPage() {
  // Dependency-graph payload (registry + dangling + orphans).
  const [registry, dangling, orphans] = await Promise.all([
    getRegistry(),
    getDangling(),
    getOrphans(),
  ]);

  const initialGraph: GraphData = {
    ok: registry.ok && dangling.ok && orphans.ok,
    ts: new Date().toISOString(),
    artifacts: registry.ok ? registry.data.artifacts : [],
    dangling: dangling.ok ? dangling.data.dangling : [],
    orphans: orphans.ok ? orphans.data.orphans : [],
    findings: [
      ...registry.findings,
      ...dangling.findings,
      ...orphans.findings,
    ],
    bridgeError:
      registry.bridgeError || dangling.bridgeError || orphans.bridgeError
        ? true
        : undefined,
  };

  // Composition-graph payload (profiles + modules manifests).
  let initialComposition: CompositionData;
  try {
    const { profiles, modules } = await readComposition();
    initialComposition = {
      ok: true,
      ts: new Date().toISOString(),
      profiles,
      modules,
    };
  } catch (err) {
    initialComposition = {
      ok: false,
      ts: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const danglingN = initialGraph.dangling.length;

  return (
    <PageShell
      title="Dependency & Composition Graph"
      description="Editable @xyflow/react graphs — resolve dangling refs · drag-to-assign modules/components."
    >
      <div className="-m-5 h-[calc(100%+2.5rem)]">
        <GraphWorkspace
          initialGraph={initialGraph}
          initialComposition={initialComposition}
        />
      </div>
      <span className="sr-only">
        {initialGraph.artifacts.length} artifacts, {danglingN} dangling
      </span>
    </PageShell>
  );
}
