"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

import { ArtifactNode, type ArtifactNodeData } from "./artifact-node";
import { FindingsList } from "./findings-list";
import { layoutTiers } from "./layout";
import {
  KIND_COLORS,
  type CompositionData,
  type EditResponse,
  type ProfilesManifest,
  type ModulesManifest,
} from "./types";

const nodeTypes = { artifact: ArtifactNode };

/** Drag payload describing what is being dropped and onto what kind of target. */
interface DragPayload {
  kind: "module" | "component";
  /** module name (for module drag) OR component name (for component drag). */
  name: string;
  /** For a component drag: its componentKind (e.g. "agents"). */
  componentKind?: string;
}

interface Props {
  data: CompositionData;
  onRefetch: () => void;
}

const PALETTE_DND_MIME = "application/forge-composition";

export function CompositionGraph({ data, onRefetch }: Props) {
  const profiles = data.profiles?.profiles ?? {};
  const modulesManifest = data.modules;
  const modules = modulesManifest?.modules ?? {};

  const [busy, setBusy] = useState(false);
  const [lastEdit, setLastEdit] = useState<EditResponse | null>(null);
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const dragRef = useRef<DragPayload | null>(null);

  // ── Search + focus (purely visual: highlight / dim, no data writes) ──────
  const [search, setSearch] = useState("");
  const [focusProfile, setFocusProfile] = useState<string | null>(null);

  // ── Build the tiered flow ──────────────────────────────────────────────
  const { initialNodes, initialEdges } = useMemo(
    () => buildComposition(data),
    [data],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // ── Edit helpers ───────────────────────────────────────────────────────
  const postEdit = useCallback(
    async (body: Record<string, unknown>, successMsg: string) => {
      setBusy(true);
      setLastEdit(null);
      try {
        const res = await fetch("/api/graph-edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as EditResponse;
        setLastEdit(json);
        if (!res.ok || json.error) {
          toast.error(json.error ?? "Edit failed.");
          return;
        }
        const errors = json.validate?.summary?.errors ?? 0;
        if (errors > 0) {
          toast.error(`Validate reported ${errors} error(s).`);
        } else {
          toast.success(successMsg);
        }
        onRefetch();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Request failed.");
      } finally {
        setBusy(false);
      }
    },
    [onRefetch],
  );

  // ── Drop handling (assign) ─────────────────────────────────────────────
  const onNodeDrop = useCallback(
    (targetNode: Node) => {
      const payload = dragRef.current;
      if (!payload) return;
      const targetData = targetNode.data as ArtifactNodeData & {
        role?: string;
        name?: string;
      };

      // module → profile
      if (payload.kind === "module" && targetData.role === "profile") {
        postEdit(
          {
            kind: "manifest-edit",
            op: "add-module-to-profile",
            profile: targetData.name,
            module: payload.name,
          },
          `Added module '${payload.name}' to profile '${targetData.name}'.`,
        );
        return;
      }
      // component → module
      if (payload.kind === "component" && targetData.role === "module") {
        postEdit(
          {
            kind: "manifest-edit",
            op: "add-component-to-module",
            module: targetData.name,
            componentKind: payload.componentKind,
            component: payload.name,
          },
          `Added ${payload.componentKind} '${payload.name}' to module '${targetData.name}'.`,
        );
        return;
      }
      toast.error(
        payload.kind === "module"
          ? "Drop a module onto a profile node."
          : "Drop a component onto a module node.",
      );
    },
    [postEdit],
  );

  // Highlight valid drop targets while dragging.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        const nd = n.data as ArtifactNodeData & { role?: string };
        const valid =
          (drag?.kind === "module" && nd.role === "profile") ||
          (drag?.kind === "component" && nd.role === "module");
        return { ...n, data: { ...nd, dropTarget: Boolean(drag) && valid } };
      }),
    );
  }, [drag, setNodes]);

  // ── Remove an existing membership edge ─────────────────────────────────
  const onEdgeClick = useCallback(
    (_: unknown, edge: Edge) => {
      const meta = edge.data as
        | { removable?: boolean; op?: string; [k: string]: unknown }
        | undefined;
      if (!meta?.removable) return;
      if (meta.op === "remove-module-from-profile") {
        postEdit(
          {
            kind: "manifest-edit",
            op: "remove-module-from-profile",
            profile: meta.profile,
            module: meta.module,
          },
          `Removed module '${meta.module}' from profile '${meta.profile}'.`,
        );
      } else if (meta.op === "remove-component-from-module") {
        postEdit(
          {
            kind: "manifest-edit",
            op: "remove-component-from-module",
            module: meta.module,
            componentKind: meta.componentKind,
            component: meta.component,
          },
          `Removed ${meta.componentKind} '${meta.component}' from module '${meta.module}'.`,
        );
      }
    },
    [postEdit],
  );

  // ── HTML5 DnD bridging: palette items set the payload; the flow pane reads
  // the node under the cursor on drop. We attach drop handlers to the pane and
  // resolve the target node via elementFromPoint + data-id. ───────────────
  const onPaneDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const nodeEl = el?.closest<HTMLElement>(".react-flow__node");
      const id = nodeEl?.getAttribute("data-id");
      const target = id ? nodes.find((n) => n.id === id) : undefined;
      setDrag(null);
      dragRef.current = null;
      if (target) onNodeDrop(target);
      else toast.error("Drop onto a node (profile or module).");
    },
    [nodes, onNodeDrop],
  );

  const allModuleNames = Object.keys(modules);
  const componentPalette = useMemo(() => buildComponentPalette(modulesManifest), [
    modulesManifest,
  ]);

  // The set of node ids related to the focused profile: the profile itself, its
  // selected modules, and every component those modules resolve. Purely derived
  // from the manifests — no writes.
  const focusSet = useMemo(
    () => resolveFocusSet(focusProfile, data),
    [focusProfile, data],
  );

  // Node ids whose name matches the live search (case-insensitive substring).
  const searchSet = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const hits = new Set<string>();
    for (const n of nodes) {
      const nd = n.data as ArtifactNodeData & { name?: string };
      const name = (nd.name ?? nd.label ?? "").toLowerCase();
      if (name.includes(q)) hits.add(n.id);
    }
    return hits;
  }, [search, nodes]);

  // Apply highlight (search match) + dim (outside focus) as inline overrides on
  // top of the editable nodes/edges, so drag positions stay the source of truth.
  const displayNodes = useMemo(() => {
    if (!focusSet && !searchSet) return nodes;
    return nodes.map((n) => {
      const dimmed = focusSet ? !focusSet.has(n.id) : false;
      const hit = searchSet?.has(n.id) ?? false;
      return {
        ...n,
        style: {
          ...n.style,
          opacity: dimmed && !hit ? 0.18 : 1,
          // React Flow applies node `style` to the wrapper, so a search hit gets
          // a visible ring without touching the shared ArtifactNode/graph.css.
          borderRadius: 8,
          boxShadow: hit ? "0 0 0 2px oklch(0.78 0.16 90)" : undefined,
          transition: "opacity 0.15s ease, box-shadow 0.15s ease",
        },
      };
    });
  }, [nodes, focusSet, searchSet]);

  const displayEdges = useMemo(() => {
    if (!focusSet) return edges;
    return edges.map((e) => {
      const active = focusSet.has(e.source) && focusSet.has(e.target);
      return {
        ...e,
        style: {
          ...e.style,
          opacity: active ? 1 : 0.1,
          transition: "opacity 0.15s ease",
        },
      };
    });
  }, [edges, focusSet]);

  // Clicking a profile focuses it; clicking any other node clears focus so the
  // canvas never gets stuck dimmed on an unrelated selection.
  const onNodeClick = useCallback((_: unknown, node: Node) => {
    const nd = node.data as ArtifactNodeData & { role?: string; name?: string };
    setFocusProfile(
      nd.role === "profile" && nd.name ? (nd.name as string) : null,
    );
  }, []);

  const clearFocus = useCallback(() => setFocusProfile(null), []);

  if (!data.ok) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-xs text-destructive">
          Could not read composition manifests: {data.error}
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full">
      {/* Palette: drag a module or a component onto the canvas */}
      <aside className="z-10 flex w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-card/60 p-3">
        <div>
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Modules — drag onto a profile
          </p>
          <div className="flex flex-wrap gap-1">
            {allModuleNames.map((m) => (
              <PaletteChip
                key={m}
                label={m}
                color={KIND_COLORS.module}
                payload={{ kind: "module", name: m }}
                onDragStart={(p) => {
                  dragRef.current = p;
                  setDrag(p);
                }}
                onDragEnd={() => {
                  dragRef.current = null;
                  setDrag(null);
                }}
              />
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Components — drag onto a module
          </p>
          <div className="space-y-2">
            {Object.entries(componentPalette).map(([ck, names]) => (
              <div key={ck}>
                <p className="font-mono text-[9px] text-muted-foreground">
                  {ck}
                </p>
                <div className="flex flex-wrap gap-1">
                  {names.map((name) => (
                    <PaletteChip
                      key={`${ck}:${name}`}
                      label={name}
                      color="var(--muted-foreground)"
                      payload={{
                        kind: "component",
                        name,
                        componentKind: ck,
                      }}
                      onDragStart={(p) => {
                        dragRef.current = p;
                        setDrag(p);
                      }}
                      onDragEnd={() => {
                        dragRef.current = null;
                        setDrag(null);
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        {lastEdit?.validate?.summary ? (
          <FindingsList
            findings={lastEdit.findings ?? []}
            summary={lastEdit.validate.summary}
          />
        ) : null}
      </aside>

      <div
        className="relative flex-1"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(PALETTE_DND_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={onPaneDrop}
      >
        <ReactFlow
          className="forge-graph"
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onEdgeClick={onEdgeClick}
          onNodeClick={onNodeClick}
          onPaneClick={clearFocus}
          nodesDraggable
          fitView
          minZoom={0.1}
        >
          <Background gap={20} size={1} color="oklch(0.3 0 0)" />
          <Controls />

          {/* Search: highlight profiles / modules / components by name. */}
          <Panel position="top-left">
            <div className="flex w-56 flex-col gap-1 rounded-lg border border-border bg-card/90 p-2 backdrop-blur">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search profiles, modules, components…"
                className="h-7 font-mono text-[11px]"
              />
              <div className="flex items-center justify-between font-mono text-[9px] text-muted-foreground">
                <span>
                  {searchSet
                    ? `${searchSet.size} match${searchSet.size === 1 ? "" : "es"}`
                    : focusProfile
                      ? `Focused: ${focusProfile}`
                      : "Click a profile to focus"}
                </span>
                {search || focusProfile ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setFocusProfile(null);
                    }}
                    className="rounded border border-border px-1 py-0.5 transition-colors hover:bg-muted"
                  >
                    clear
                  </button>
                ) : null}
              </div>
            </div>
          </Panel>

          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              (KIND_COLORS[(n.data as ArtifactNodeData)?.kind] ??
                "var(--muted-foreground)") as string
            }
            maskColor="oklch(0.145 0 0 / 0.7)"
          />
          <Panel position="top-right">
            <div className="flex flex-col items-end gap-1">
              <Badge variant="outline" className="font-mono text-[10px]">
                {Object.keys(profiles).length} profiles
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px]">
                {allModuleNames.length} modules
              </Badge>
              <p className="mt-1 max-w-[200px] text-right font-mono text-[9px] text-muted-foreground">
                Drag a chip onto a node to assign. Click a membership edge to
                remove it.
              </p>
            </div>
          </Panel>
          {busy ? (
            <Panel position="bottom-center">
              <Badge variant="secondary" className="font-mono text-[10px]">
                Applying edit…
              </Badge>
            </Panel>
          ) : null}
        </ReactFlow>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Palette chip (HTML5 draggable)
// ──────────────────────────────────────────────────────────────────────────

function PaletteChip({
  label,
  color,
  payload,
  onDragStart,
  onDragEnd,
}: {
  label: string;
  color: string;
  payload: DragPayload;
  onDragStart: (p: DragPayload) => void;
  onDragEnd: () => void;
}) {
  return (
    <span
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PALETTE_DND_MIME, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "copy";
        onDragStart(payload);
      }}
      onDragEnd={onDragEnd}
      className="inline-flex cursor-grab items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] active:cursor-grabbing"
    >
      <span
        className="inline-block size-1.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Flow construction
// ──────────────────────────────────────────────────────────────────────────

function buildComponentPalette(
  manifest?: CompositionData["modules"],
): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  if (!manifest) return {};
  for (const ck of manifest.componentKinds ?? []) out[ck] = new Set();
  for (const mod of Object.values(manifest.modules ?? {})) {
    for (const [ck, names] of Object.entries(mod.components ?? {})) {
      if (!out[ck]) out[ck] = new Set();
      for (const n of names) out[ck].add(n);
    }
  }
  const result: Record<string, string[]> = {};
  for (const [ck, set] of Object.entries(out)) {
    if (set.size > 0) result[ck] = [...set].sort();
  }
  return result;
}

/**
 * Resolve the node ids related to a focused profile: the profile node, every
 * module it selects, and every component those modules contain. Ids match the
 * ones minted in buildComposition (`profile:`/`module:`/`comp:<ck>:<name>`).
 * Returns null when nothing is focused.
 */
function resolveFocusSet(
  focusProfile: string | null,
  data: CompositionData,
): Set<string> | null {
  if (!focusProfile) return null;
  const profiles: ProfilesManifest["profiles"] = data.profiles?.profiles ?? {};
  const modules: ModulesManifest["modules"] = data.modules?.modules ?? {};
  const set = new Set<string>([`profile:${focusProfile}`]);
  const def = profiles[focusProfile];
  if (!def) return set;
  for (const m of def.modules ?? []) {
    set.add(`module:${m}`);
    const mod = modules[m];
    if (!mod) continue;
    for (const [ck, names] of Object.entries(mod.components ?? {})) {
      for (const name of names) set.add(`comp:${ck}:${name}`);
    }
  }
  return set;
}

function buildComposition(data: CompositionData): {
  initialNodes: Node[];
  initialEdges: Edge[];
} {
  const profiles = data.profiles?.profiles ?? {};
  const modules = data.modules?.modules ?? {};

  const profileNames = Object.keys(profiles);
  const moduleNames = Object.keys(modules);

  // Component nodes: id = "comp:<kind>:<name>" so identical names in different
  // kinds stay distinct. Collect the union referenced by modules.
  const componentIds: string[] = [];
  const componentMeta = new Map<string, { kind: string; name: string }>();
  for (const mod of Object.values(modules)) {
    for (const [ck, names] of Object.entries(mod.components ?? {})) {
      for (const name of names) {
        const id = `comp:${ck}:${name}`;
        if (!componentMeta.has(id)) {
          componentMeta.set(id, { kind: ck, name });
          componentIds.push(id);
        }
      }
    }
  }

  const positions = layoutTiers(
    profileNames.map((p) => `profile:${p}`),
    moduleNames.map((m) => `module:${m}`),
    componentIds,
  );

  const nodes: Node[] = [];

  for (const p of profileNames) {
    const id = `profile:${p}`;
    nodes.push({
      id,
      type: "artifact",
      position: positions.get(id) ?? { x: 0, y: 0 },
      data: {
        label: p,
        kind: "profile",
        role: "profile",
        name: p,
      } as ArtifactNodeData & { role: string; name: string },
    });
  }
  for (const m of moduleNames) {
    const id = `module:${m}`;
    nodes.push({
      id,
      type: "artifact",
      position: positions.get(id) ?? { x: 0, y: 0 },
      data: {
        label: m,
        kind: "module",
        role: "module",
        name: m,
      } as ArtifactNodeData & { role: string; name: string },
    });
  }
  for (const cid of componentIds) {
    const meta = componentMeta.get(cid)!;
    nodes.push({
      id: cid,
      type: "artifact",
      position: positions.get(cid) ?? { x: 0, y: 0 },
      data: {
        label: meta.name,
        kind: meta.kind,
        role: "component",
      } as ArtifactNodeData & { role: string },
    });
  }

  const edges: Edge[] = [];

  // profile → module (selects). Removable.
  for (const [p, def] of Object.entries(profiles)) {
    for (const m of def.modules ?? []) {
      const target = `module:${m}`;
      edges.push({
        id: `sel:${p}->${m}`,
        source: `profile:${p}`,
        target,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: { stroke: "oklch(0.55 0.1 250)" },
        data: {
          removable: true,
          op: "remove-module-from-profile",
          profile: p,
          module: m,
        },
      });
    }
  }

  // module → component (member-of). Removable.
  for (const [m, def] of Object.entries(modules)) {
    for (const [ck, names] of Object.entries(def.components ?? {})) {
      for (const name of names) {
        const cid = `comp:${ck}:${name}`;
        edges.push({
          id: `mem:${m}->${cid}`,
          source: `module:${m}`,
          target: cid,
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
          style: { stroke: "oklch(0.5 0.08 150)" },
          data: {
            removable: true,
            op: "remove-component-from-module",
            module: m,
            componentKind: ck,
            component: name,
          },
        });
      }
    }
  }

  return { initialNodes: nodes, initialEdges: edges };
}
