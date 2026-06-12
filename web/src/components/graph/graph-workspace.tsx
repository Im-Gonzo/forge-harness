"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ReactFlowProvider } from "@xyflow/react";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import "./graph.css";
import { DependencyGraph } from "./dependency-graph";
import { CompositionGraph } from "./composition-graph";
import { FocusSearch } from "./focus-search";
import { TriagePanel } from "./triage-panel";
import type { GraphData, CompositionData } from "./types";

interface Props {
  initialGraph: GraphData;
  initialComposition: CompositionData;
}

/**
 * Client shell for the /graph route: two tabs (dependency · composition), each
 * an editable React Flow canvas. Holds the live data and a refetch callback so
 * an edit round-trips (write → validate → registry build → refetch → re-render)
 * without a full page reload.
 */
export function GraphWorkspace({ initialGraph, initialComposition }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Deep-link focus: the URL ?focus=<uid> is hydrated ONCE on mount via a
  // lazy useState initializer (mirrors the registry-table hydrate-once idiom);
  // thereafter state drives the URL (shallow replace), not the reverse.
  const [focusUid, setFocusUid] = useState<string | null>(
    () => searchParams.get("focus"),
  );
  // A deep-linked ?focus must land on the Dependency tab so the lens shows on
  // load; otherwise fall back to the default Dependency tab too. (Spelled as a
  // branch so the deep-link guarantee survives any future default change.)
  const [tab, setTab] = useState<string>(() =>
    searchParams.get("focus") ? "dependency" : "dependency",
  );
  const [graph, setGraph] = useState<GraphData>(initialGraph);
  const [composition, setComposition] =
    useState<CompositionData>(initialComposition);
  const [refreshing, setRefreshing] = useState(false);

  // Set focus + keep the URL in sync (shallow) so the lens is shareable and
  // reload-stable without re-rendering the server page. A null focus clears the
  // param. Focus is NEVER reset on refetch — the canvas re-centers from the prop.
  const setFocus = useCallback(
    (uid: string | null) => {
      setFocusUid(uid);
      const params = new URLSearchParams(window.location.search);
      if (uid) params.set("focus", uid);
      else params.delete("focus");
      const qs = params.toString();
      const next = qs ? `?${qs}` : window.location.pathname;
      router.replace(next, { scroll: false });
    },
    [router],
  );

  const refetchGraph = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/graph", { cache: "no-store" });
      const json = (await res.json()) as GraphData;
      setGraph(json);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const refetchComposition = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/graph-composition", { cache: "no-store" });
      const json = (await res.json()) as CompositionData;
      setComposition(json);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // The server props seed the initial state once (useState initializer); live
  // updates flow through refetchGraph / refetchComposition after an edit. A soft
  // re-nav remounts this client component, re-seeding from the fresh props — so
  // no prop→state sync effect is needed (and it would trigger cascading renders).

  const bridgeFailed = graph.bridgeError || (!graph.ok && graph.artifacts.length === 0);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as string)}
        className="flex h-full flex-col gap-0"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <TabsList>
            <TabsTrigger value="dependency">Dependency</TabsTrigger>
            <TabsTrigger value="composition">Composition</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            {refreshing ? (
              <Badge variant="secondary" className="font-mono text-[10px]">
                refreshing…
              </Badge>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={
                tab === "dependency" ? refetchGraph : refetchComposition
              }
            >
              Refresh
            </Button>
          </div>
        </div>

        {bridgeFailed ? (
          <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2">
            <p className="font-mono text-xs text-destructive">
              Bridge could not reach the forge CLI.{" "}
              {graph.findings?.[0]?.message ?? ""}
            </p>
          </div>
        ) : null}

        <TabsContent value="dependency" className="min-h-0 flex-1">
          <div className="flex h-full min-h-0">
            {/* Triage rail: navigate graph-health problems into focus. */}
            <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-border p-3 lg:block">
              <TriagePanel
                dangling={graph.dangling}
                orphans={graph.orphans}
                artifacts={graph.artifacts}
                onFocus={setFocus}
              />
            </aside>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Search chrome above the canvas drives the focus lens. */}
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <FocusSearch artifacts={graph.artifacts} onSelect={setFocus} />
              </div>

              <div className="min-h-0 flex-1">
                <ReactFlowProvider>
                  <DependencyGraph
                    data={graph}
                    onRefetch={refetchGraph}
                    focusUid={focusUid}
                    onFocusChange={setFocus}
                  />
                </ReactFlowProvider>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="composition" className="min-h-0 flex-1">
          <ReactFlowProvider>
            <CompositionGraph
              data={composition}
              onRefetch={refetchComposition}
            />
          </ReactFlowProvider>
        </TabsContent>
      </Tabs>
    </div>
  );
}
