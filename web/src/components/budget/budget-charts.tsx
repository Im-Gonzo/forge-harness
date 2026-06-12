"use client";

import { useMemo, useState } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3, Check, LayoutGrid, Scissors } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { kindColor, kindsByCost } from "@/components/budget/kind-colors";
import { OpenInEditor } from "@/components/open-in-editor";
import type { AnalyzeArtifact } from "@/app/budget/analyze-types";
import type { ArtifactKind, ResourceKind } from "@/lib/types";

type SortKey = "tokens" | "kind" | "id";
type ChartMode = "bars" | "treemap";

interface BudgetChartsProps {
  /** Always-on artifacts only — the rows that sum to the always-on total. */
  artifacts: AnalyzeArtifact[];
  alwaysOnTotal: number;
  /** What-if selection (uids) from the workspace — wired by the charts feature agent. */
  selectedUids?: Set<string>;
  /** Toggle one artifact in/out of the what-if selection — wired by the feature agent. */
  onToggleSelect?: (uid: string) => void;
}

interface BarDatum {
  uid: string;
  id: string;
  kind: string;
  estTokens: number;
  share: number;
  fill: string;
  /** B5: among the heaviest always-on artifacts (the Pareto "trim candidates"). */
  trimCandidate: boolean;
}

/**
 * B5 — flag the heaviest always-on artifacts as "trim candidates".
 *
 * Pure summing of the per-artifact tokens forge already returned (NO cost model):
 * walk artifacts in descending token order and mark the smallest leading set
 * whose cumulative cost reaches ~80% of the always-on total (a Pareto cut). The
 * set is capped so it stays a short, actionable shortlist on large repos, and a
 * positive token cost is required (zero-cost rows are never candidates).
 */
const TRIM_PARETO = 0.8;
const TRIM_MAX = 6;

function trimCandidateUids(
  artifacts: AnalyzeArtifact[],
  alwaysOnTotal: number,
): Set<string> {
  const out = new Set<string>();
  if (alwaysOnTotal <= 0) return out;
  const byCost = [...artifacts]
    .filter((a) => a.estTokens > 0)
    .sort((a, b) => b.estTokens - a.estTokens);
  let cumulative = 0;
  for (const a of byCost) {
    if (out.size >= TRIM_MAX) break;
    out.add(a.uid);
    cumulative += a.estTokens;
    if (cumulative / alwaysOnTotal >= TRIM_PARETO) break;
  }
  return out;
}

interface TreeNode {
  name: string;
  size: number;
  kind: string;
  fill: string;
  uid: string;
  // recharts' TreemapDataType requires an index signature.
  [key: string]: string | number;
}

const fmt = new Intl.NumberFormat("en-US");

/** recharts v3 LabelList formatter receives RenderableText; coerce to a number string. */
function tokenLabel(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? fmt.format(n) : "";
}

/**
 * Map an analyzed artifact's {@link ArtifactKind} to the {@link ResourceKind}
 * its in-app editor addresses — but only for the kinds that ARE editable on
 * disk. `validator`/`meta-test`/`engine` have no editor route, so they return
 * null and render as plain (non-linked) rows. This mirrors validation-view's
 * "only managed-resource kinds are linkable" precedent. The artifact `id` is
 * already the kind-local id editorHref expects.
 */
const EDITABLE_KINDS: Record<string, ResourceKind> = {
  agent: "agent",
  skill: "skill",
  command: "command",
  rule: "rule",
  bundle: "bundle",
  hook: "hook",
};

function editorKind(kind: ArtifactKind): ResourceKind | null {
  return EDITABLE_KINDS[kind] ?? null;
}

function BarTooltip({ active, payload }: TooltipState<BarDatum>) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return <DatumTooltip kind={d.kind} id={d.id} tokens={d.estTokens} share={d.share} />;
}

function DatumTooltip({
  kind,
  id,
  tokens,
  share,
}: {
  kind: string;
  id: string;
  tokens: number;
  share: number;
}) {
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 font-mono text-[11px] shadow-md">
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block size-2.5 rounded-[2px]"
          style={{ background: kindColor(kind) }}
        />
        <span className="font-semibold text-foreground">{id}</span>
        <span className="text-muted-foreground">{kind}</span>
      </div>
      <div className="mt-1 text-muted-foreground">
        <span className="text-foreground">{fmt.format(tokens)}</span> tok ·{" "}
        <span className="text-foreground">{share.toFixed(1)}%</span> of always-on
      </div>
    </div>
  );
}

interface TooltipState<T> {
  active?: boolean;
  payload?: { payload: T }[];
}

/** Custom treemap cell so we can color by kind and label larger tiles. */
function TreemapCell(props: TreemapCellProps) {
  const { x, y, width, height, name, kind, size } = props;
  if (x === undefined || y === undefined || !width || !height) return null;
  const showLabel = width > 56 && height > 22;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={3}
        style={{ fill: kindColor(kind ?? ""), stroke: "var(--background)", strokeWidth: 1.5 }}
      />
      {showLabel ? (
        <text
          x={x + 6}
          y={y + 15}
          fill="oklch(1 0 0)"
          className="font-mono"
          fontSize={10}
          style={{ pointerEvents: "none" }}
        >
          <tspan fontWeight={600}>{name}</tspan>
          {width > 92 ? <tspan dx={6} opacity={0.85}>{fmt.format(size ?? 0)}</tspan> : null}
        </text>
      ) : null}
    </g>
  );
}

interface TreemapCellProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  kind?: string;
  size?: number;
}

export function BudgetCharts({
  artifacts,
  alwaysOnTotal,
  selectedUids,
  onToggleSelect,
}: BudgetChartsProps) {
  const [mode, setMode] = useState<ChartMode>("bars");
  const [sort, setSort] = useState<SortKey>("tokens");
  const [activeKinds, setActiveKinds] = useState<Set<string>>(new Set());

  const allKinds = useMemo(() => kindsByCost(artifacts), [artifacts]);

  // B5: trim candidates are computed over ALL always-on artifacts (not the
  // kind-filtered view) so the shortlist is stable regardless of chip state.
  const candidateUids = useMemo(
    () => trimCandidateUids(artifacts, alwaysOnTotal),
    [artifacts, alwaysOnTotal],
  );

  const filtered = useMemo(() => {
    if (activeKinds.size === 0) return artifacts;
    return artifacts.filter((a) => activeKinds.has(a.kind));
  }, [artifacts, activeKinds]);

  const barData: BarDatum[] = useMemo(() => {
    const rows = filtered.map<BarDatum>((a) => ({
      uid: a.uid,
      id: a.id,
      kind: a.kind,
      estTokens: a.estTokens,
      share: alwaysOnTotal > 0 ? (a.estTokens / alwaysOnTotal) * 100 : 0,
      fill: kindColor(a.kind),
      trimCandidate: candidateUids.has(a.uid),
    }));
    rows.sort((a, b) => {
      if (sort === "tokens") return b.estTokens - a.estTokens;
      if (sort === "kind")
        return a.kind.localeCompare(b.kind) || b.estTokens - a.estTokens;
      return a.id.localeCompare(b.id);
    });
    return rows;
  }, [filtered, sort, alwaysOnTotal, candidateUids]);

  const treeData: TreeNode[] = useMemo(
    () =>
      filtered
        .filter((a) => a.estTokens > 0)
        .map((a) => ({
          name: a.id,
          size: a.estTokens,
          kind: a.kind,
          fill: kindColor(a.kind),
          uid: a.uid,
        })),
    [filtered],
  );

  const filteredTotal = useMemo(
    () => filtered.reduce((s, a) => s + a.estTokens, 0),
    [filtered],
  );

  // Per-kind tokens for the filter chips.
  const kindTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of artifacts) m.set(a.kind, (m.get(a.kind) ?? 0) + a.estTokens);
    return m;
  }, [artifacts]);

  function toggleKind(kind: string) {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  // B5: are all trim candidates already selected? Drives the bulk affordance's
  // label (select all ⇄ none) — purely a read of the workspace-owned selection.
  const allCandidatesSelected =
    candidateUids.size > 0 &&
    [...candidateUids].every((uid) => selectedUids?.has(uid));

  // B2/B5: toggle the whole trim-candidate shortlist. Adds any unselected
  // candidate; if they're all already in, clears them. Selection state lives in
  // the workspace, so we just fan `onToggleSelect` over the delta.
  function toggleAllCandidates() {
    if (!onToggleSelect) return;
    for (const uid of candidateUids) {
      const isSelected = selectedUids?.has(uid) ?? false;
      if (allCandidatesSelected ? isSelected : !isSelected) {
        onToggleSelect(uid);
      }
    }
  }

  const selectionEnabled = typeof onToggleSelect === "function";

  // Each row is ~22px tall; give the bar chart room so labels don't collide.
  const barHeight = Math.max(220, barData.length * 22 + 40);

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="font-mono text-sm">
              Always-on token cost per artifact
            </CardTitle>
            <CardDescription className="font-mono text-[11px]">
              {fmt.format(filteredTotal)} tok across {filtered.length} artifact
              {filtered.length === 1 ? "" : "s"}
              {activeKinds.size > 0
                ? ` (filtered from ${fmt.format(alwaysOnTotal)})`
                : null}
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            <ToggleGroup<ChartMode>
              value={mode}
              onChange={setMode}
              options={[
                { value: "bars", label: "Bars", icon: <BarChart3 className="size-3.5" /> },
                { value: "treemap", label: "Treemap", icon: <LayoutGrid className="size-3.5" /> },
              ]}
            />
          </div>
        </div>

        {/* Kind filter chips (colored, click to toggle) + sort control. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {allKinds.map((kind) => {
            const on = activeKinds.size === 0 || activeKinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] transition-opacity"
                style={{
                  borderColor: kindColor(kind),
                  opacity: on ? 1 : 0.4,
                }}
                aria-pressed={activeKinds.has(kind)}
              >
                <span
                  className="inline-block size-2.5 rounded-[2px]"
                  style={{ background: kindColor(kind) }}
                />
                {kind}
                <span className="text-muted-foreground">
                  {fmt.format(kindTotals.get(kind) ?? 0)}
                </span>
              </button>
            );
          })}
          {activeKinds.size > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 font-mono text-[11px]"
              onClick={() => setActiveKinds(new Set())}
            >
              clear
            </Button>
          ) : null}

          {mode === "bars" ? (
            <div className="ml-auto flex items-center gap-1">
              <span className="font-mono text-[11px] text-muted-foreground">sort</span>
              <ToggleGroup<SortKey>
                value={sort}
                onChange={setSort}
                options={[
                  { value: "tokens", label: "tokens" },
                  { value: "kind", label: "kind" },
                  { value: "id", label: "id" },
                ]}
              />
            </div>
          ) : null}
        </div>
      </CardHeader>

      <CardContent>
        {barData.length === 0 ? (
          <p className="py-12 text-center font-mono text-xs text-muted-foreground">
            No artifacts match the current filter.
          </p>
        ) : mode === "bars" ? (
          <div style={{ height: barHeight }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={barData}
                layout="vertical"
                margin={{ top: 4, right: 56, bottom: 4, left: 8 }}
                barCategoryGap={3}
              >
                <CartesianGrid
                  horizontal={false}
                  stroke="var(--border)"
                  strokeDasharray="3 3"
                />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                  stroke="var(--muted-foreground)"
                  tickFormatter={(v: number) => fmt.format(v)}
                />
                <YAxis
                  type="category"
                  dataKey="id"
                  width={150}
                  interval={0}
                  tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                  stroke="var(--muted-foreground)"
                />
                <Tooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                  content={<BarTooltip />}
                />
                <Bar dataKey="estTokens" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                  {barData.map((d) => (
                    <Cell key={d.uid} fill={d.fill} />
                  ))}
                  <LabelList
                    dataKey="estTokens"
                    position="right"
                    formatter={tokenLabel}
                    className="fill-muted-foreground"
                    style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div style={{ height: 460 }}>
            <ResponsiveContainer width="100%" height="100%">
              <Treemap
                data={treeData}
                dataKey="size"
                nameKey="name"
                isAnimationActive={false}
                content={<TreemapCell />}
              >
                <Tooltip content={<TreemapTooltip />} />
              </Treemap>
            </ResponsiveContainer>
          </div>
        )}

        {/*
          The trim cockpit: a textual, editor-linked, SELECTABLE list of EVERY
          (filtered) always-on artifact. The recharts SVG above has no per-bar
          links/handlers, so this list is the keyboard/click path from each
          artifact to (a) its editor and (b) the what-if selection the workspace
          turns into a live savings figure.

          B1: every listed artifact links to its editor (non-editable kinds —
              validator / meta-test / engine — render without an edit link).
          B2: a checkbox per row toggles the artifact in the what-if selection;
              selected rows are visibly marked.
          B5: the heaviest artifacts carry a "trim" badge, and the header offers
              a one-click select/deselect of the whole candidate shortlist.
        */}
        {barData.length > 0 ? (
          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-[11px] text-muted-foreground">
                Always-on artifacts{" "}
                <span className="text-foreground">{barData.length}</span>
                {selectionEnabled && selectedUids && selectedUids.size > 0 ? (
                  <>
                    {" · "}
                    <span className="text-foreground">{selectedUids.size}</span>{" "}
                    selected
                  </>
                ) : null}
              </p>
              {selectionEnabled && candidateUids.size > 0 ? (
                <Button
                  variant="outline"
                  size="xs"
                  className="font-mono text-[11px]"
                  onClick={toggleAllCandidates}
                >
                  <Scissors className="size-3" />
                  {allCandidatesSelected ? "deselect" : "select"}{" "}
                  {candidateUids.size} trim candidate
                  {candidateUids.size === 1 ? "" : "s"}
                </Button>
              ) : null}
            </div>
            <ScrollArea className="max-h-72">
              <ul className="flex flex-col gap-0.5 pr-2.5">
                {barData.map((d) => {
                  const linkKind = editorKind(d.kind as ArtifactKind);
                  const checked = selectedUids?.has(d.uid) ?? false;
                  return (
                    <li
                      key={d.uid}
                      data-state={checked ? "selected" : undefined}
                      className="flex items-center gap-2 rounded-md px-1.5 py-1 font-mono text-[11px] hover:bg-muted/50 data-[state=selected]:bg-primary/10 data-[state=selected]:ring-1 data-[state=selected]:ring-inset data-[state=selected]:ring-primary/40"
                    >
                      {selectionEnabled ? (
                        <Checkbox.Root
                          checked={checked}
                          onCheckedChange={() => onToggleSelect?.(d.uid)}
                          aria-label={`select ${d.uid} for trimming`}
                          className="flex size-4 shrink-0 items-center justify-center rounded border border-input bg-transparent text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary data-checked:bg-primary"
                        >
                          <Checkbox.Indicator className="flex items-center justify-center">
                            <Check className="size-3" />
                          </Checkbox.Indicator>
                        </Checkbox.Root>
                      ) : null}
                      <span
                        className="inline-block size-2.5 shrink-0 rounded-[2px]"
                        style={{ background: d.fill }}
                      />
                      <span className="truncate text-foreground" title={d.id}>
                        {d.id}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{d.kind}</span>
                      {d.trimCandidate ? (
                        <Badge
                          variant="outline"
                          className="h-4 shrink-0 gap-1 border-amber-500/40 px-1.5 font-mono text-[10px] text-amber-600 dark:text-amber-400"
                        >
                          <Scissors className="size-2.5" />
                          trim
                        </Badge>
                      ) : null}
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        <span className="text-foreground">{fmt.format(d.estTokens)}</span> tok ·{" "}
                        {d.share.toFixed(1)}%
                      </span>
                      {linkKind ? (
                        <OpenInEditor
                          kind={linkKind}
                          id={d.id}
                          iconOnly
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0 text-muted-foreground"
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TreemapTooltip({ active, payload }: TooltipState<TreeNode>) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  if (!d?.name) return null;
  return <DatumTooltip kind={d.kind} id={d.name} tokens={d.size} share={0} />;
}

// ── Minimal segmented toggle (no extra deps; matches the dense mono aesthetic) ──
interface ToggleGroupProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: React.ReactNode }[];
}

function ToggleGroup<T extends string>({
  value,
  onChange,
  options,
}: ToggleGroupProps<T>) {
  return (
    <div className="inline-flex items-center rounded-lg bg-muted p-[3px]">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors " +
              (active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
