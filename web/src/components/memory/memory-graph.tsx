"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
} from "@xyflow/react";
import { Network, SearchIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MemoryEntry, MemoryVault } from "@/lib/forge-bridge";

import "./memory.css";
import { MEMORY_TYPE_COLORS, memoryTypeColor } from "./memory-colors";
import { MemoryNode, type MemoryNodeData } from "./memory-node";
import { MemorySearch } from "./memory-search";
import { MemoryTriage, type DanglingItem } from "./memory-triage";
import { MemoryDetailPanel, type LinkRef } from "./memory-detail-panel";
import {
  buildDegrees,
  buildForwardIndex,
  buildReverseIndex,
  findOrphans,
  ghostId,
  layoutGrid,
  layoutRadial,
  neighborhood,
  type FocusDepth,
} from "./memory-engine";

// Re-export the palette so existing importers of memory-graph keep working.
export { MEMORY_TYPE_COLORS, memoryTypeColor };

const nodeTypes = { memory: MemoryNode };
const DEPTH_OPTIONS: FocusDepth[] = [1, 2, "all"];

interface Props {
  /** The whole memory vault read server-side (entries + links + index). */
  data: MemoryVault;
}

/**
 * The /memory route as a read-only focus lens over the wiki-link graph. By
 * default it spotlights one entry's neighborhood (radial, centered) driven by
 * the search box; "Show all" renders the whole vault on a deterministic grid.
 * Mirrors graph/dependency-graph.tsx + graph/graph-workspace.tsx, collapsed
 * into one self-contained shell (the page renders this directly, with no
 * provider wrapper of its own — so we wrap ReactFlowProvider here).
 */
export function MemoryGraph({ data }: Props) {
  // Empty-vault state: a friendly message naming the vault dir.
  if (data.entries.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center font-mono">
        <Network className="size-9 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          No memory entries found
        </p>
        <p
          className="max-w-md truncate text-[10px] text-muted-foreground/70"
          title={data.vaultDir}
        >
          {data.vaultDir}
        </p>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <MemoryWorkspace data={data} />
    </ReactFlowProvider>
  );
}

/** Inner shell — needs to live under ReactFlowProvider for useReactFlow(). */
function MemoryWorkspace({ data }: Props) {
  const { entries, links } = data;

  // ── Pure indices (derived once per data change) ─────────────────────────
  const forwardIndex = useMemo(() => buildForwardIndex(links), [links]);
  const reverseIndex = useMemo(() => buildReverseIndex(links), [links]);
  const degrees = useMemo(() => buildDegrees(links), [links]);
  const orphans = useMemo(() => findOrphans(entries, links), [entries, links]);
  const orphanSet = useMemo(() => new Set(orphans), [orphans]);
  const entryById = useMemo(
    () => new Map(entries.map((e) => [e.id, e])),
    [entries],
  );
  const danglingItems: DanglingItem[] = useMemo(
    () =>
      links
        .filter((l) => !l.resolved)
        .map((l) => ({ source: l.source, rawTarget: l.target })),
    [links],
  );

  // ── Locally owned view state ────────────────────────────────────────────
  const [focusId, setFocusId] = useState<string | null>(null);
  const [depth, setDepth] = useState<FocusDepth>(1);
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── Build nodes/edges for the active mode ───────────────────────────────
  const { initialNodes, initialEdges } = useMemo(() => {
    if (showAll) {
      return buildFullFlow(entries, links, degrees, orphanSet);
    }
    if (focusId) {
      return buildFocusFlow(
        entries,
        links,
        focusId,
        depth,
        degrees,
        orphanSet,
        forwardIndex,
        reverseIndex,
      );
    }
    return { initialNodes: [] as Node[], initialEdges: [] as Edge[] };
  }, [
    showAll,
    focusId,
    depth,
    entries,
    links,
    degrees,
    orphanSet,
    forwardIndex,
    reverseIndex,
  ]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // ── Re-center after the node set settles ────────────────────────────────
  const { fitView, setCenter } = useReactFlow();
  useEffect(() => {
    if (initialNodes.length === 0) return;
    const id = requestAnimationFrame(() => {
      if (!showAll && focusId) {
        // Radial layout puts the focus node at the origin.
        void setCenter(0, 0, { zoom: 0.95, duration: 350 });
      } else {
        void fitView({ duration: 350, maxZoom: 1 });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [initialNodes, showAll, focusId, fitView, setCenter]);

  // ── Selection / focus actions ───────────────────────────────────────────
  const onNodeClick = useCallback((_: unknown, node: Node) => {
    // Ghost (dangling) nodes don't map to an entry — ignore the selection.
    if (node.id.startsWith("ghost:")) {
      setSelectedId(null);
      return;
    }
    setSelectedId(node.id);
  }, []);

  const focusHere = useCallback((id: string) => {
    setShowAll(false);
    setFocusId(id);
  }, []);

  const navigate = useCallback((id: string) => {
    setShowAll(false);
    setFocusId(id);
    setSelectedId(id);
  }, []);

  const expandNeighbors = useCallback(() => {
    setShowAll(false);
    setDepth((d) => (d === 1 ? 2 : "all"));
  }, []);

  const clearFocus = useCallback(() => {
    setSelectedId(null);
    setFocusId(null);
  }, []);

  // ── Selection details (derive; don't store the entry) ───────────────────
  const selectedEntry =
    selectedId &&
    initialNodes.some((n) => n.id === selectedId) &&
    entryById.has(selectedId)
      ? entryById.get(selectedId)!
      : null;

  const { outbound, inbound } = useMemo(() => {
    if (!selectedEntry) return { outbound: [] as LinkRef[], inbound: [] as LinkRef[] };
    const out: LinkRef[] = links
      .filter((l) => l.source === selectedEntry.id)
      .map((l) => ({
        id: l.target,
        label: l.resolved
          ? entryById.get(l.target)?.title ?? l.target
          : l.target,
        resolved: l.resolved,
      }));
    const inc: LinkRef[] = links
      .filter((l) => l.resolved && l.target === selectedEntry.id)
      .map((l) => ({
        id: l.source,
        label: entryById.get(l.source)?.title ?? l.source,
        resolved: true,
      }));
    return { outbound: out, inbound: inc };
  }, [selectedEntry, links, entryById]);

  const resolvedCount = useMemo(
    () => links.filter((l) => l.resolved).length,
    [links],
  );
  const emptyState = !showAll && !focusId;

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Triage rail: dangling links + orphans, click into focus. */}
      <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-border p-3 lg:block">
        <MemoryTriage
          orphans={orphans}
          dangling={danglingItems}
          entries={entries}
          onFocus={focusHere}
        />
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Search chrome drives the focus lens. */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <MemorySearch entries={entries} onSelect={focusHere} />
        </div>

        <div className="relative min-h-0 flex-1">
          <ReactFlow
            className="forge-memory-graph"
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onPaneClick={() => setSelectedId(null)}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={20} size={1} color="oklch(0.3 0 0)" />
            <Controls />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => {
                const d = n.data as MemoryNodeData;
                return d?.dangling
                  ? "oklch(0.7 0.19 22)"
                  : memoryTypeColor(d?.type);
              }}
              maskColor="oklch(0.145 0 0 / 0.7)"
            />

            {/* Mode + focus controls */}
            <Panel position="top-left">
              <div className="flex max-w-[520px] flex-col gap-2 rounded-lg border border-border bg-card/90 p-2 backdrop-blur">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    {showAll
                      ? "Full vault"
                      : focusId
                        ? "Focus lens"
                        : "No focus"}
                  </span>
                  <Button
                    variant={showAll ? "default" : "outline"}
                    size="sm"
                    className="h-6 font-mono text-[10px]"
                    onClick={() => {
                      setSelectedId(null);
                      setShowAll((v) => !v);
                    }}
                  >
                    {showAll ? "Exit show all" : "Show all"}
                  </Button>
                </div>

                {/* Depth control — only meaningful in focus mode */}
                {!showAll ? (
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      depth
                    </span>
                    <div className="inline-flex overflow-hidden rounded-md border border-border">
                      {DEPTH_OPTIONS.map((d) => {
                        const on = depth === d;
                        return (
                          <button
                            key={String(d)}
                            type="button"
                            onClick={() => setDepth(d)}
                            disabled={!focusId}
                            className="border-r border-border px-2 py-0.5 font-mono text-[10px] transition-colors last:border-r-0 disabled:opacity-40"
                            style={{
                              background: on ? "var(--accent)" : "transparent",
                              color: on
                                ? "var(--accent-foreground)"
                                : "var(--foreground)",
                            }}
                          >
                            {d === "all" ? "all" : d}
                          </button>
                        );
                      })}
                    </div>
                    {focusId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 font-mono text-[10px]"
                        onClick={clearFocus}
                      >
                        clear
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {/* Legend (color = memory type) */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {Object.entries(MEMORY_TYPE_COLORS)
                    .filter(([k]) => k !== "default")
                    .map(([type, color]) => (
                      <span
                        key={type}
                        className="inline-flex items-center gap-1 font-mono text-[9px] text-muted-foreground"
                      >
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{ background: color }}
                        />
                        {type}
                      </span>
                    ))}
                </div>
              </div>
            </Panel>

            {/* Counts */}
            <Panel position="top-right">
              <div className="flex flex-col items-end gap-1">
                <Badge
                  variant={danglingItems.length > 0 ? "destructive" : "outline"}
                  className="font-mono text-[10px]"
                >
                  {danglingItems.length} dangling
                </Badge>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {orphans.length} orphan{orphans.length === 1 ? "" : "s"}
                </Badge>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {entries.length} entries
                </Badge>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {resolvedCount} links
                </Badge>
                {!showAll && focusId ? (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {nodes.length} in view
                  </Badge>
                ) : null}
              </div>
            </Panel>
          </ReactFlow>

          {/* Node detail drawer */}
          {selectedEntry ? (
            <MemoryDetailPanel
              entry={selectedEntry}
              isOrphan={orphanSet.has(selectedEntry.id)}
              isFocus={selectedEntry.id === focusId}
              outbound={outbound}
              inbound={inbound}
              onClose={() => setSelectedId(null)}
              onFocusHere={() => focusHere(selectedEntry.id)}
              onExpandNeighbors={
                !showAll && selectedEntry.id === focusId
                  ? expandNeighbors
                  : undefined
              }
              onNavigate={navigate}
            />
          ) : null}

          {/* Empty (search-to-begin) state */}
          {emptyState ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center gap-2 text-center">
                <SearchIcon className="size-6 text-muted-foreground" />
                <p className="font-mono text-sm text-muted-foreground">
                  Search a memory entry to begin
                </p>
                <p className="max-w-[280px] font-mono text-[10px] text-muted-foreground/70">
                  Pick an entry from the search box to spotlight its wiki-link
                  neighborhood, or use &ldquo;Show all&rdquo; to see the whole
                  vault.
                </p>
              </div>
            </div>
          ) : null}

          {!emptyState && nodes.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="font-mono text-xs text-muted-foreground">
                {focusId && !entryById.has(focusId)
                  ? "That entry is no longer in the vault."
                  : "Nothing to show here."}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Focus-mode flow: a radial neighborhood around the focus entry + ghost targets.
// ──────────────────────────────────────────────────────────────────────────

function buildFocusFlow(
  entries: MemoryEntry[],
  links: import("@/lib/forge-bridge").MemoryLink[],
  focusId: string,
  depth: FocusDepth,
  degrees: Map<string, number>,
  orphanSet: Set<string>,
  forwardIndex: Record<string, string[]>,
  reverseIndex: Record<string, string[]>,
): { initialNodes: Node[]; initialEdges: Edge[] } {
  const { ids, edges: focusEdges, ghosts } = neighborhood(
    entries,
    links,
    focusId,
    depth,
    forwardIndex,
    reverseIndex,
  );
  if (ids.size === 0) return { initialNodes: [], initialEdges: [] };

  const positions = layoutRadial(
    focusId,
    ids,
    entries,
    forwardIndex,
    reverseIndex,
  );

  const nodes: Node[] = entries
    .filter((e) => ids.has(e.id))
    .map((e) => ({
      id: e.id,
      type: "memory",
      position: positions.get(e.id) ?? { x: 0, y: 0 },
      selected: e.id === focusId,
      data: {
        label: e.title,
        type: e.type,
        degree: degrees.get(e.id) ?? 0,
        confidence: e.confidence,
        orphan: orphanSet.has(e.id),
        focus: e.id === focusId,
      } satisfies MemoryNodeData,
    }));

  const edges: Edge[] = focusEdges.map((e) => ({
    id: `wl:${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    style: { stroke: "oklch(0.5 0 0)" },
  }));

  // Ghost (dangling) targets reachable from any included entry.
  appendGhosts(nodes, edges, ghosts);

  return { initialNodes: nodes, initialEdges: edges };
}

// ──────────────────────────────────────────────────────────────────────────
// Show-all flow: the whole vault on a deterministic grid + ghost targets.
// ──────────────────────────────────────────────────────────────────────────

function buildFullFlow(
  entries: MemoryEntry[],
  links: import("@/lib/forge-bridge").MemoryLink[],
  degrees: Map<string, number>,
  orphanSet: Set<string>,
): { initialNodes: Node[]; initialEdges: Edge[] } {
  const ids = new Set(entries.map((e) => e.id));
  const positions = layoutGrid(entries.map((e) => e.id));

  const nodes: Node[] = entries.map((e) => ({
    id: e.id,
    type: "memory",
    position: positions.get(e.id) ?? { x: 0, y: 0 },
    data: {
      label: e.title,
      type: e.type,
      degree: degrees.get(e.id) ?? 0,
      confidence: e.confidence,
      orphan: orphanSet.has(e.id),
    } satisfies MemoryNodeData,
  }));

  const edges: Edge[] = [];
  const ghosts: { source: string; rawTarget: string }[] = [];
  for (const l of links) {
    if (!ids.has(l.source)) continue;
    if (l.resolved) {
      edges.push({
        id: `wl:${l.source}->${l.target}`,
        source: l.source,
        target: l.target,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        style: { stroke: "oklch(0.5 0 0)" },
      });
    } else {
      ghosts.push({ source: l.source, rawTarget: l.target });
    }
  }

  appendGhosts(nodes, edges, ghosts);

  return { initialNodes: nodes, initialEdges: edges };
}

/**
 * Append red dashed ghost nodes (one per distinct unresolved target) + a red
 * dashed edge from each referrer to it. Mirrors the dependency-graph dangling
 * placeholder treatment.
 */
function appendGhosts(
  nodes: Node[],
  edges: Edge[],
  ghosts: { source: string; rawTarget: string }[],
): void {
  const seen = new Set<string>();
  for (const g of ghosts) {
    const id = ghostId(g.rawTarget);
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({
        id,
        type: "memory",
        position: { x: -320, y: nodes.length * 24 },
        data: {
          label: g.rawTarget,
          dangling: true,
        } satisfies MemoryNodeData,
      });
    }
    edges.push({
      id: `dangling:${g.source}->${g.rawTarget}`,
      source: g.source,
      target: id,
      className: "dangling",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: "oklch(0.7 0.19 22)",
      },
      style: { stroke: "oklch(0.7 0.19 22)" },
    });
  }
}
