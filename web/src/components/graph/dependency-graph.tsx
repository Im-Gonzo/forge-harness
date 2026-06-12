"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
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
import { SearchIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { ArtifactNode, type ArtifactNodeData } from "./artifact-node";
import { ResolveDanglingDialog } from "./resolve-dangling-dialog";
import { NodeDetailPanel } from "./node-detail-panel";
import { layoutByKind, layoutRadial } from "./layout";
import {
  buildReverseIndex,
  neighborhood,
  type FocusDepth,
} from "./focus-engine";
import {
  ALL_KINDS,
  KIND_COLORS,
  type GraphData,
  type RegistryArtifact,
  type DanglingRef,
} from "./types";

const nodeTypes = { artifact: ArtifactNode };

const DEPTH_OPTIONS: FocusDepth[] = [1, 2, "all"];

/** A graph edge can be a resolved dependsOn edge or a dangling (red) edge. */
interface EdgeMeta {
  dangling?: DanglingRef;
}

const noop = () => {};

interface Props {
  /** /api/graph payload. */
  data: GraphData;
  /** Refetch /api/graph after a successful resolve. */
  onRefetch: () => void;
  /** The centered artifact; null => empty "search to begin" state (unless showAll). */
  focusUid?: string | null;
  /** Node "Focus here" / clear-focus → lifts to the workspace. */
  onFocusChange?: (uid: string | null) => void;
}

/**
 * The dependency canvas as a FOCUS LENS. By default it spotlights a single
 * artifact's neighborhood (computed by the pure focus-engine, laid out radially
 * and centered). "Show all" is the escape hatch back to the full kind-columned
 * graph + dangling placeholders + resolve flow. Depth, show-all, and the
 * selected (detail-panel) node are owned locally; focus is lifted to the
 * workspace so the search box can drive it.
 */
export function DependencyGraph({
  data,
  onRefetch,
  focusUid = null,
  onFocusChange = noop,
}: Props) {
  const artifacts = data.artifacts;
  const orphanSet = useMemo(() => new Set(data.orphans), [data.orphans]);
  const reverseIndex = useMemo(
    () => buildReverseIndex(artifacts),
    [artifacts],
  );

  // ── Locally owned state ────────────────────────────────────────────────
  const [depth, setDepth] = useState<FocusDepth>(1);
  const [showAll, setShowAll] = useState(false);

  // ── Build nodes/edges for the active mode ──────────────────────────────
  // Focus mode = a centered neighborhood; show-all mode = the full graph with
  // dangling placeholders (today's behavior, preserved as the escape hatch).
  const { initialNodes, initialEdges } = useMemo(() => {
    if (showAll) {
      return buildFullFlow(artifacts, orphanSet, data.dangling);
    }
    if (focusUid) {
      return buildFocusFlow(
        artifacts,
        orphanSet,
        focusUid,
        depth,
        reverseIndex,
      );
    }
    return { initialNodes: [] as Node[], initialEdges: [] as Edge[] };
  }, [showAll, focusUid, depth, artifacts, orphanSet, data.dangling, reverseIndex]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Re-seed whenever the active node set changes.
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // ── Re-center after the node set settles ───────────────────────────────
  const { fitView, setCenter } = useReactFlow();
  useEffect(() => {
    if (initialNodes.length === 0) return;
    // Wait a frame so React Flow has the fresh nodes before we move the view.
    const id = requestAnimationFrame(() => {
      if (!showAll && focusUid) {
        // Radial layout puts the focus node at the origin; center there.
        void setCenter(0, 0, { zoom: 0.9, duration: 350 });
      } else {
        void fitView({ duration: 350, maxZoom: 1 });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [initialNodes, showAll, focusUid, fitView, setCenter]);

  // ── Selection (detail panel) ───────────────────────────────────────────
  const [selectedArtifact, setSelectedArtifact] =
    useState<RegistryArtifact | null>(null);
  const [resolveTarget, setResolveTarget] = useState<DanglingRef | null>(null);

  // Derive (don't store) whether the selection still lives in the active view —
  // when the node set changes, a selection whose node left simply stops showing.
  const visibleSelection =
    selectedArtifact && initialNodes.some((n) => n.id === selectedArtifact.uid)
      ? selectedArtifact
      : null;

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const art = artifacts.find((a) => a.uid === node.id);
      setSelectedArtifact(art ?? null);
    },
    [artifacts],
  );

  const onEdgeClick = useCallback((_: unknown, edge: Edge) => {
    const meta = edge.data as EdgeMeta | undefined;
    if (meta?.dangling) setResolveTarget(meta.dangling);
  }, []);

  // ── Focus actions wired to the detail panel ────────────────────────────
  const focusHere = useCallback(
    (uid: string) => {
      setShowAll(false);
      onFocusChange(uid);
    },
    [onFocusChange],
  );

  const expandNeighbors = useCallback(() => {
    // Step depth out one ring (1 → 2 → all), so neighbors come into view.
    setShowAll(false);
    setDepth((d) => (d === 1 ? 2 : "all"));
  }, []);

  const clearFocus = useCallback(() => {
    setSelectedArtifact(null);
    onFocusChange(null);
  }, [onFocusChange]);

  const danglingCount = data.dangling.length;
  const focusArtifact = focusUid
    ? artifacts.find((a) => a.uid === focusUid) ?? null
    : null;

  // ── Empty (search-to-begin) state ──────────────────────────────────────
  const emptyState = !showAll && !focusUid;

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        className="forge-graph"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => setSelectedArtifact(null)}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={20} size={1} color="oklch(0.3 0 0)" />
        <Controls />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) =>
            (KIND_COLORS[(n.data as ArtifactNodeData)?.kind] ??
              "var(--muted-foreground)") as string
          }
          maskColor="oklch(0.145 0 0 / 0.7)"
        />

        {/* Mode + focus controls */}
        <Panel position="top-left">
          <div className="flex max-w-[520px] flex-col gap-2 rounded-lg border border-border bg-card/90 p-2 backdrop-blur">
            {/* Show-all escape hatch */}
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {showAll ? "Full graph" : focusUid ? "Focus lens" : "No focus"}
              </span>
              <Button
                variant={showAll ? "default" : "outline"}
                size="sm"
                className="h-6 font-mono text-[10px]"
                onClick={() => {
                  setSelectedArtifact(null);
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
                        disabled={!focusUid}
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
                {focusUid ? (
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

            {/* Legend (color = kind) */}
            <div className="flex flex-wrap items-center gap-1.5">
              {ALL_KINDS.map((kind) => (
                <span
                  key={kind}
                  className="inline-flex items-center gap-1 font-mono text-[9px] text-muted-foreground"
                >
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ background: KIND_COLORS[kind] }}
                  />
                  {kind}
                </span>
              ))}
            </div>
          </div>
        </Panel>

        {/* Counts + dangling summary (full graph only surfaces the resolve hint) */}
        <Panel position="top-right">
          <div className="flex flex-col items-end gap-1">
            <Badge
              variant={danglingCount > 0 ? "destructive" : "outline"}
              className="font-mono text-[10px]"
            >
              {danglingCount} dangling ref{danglingCount === 1 ? "" : "s"}
            </Badge>
            <Badge variant="outline" className="font-mono text-[10px]">
              {data.orphans.length} orphan
              {data.orphans.length === 1 ? "" : "s"}
            </Badge>
            <Badge variant="outline" className="font-mono text-[10px]">
              {artifacts.length} artifacts
            </Badge>
            {!showAll && focusUid ? (
              <Badge variant="secondary" className="font-mono text-[10px]">
                {nodes.length} in view
              </Badge>
            ) : null}
            {showAll && danglingCount > 0 ? (
              <p className="mt-1 max-w-[180px] text-right font-mono text-[9px] text-muted-foreground">
                Click a red dashed edge to resolve it.
              </p>
            ) : null}
          </div>
        </Panel>
      </ReactFlow>

      {/* Node detail drawer with focus actions */}
      {visibleSelection ? (
        <NodeDetailPanel
          artifact={visibleSelection}
          isOrphan={orphanSet.has(visibleSelection.uid)}
          onClose={() => setSelectedArtifact(null)}
          isFocus={visibleSelection.uid === focusUid}
          onFocusHere={() => focusHere(visibleSelection.uid)}
          onExpandNeighbors={
            !showAll && visibleSelection.uid === focusUid
              ? expandNeighbors
              : undefined
          }
        />
      ) : null}

      {/* Resolve-dangling dialog */}
      <ResolveDanglingDialog
        target={resolveTarget}
        artifacts={artifacts}
        onClose={() => setResolveTarget(null)}
        onResolved={() => {
          setResolveTarget(null);
          onRefetch();
        }}
      />

      {/* Empty / no-result states */}
      {emptyState ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-center">
            <SearchIcon className="size-6 text-muted-foreground" />
            <p className="font-mono text-sm text-muted-foreground">
              Search an artifact to begin
            </p>
            <p className="max-w-[260px] font-mono text-[10px] text-muted-foreground/70">
              Pick an artifact from the search box to spotlight its
              dependencies, or use &ldquo;Show all&rdquo; to see the full graph.
            </p>
          </div>
        </div>
      ) : null}

      {!emptyState && nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="font-mono text-xs text-muted-foreground">
            {focusUid && !focusArtifact
              ? "That artifact is no longer in the registry."
              : "Nothing to show here."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Focus-mode flow: a radial neighborhood around the focus node.
// ──────────────────────────────────────────────────────────────────────────

function buildFocusFlow(
  artifacts: RegistryArtifact[],
  orphanSet: Set<string>,
  focusUid: string,
  depth: FocusDepth,
  reverseIndex: Record<string, string[]>,
): { initialNodes: Node[]; initialEdges: Edge[] } {
  const { uids, edges: focusEdges } = neighborhood(
    artifacts,
    focusUid,
    depth,
    reverseIndex,
  );
  if (uids.size === 0) {
    return { initialNodes: [], initialEdges: [] };
  }

  const positions = layoutRadial(focusUid, uids, artifacts, reverseIndex);

  const nodes: Node[] = artifacts
    .filter((a) => uids.has(a.uid))
    .map((a) => ({
      id: a.uid,
      type: "artifact",
      position: positions.get(a.uid) ?? { x: 0, y: 0 },
      selected: a.uid === focusUid,
      data: {
        label: a.id,
        kind: a.kind,
        orphan: orphanSet.has(a.uid),
      } satisfies ArtifactNodeData,
    }));

  const edges: Edge[] = focusEdges.map((e) => ({
    id: `dep:${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    style: { stroke: "oklch(0.5 0 0)" },
  }));

  return { initialNodes: nodes, initialEdges: edges };
}

// ──────────────────────────────────────────────────────────────────────────
// Show-all flow: the full kind-columned graph + dangling placeholders.
// (Preserves the pre-lens behavior as the escape hatch.)
// ──────────────────────────────────────────────────────────────────────────

function buildFullFlow(
  artifacts: RegistryArtifact[],
  orphanSet: Set<string>,
  dangling: DanglingRef[],
): { initialNodes: Node[]; initialEdges: Edge[] } {
  const visibleUids = new Set(artifacts.map((a) => a.uid));

  // Position artifact nodes by kind columns.
  const positions = layoutByKind(
    artifacts.map((a) => ({ id: a.uid, kind: a.kind })),
    [...ALL_KINDS],
  );

  const nodes: Node[] = artifacts.map((a) => ({
    id: a.uid,
    type: "artifact",
    position: positions.get(a.uid) ?? { x: 0, y: 0 },
    data: {
      label: a.id,
      kind: a.kind,
      orphan: orphanSet.has(a.uid),
    } satisfies ArtifactNodeData,
  }));

  const edges: Edge[] = [];

  // Resolved dependsOn edges (module: targets are synthetic — skip them).
  for (const a of artifacts) {
    for (const dep of a.dependsOn ?? []) {
      if (dep.startsWith("module:")) continue;
      if (!visibleUids.has(dep)) continue;
      edges.push({
        id: `dep:${a.uid}->${dep}`,
        source: a.uid,
        target: dep,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        style: { stroke: "oklch(0.5 0 0)" },
      });
    }
  }

  // Dangling edges: synthesize a red placeholder target node + a red edge from
  // the referrer (`from`) to it.
  const placeholderSeen = new Set<string>();
  for (const d of dangling) {
    if (!visibleUids.has(d.from)) continue;

    const placeholderId = `dangling:${d.rawRef}`;
    if (!placeholderSeen.has(placeholderId)) {
      placeholderSeen.add(placeholderId);
      nodes.push({
        id: placeholderId,
        type: "artifact",
        position: { x: -300, y: nodes.length * 20 },
        data: {
          label: d.rawRef,
          kind: d.refKind || "link",
          dangling: true,
        } satisfies ArtifactNodeData,
      });
    }
    edges.push({
      id: `dangling:${d.from}->${d.rawRef}`,
      source: d.from,
      target: placeholderId,
      className: "dangling",
      label: "dangling",
      labelStyle: { fill: "oklch(0.7 0.19 22)", fontSize: 9 },
      labelBgStyle: { fill: "var(--card)" },
      data: { dangling: d } satisfies EdgeMeta,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: "oklch(0.7 0.19 22)",
      },
      style: { stroke: "oklch(0.7 0.19 22)" },
    });
  }

  return { initialNodes: nodes, initialEdges: edges };
}
