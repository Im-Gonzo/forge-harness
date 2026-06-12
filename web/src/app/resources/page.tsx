/**
 * /resources — the LIBRARY BROWSER.
 *
 * The hub that lists every on-disk LIBRARY resource and links each row to its
 * editor. Server component: it reads each library kind through the bridge in
 * parallel, fail-soft per kind (a throw yields an empty list, never a broken
 * page), and hands the grouped entries to the client <ResourceBrowser>.
 *
 * Memory is NOT a library kind here — memory entries are project-local (managed
 * at /fleet/[id] Memory tab, explored read-only at /memory).
 *
 * The bridge is server-only — it is called HERE and the plain data is passed as
 * props; it is never imported into the client browser.
 */
import { Library } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { ResourceBrowser } from "@/components/resources/resource-browser";
import type { BrowserEntry } from "@/components/resources/resource-browser";
import { listResources } from "@/lib/forge-bridge";
import type { ResourceKind, ResourceListEntry } from "@/lib/types";

// Live disk state — render on every request, never cache.
export const dynamic = "force-dynamic";

// Library kinds. Memory is intentionally EXCLUDED: memory entries are
// project-local (managed per-project at /fleet/[id] Memory tab; explored
// read-only at /memory), so the library copy is always empty. The
// ResourceKind type still carries 'memory' — this list is UI-only.
const KINDS: readonly ResourceKind[] = [
  "agent",
  "skill",
  "command",
  "rule",
  "hook",
  "bundle",
  "workflow",
  "mcp",
];

/** Project a bridge list entry to the lean, client-safe row shape. */
function toBrowserEntry(entry: ResourceListEntry): BrowserEntry {
  const fm = entry.frontmatter as Record<string, unknown>;
  const description = typeof fm.description === "string" ? fm.description : "";
  return { id: entry.id, kind: entry.kind, description };
}

/** List one kind, fail-soft: any throw yields an empty list, never the page. */
async function listKind(kind: ResourceKind): Promise<BrowserEntry[]> {
  try {
    const entries = await listResources(kind);
    return entries.map(toBrowserEntry);
  } catch {
    return [];
  }
}

export default async function ResourcesPage() {
  const lists = await Promise.all(KINDS.map((kind) => listKind(kind)));

  const groups: Record<ResourceKind, BrowserEntry[]> = {
    agent: [],
    skill: [],
    command: [],
    rule: [],
    hook: [],
    bundle: [],
    memory: [],
    workflow: [],
    mcp: [],
  };
  KINDS.forEach((kind, i) => {
    groups[kind] = lists[i];
  });

  const total = lists.reduce((sum, list) => sum + list.length, 0);

  return (
    <PageShell
      title="Resources"
      description="Library browser — agents / skills / commands / rules / hooks / bundles / workflows / mcp. Pick a kind, search, then open the editor."
      actions={
        <Badge variant="outline" className="font-mono text-[10px]">
          <Library className="size-3" />
          {total} resources
        </Badge>
      }
    >
      <p className="mb-3 font-mono text-[11px] text-muted-foreground">
        Memory is project-local — manage entries in a project&apos;s{" "}
        <span className="text-foreground">Memory</span> tab at{" "}
        <span className="text-foreground">/fleet/[id]</span>, or browse them
        read-only at <span className="text-foreground">/memory</span>.
      </p>
      <ResourceBrowser groups={groups} />
    </PageShell>
  );
}
