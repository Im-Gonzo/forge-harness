"use client";

/**
 * TelemetryWorklists — the evidence-layer "what should I act on?" panels.
 *
 * Two cross-referenced views answer "what do I cut?":
 *
 *   T2 UNUSED — registry artifacts with ZERO invocations in the current
 *               telemetry window (the `unused` prop). A prominent count, a
 *               per-row "never invoked" badge, and an editor link each. The
 *               heading states that "unused" is window-relative (an artifact may
 *               simply not have fired yet in a short window).
 *
 *   T6 COST × USAGE — the deferred Budget B6 overlay: cross each artifact's
 *               always-on token cost (costByUid) against its live invocation
 *               count (mostInvoked). A scatter places "expensive AND rarely
 *               used" in the top-left "cut first" quadrant; a sorted table lists
 *               the same candidates with editor links. Explicit empty states for
 *               telemetry-off / no-cost-overlap.
 *
 * All inputs are plain, server-derived data (the forge-bridge is server-only):
 *   unused       — registry artifacts whose id/uid never appears in the
 *                  telemetry `mostInvoked` keys (best-effort key match; the
 *                  server documents the heuristic). "Catalogued but never invoked
 *                  in the window" candidates. Each carries kind/id/uid for the
 *                  editor link and the cost lookup.
 *   costByUid    — uid → { alwaysOn } estimated always-on token cost, so a
 *                  worklist can weight an artifact by what it costs to keep
 *                  resident (null when analyze had no always-on figure for it).
 *   mostInvoked  — the live `forge stat` invocation counts (key → count); the
 *                  inverse of `unused` and the join key for the usage-vs-cost
 *                  views. Used here to size the universe and to report how many
 *                  keys WERE invoked.
 */
import { useMemo } from "react";
import {
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  type TooltipContentProps,
} from "recharts";
import { Boxes, Coins, Scissors } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OpenInEditor } from "@/components/open-in-editor";
import { kindColor } from "@/components/budget/kind-colors";
import type { ArtifactKind, RegistryArtifact, ResourceKind } from "@/lib/types";

/** ResourceKinds that have an on-disk editor route (OpenInEditor targets). */
const EDITABLE_KINDS: ReadonlySet<string> = new Set<ResourceKind>([
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "memory",
  "hook",
]);

const fmt = new Intl.NumberFormat("en-US");

const AXIS = "var(--color-muted-foreground)";
const GRID = "var(--color-border)";
const DESTRUCTIVE = "var(--color-destructive)";

const tooltipStyle = {
  background: "var(--color-card)",
  border: `1px solid ${GRID}`,
  borderRadius: 8,
  fontSize: 11,
  fontFamily: "var(--font-mono, monospace)",
  color: "var(--color-card-foreground)",
} as const;

/** True for an editable kind (narrows to ResourceKind for OpenInEditor). */
function isEditable(kind: string): kind is ResourceKind {
  return EDITABLE_KINDS.has(kind);
}

export interface TelemetryWorklistsProps {
  /** Registry artifacts not present in the telemetry invocation keys. */
  unused: RegistryArtifact[];
  /** uid → estimated always-on token cost (null when analyze had no figure). */
  costByUid: Record<string, { alwaysOn: number | null }>;
  /** Live `forge stat` invocation counts (key → count). */
  mostInvoked: { key: string; count: number }[];
}

export function TelemetryWorklists({
  unused,
  costByUid,
  mostInvoked,
}: TelemetryWorklistsProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <UnusedPanel unused={unused} costByUid={costByUid} invoked={mostInvoked.length} />
      <CostUsagePanel unused={unused} costByUid={costByUid} />
    </div>
  );
}

// ── T2 — never-invoked artifacts ────────────────────────────────────────────

function UnusedPanel({
  unused,
  costByUid,
  invoked,
}: {
  unused: RegistryArtifact[];
  costByUid: Record<string, { alwaysOn: number | null }>;
  invoked: number;
}) {
  // Surface the heaviest dead weight first: artifacts with an always-on cost,
  // descending, then the rest. A never-invoked always-on artifact is pure waste.
  const rows = useMemo(() => {
    return [...unused].sort((a, b) => {
      const ca = costByUid[a.uid]?.alwaysOn ?? -1;
      const cb = costByUid[b.uid]?.alwaysOn ?? -1;
      if (cb !== ca) return cb - ca;
      return a.uid.localeCompare(b.uid);
    });
  }, [unused, costByUid]);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 font-mono text-sm">
          <Boxes className="size-3.5 text-muted-foreground" />
          Never invoked
          <Badge
            variant={unused.length ? "destructive" : "outline"}
            className="ml-1 font-mono text-[10px]"
          >
            {fmt.format(unused.length)}
          </Badge>
        </CardTitle>
        <p className="font-mono text-[11px] text-muted-foreground">
          Catalogued artifacts absent from {fmt.format(invoked)} invoked key(s).
          &ldquo;Unused&rdquo; is relative to the current telemetry window — a
          longer window may reveal activity.
        </p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            Every catalogued artifact was invoked in the window.
          </p>
        ) : (
          <ScrollArea className="max-h-72">
            <ul className="flex flex-col divide-y divide-border pr-2">
              {rows.map((a) => {
                const cost = costByUid[a.uid]?.alwaysOn ?? null;
                return (
                  <li
                    key={a.uid}
                    className="flex items-center gap-2 py-1.5 font-mono text-[11px]"
                  >
                    <span
                      className="inline-block size-2 shrink-0 rounded-sm"
                      style={{ background: kindColor(a.kind) }}
                      aria-hidden
                    />
                    <span className="text-muted-foreground">{a.kind}</span>
                    <span className="truncate text-foreground">{a.id}</span>
                    <Badge
                      variant="destructive"
                      className="shrink-0 font-mono text-[9px]"
                    >
                      never invoked
                    </Badge>
                    {cost !== null ? (
                      <span className="shrink-0 text-muted-foreground">
                        · {fmt.format(cost)} tok always-on
                      </span>
                    ) : null}
                    {isEditable(a.kind) ? (
                      <OpenInEditor
                        kind={a.kind}
                        id={a.id}
                        iconOnly
                        size="sm"
                        className="ml-auto h-6 px-2"
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

// ── T6 — cost × usage (cut-first overlay) ───────────────────────────────────

interface CostRow {
  uid: string;
  kind: ArtifactKind;
  id: string;
  cost: number;
  /** Invocations: 0 for everything in `unused` (the never-invoked universe). */
  count: number;
}

function CostUsagePanel({
  unused,
  costByUid,
}: {
  unused: RegistryArtifact[];
  costByUid: Record<string, { alwaysOn: number | null }>;
}) {
  // Universe = never-invoked artifacts that carry an always-on cost. These are
  // the only "expensive AND rarely used" candidates we can attribute: an invoked
  // artifact would not be in `unused`, so count is 0 across the board, which is
  // exactly the "rarely used" end of the quadrant.
  const rows = useMemo<CostRow[]>(() => {
    return unused
      .map((a) => {
        const cost = costByUid[a.uid]?.alwaysOn ?? null;
        return cost === null
          ? null
          : { uid: a.uid, kind: a.kind, id: a.id, cost, count: 0 };
      })
      .filter((r): r is CostRow => r !== null)
      .sort((a, b) => b.cost - a.cost);
  }, [unused, costByUid]);

  const maxCost = rows.length ? rows[0].cost : 0;
  const totalWaste = rows.reduce((s, r) => s + r.cost, 0);

  if (rows.length === 0) {
    return (
      <Card className="flex flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 font-mono text-sm">
            <Coins className="size-3.5 text-muted-foreground" />
            Cost × usage
          </CardTitle>
          <p className="font-mono text-[11px] text-muted-foreground">
            Expensive AND rarely used → cut first.
          </p>
        </CardHeader>
        <CardContent className="flex h-56 items-center justify-center">
          <p className="max-w-xs text-center font-mono text-[11px] text-muted-foreground">
            No always-on cost overlaps the never-invoked set. Either every
            resident artifact is being used, or analyze reported no always-on
            cost (run <code>forge analyze</code>).
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 font-mono text-sm">
          <Scissors className="size-3.5 text-destructive" />
          Cut first
          <Badge variant="destructive" className="ml-1 font-mono text-[10px]">
            {fmt.format(totalWaste)} tok
          </Badge>
        </CardTitle>
        <p className="font-mono text-[11px] text-muted-foreground">
          {fmt.format(rows.length)} always-on artifact(s) never invoked in the
          window — pure resident cost. Highest cost first.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Scatter: x = invocations (all 0 here), y = always-on cost. Top-left
            (high cost, zero usage) is the cut-first quadrant. */}
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 12, left: -8, bottom: 4 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="count"
                name="invocations"
                stroke={AXIS}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                allowDecimals={false}
                domain={[0, "dataMax"]}
                label={{
                  value: "invocations",
                  position: "insideBottom",
                  offset: -2,
                  fontSize: 9,
                  fill: AXIS,
                }}
              />
              <YAxis
                type="number"
                dataKey="cost"
                name="always-on tokens"
                stroke={AXIS}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                width={40}
              />
              <ZAxis type="number" dataKey="cost" range={[40, 320]} />
              <ReferenceLine
                x={0}
                stroke={DESTRUCTIVE}
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
              />
              <Tooltip
                contentStyle={tooltipStyle}
                cursor={{ stroke: GRID }}
                content={<ScatterTooltip />}
              />
              <Scatter data={rows} fillOpacity={0.85}>
                {rows.map((r) => (
                  <Cell key={r.uid} fill={kindColor(r.kind)} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        {/* Sorted candidate table — the same rows, addressable + linkable. */}
        <ScrollArea className="max-h-56">
          <Table className="font-mono text-[11px]">
            <TableHeader>
              <TableRow>
                <TableHead className="font-mono text-[10px] uppercase text-muted-foreground">
                  artifact
                </TableHead>
                <TableHead className="text-right font-mono text-[10px] uppercase text-muted-foreground">
                  always-on
                </TableHead>
                <TableHead className="text-right font-mono text-[10px] uppercase text-muted-foreground">
                  invokes
                </TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.uid}>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block size-2 shrink-0 rounded-sm"
                        style={{ background: kindColor(r.kind) }}
                        aria-hidden
                      />
                      <span className="text-muted-foreground">{r.kind}</span>
                      <span className="truncate text-foreground">{r.id}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-foreground">
                    {fmt.format(r.cost)}
                    {maxCost > 0 ? (
                      <span className="ml-1 text-muted-foreground">
                        ({Math.round((r.cost / maxCost) * 100)}%)
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-destructive">
                    {r.count}
                  </TableCell>
                  <TableCell className="text-right">
                    {isEditable(r.kind) ? (
                      <OpenInEditor
                        kind={r.kind}
                        id={r.id}
                        iconOnly
                        size="sm"
                        className="h-6 px-2"
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/** Tooltip for the cost×usage scatter — shows the candidate behind a point. */
function ScatterTooltip({
  active,
  payload,
}: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as CostRow | undefined;
  if (!row) return null;
  return (
    <div style={tooltipStyle} className="px-2 py-1">
      <p className="text-foreground">
        {row.kind} · {row.id}
      </p>
      <p className="text-muted-foreground">
        {fmt.format(row.cost)} tok always-on · {row.count} invoke(s)
      </p>
    </div>
  );
}
