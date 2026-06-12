"use client";

/**
 * Telemetry charts (client) — the full `forge stat` rollup, broken into one
 * panel per signal. Rendered only when telemetry is ON and has events; the
 * server page owns the OFF/empty branch, so this component assumes a non-null
 * payload. Every panel still degrades to its own clean empty case (a window can
 * have events of one kind but none of another).
 *
 * T4 — full breakdowns:
 *  - Daily event-count time-series (area)        ← data.trend.{days,counts}
 *  - Event-type breakdown (bars)                 ← data.byType
 *  - Hook fires vs denies + deny-rate line       ← data.denyRates
 *  - Sortable deny-rates table (high rate first) ← data.denyRates
 *  - Most-invoked artifacts (bars + list, T5)    ← data.mostInvoked
 *  - Slowest hooks p50/p95/n table               ← data.slowestHooks
 *  - Typecheck pass/fail rollup                  ← data.typecheck
 *
 * T5 — per-artifact drill-down: each mostInvoked row links to its editor
 * (editorHref via OpenInEditor) when its key is a "<kind>:<id>" uid for an
 * editable ResourceKind; plain artifact_ids / event_types render as text. A row
 * click expands a mini detail (count, share, rank, global trend sparkline).
 */
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CheckCircle2,
  Gauge,
  Timer,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OpenInEditor } from "@/components/open-in-editor";
import type { TelemetryStatData } from "@/components/telemetry/types";
import type { ResourceKind } from "@/lib/types";

const AXIS = "var(--color-muted-foreground)";
const GRID = "var(--color-border)";
const C1 = "var(--color-chart-1)";
const C2 = "var(--color-chart-2)";
const DESTRUCTIVE = "var(--color-destructive)";

const fmt = new Intl.NumberFormat("en-US");
/** ms with one decimal when sub-10ms, else whole ms — for p50/p95. */
function fmtMs(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n < 10 ? `${n.toFixed(1)}ms` : `${Math.round(n)}ms`;
}

const tooltipStyle = {
  background: "var(--color-card)",
  border: `1px solid ${GRID}`,
  borderRadius: 8,
  fontSize: 11,
  fontFamily: "var(--font-mono, monospace)",
  color: "var(--color-card-foreground)",
} as const;

/**
 * ResourceKinds that have an on-disk editor route (OpenInEditor targets). Used
 * to decide whether a `mostInvoked` key resolves to an editable artifact (T5).
 */
const EDITABLE_KINDS: ReadonlySet<string> = new Set<ResourceKind>([
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "memory",
  "hook",
]);

/**
 * Resolve a `mostInvoked` key to an editable resource, if possible. Keys are
 * emitted as an `artifact_id` (kind-local id, no kind) or an `event_type`. Only
 * a "<kind>:<id>" uid-form key carries enough to address the editor; a bare id
 * or an event_type can't be safely mapped to a kind, so it renders as text.
 */
function resolveEditor(key: string): { kind: ResourceKind; id: string } | null {
  const sep = key.indexOf(":");
  if (sep <= 0) return null;
  const kind = key.slice(0, sep);
  const id = key.slice(sep + 1);
  if (!id || !EDITABLE_KINDS.has(kind)) return null;
  return { kind: kind as ResourceKind, id };
}

function ChartFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
        <p className="font-mono text-[11px] text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent className="h-56">{children}</CardContent>
    </Card>
  );
}

/** A panel whose body height is content-driven (tables/lists), not a fixed chart. */
function PanelFrame({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">
          {icon}
          {title}
        </CardTitle>
        <p className="font-mono text-[11px] text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export interface TelemetryChartsProps {
  /** The `forge stat` rollup (non-null — the server owns the OFF/empty branch). */
  data: TelemetryStatData;
  /**
   * Optional T5 drill-down callback: invoked with a `mostInvoked` key (an
   * artifact_id or event_type) when the user focuses a row. The workspace can
   * pass a handler (e.g. to highlight the matching worklist row). Absent ⇒ the
   * row click only toggles the in-panel mini detail.
   */
  onFocusArtifact?: (key: string) => void;
}

export function TelemetryCharts({ data, onFocusArtifact }: TelemetryChartsProps) {
  // Daily time-series: zip trend.days + trend.counts into recharts rows.
  const series = data.trend.days.map((day, i) => ({
    day: day.slice(5), // mm-dd for a tight axis
    events: data.trend.counts[i] ?? 0,
  }));

  // Hook fires / denies per rule + the deny rate as a percent for the line.
  const denyRows = data.denyRates.map((r) => ({
    rule: r.rule,
    fires: r.fires,
    denies: r.denies,
    denyPct: Number((r.denyRate * 100).toFixed(1)),
  }));

  const byTypeRows = Object.entries(data.byType)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Daily event-count time-series */}
      <ChartFrame
        title="Events over time"
        subtitle={`${data.events} event(s)${
          data.since ? ` · since ${data.since}` : ""
        } · last ${series.length} day(s)`}
      >
        {series.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="ev" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C2} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={C2} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="day"
                stroke={AXIS}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
              />
              <YAxis
                stroke={AXIS}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                allowDecimals={false}
                width={32}
              />
              <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: GRID }} />
              <Area
                type="monotone"
                dataKey="events"
                name="events"
                stroke={C2}
                fill="url(#ev)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label="No daily trend recorded." />
        )}
      </ChartFrame>

      {/* Event-type breakdown */}
      <ChartFrame
        title="Events by type"
        subtitle={
          byTypeRows.length
            ? `${byTypeRows.length} event type(s)`
            : "no events in window"
        }
      >
        {byTypeRows.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byTypeRows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="type"
                stroke={AXIS}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
              />
              <YAxis
                stroke={AXIS}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                allowDecimals={false}
                width={32}
              />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--color-muted)" }} />
              <Bar dataKey="count" name="count" fill={C2} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label="No events by type." />
        )}
      </ChartFrame>

      {/* Hook fires vs denies + deny-rate line */}
      <ChartFrame
        title="Hook fires & deny rate"
        subtitle={
          denyRows.length
            ? `${denyRows.length} rule(s) with hook activity`
            : "no hook rules fired in window"
        }
      >
        {denyRows.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={denyRows}
              margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
            >
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="rule"
                stroke={AXIS}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
              />
              <YAxis
                yAxisId="count"
                stroke={AXIS}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                allowDecimals={false}
                width={32}
              />
              <YAxis
                yAxisId="rate"
                orientation="right"
                stroke={AXIS}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                domain={[0, 100]}
                unit="%"
                width={36}
              />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--color-muted)" }} />
              <Bar yAxisId="count" dataKey="fires" name="fires" fill={C1} radius={[3, 3, 0, 0]} />
              <Bar
                yAxisId="count"
                dataKey="denies"
                name="denies"
                fill={DESTRUCTIVE}
                radius={[3, 3, 0, 0]}
              />
              <Line
                yAxisId="rate"
                type="monotone"
                dataKey="denyPct"
                name="deny %"
                stroke={DESTRUCTIVE}
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label="No hook fires recorded." />
        )}
      </ChartFrame>

      {/* Sortable deny-rates table (high deny-rate first) */}
      <DenyRatesTable data={data} />

      {/* Most-invoked artifacts (bars + editor-linked drill-down list, T5) */}
      <MostInvokedPanel data={data} onFocusArtifact={onFocusArtifact} />

      {/* Slowest hooks p50/p95/n */}
      <SlowestHooksTable data={data} />

      {/* Typecheck pass/fail rollup */}
      <TypecheckPanel data={data} />
    </div>
  );
}

// ── Sortable deny-rates table ───────────────────────────────────────────────

type DenySortKey = "rule" | "fires" | "denies" | "denyRate";

function DenyRatesTable({ data }: { data: TelemetryStatData }) {
  // Default: highest deny-rate first (the headline "what's blocking most" view).
  const [sort, setSort] = useState<DenySortKey>("denyRate");
  const [asc, setAsc] = useState(false);

  const rows = useMemo(() => {
    const copy = [...data.denyRates];
    copy.sort((a, b) => {
      let d: number;
      if (sort === "rule") d = a.rule.localeCompare(b.rule);
      else d = a[sort] - b[sort];
      // Stable tiebreak by rule so equal rows don't shuffle.
      if (d === 0) d = a.rule.localeCompare(b.rule);
      return asc ? d : -d;
    });
    return copy;
  }, [data.denyRates, sort, asc]);

  function toggle(key: DenySortKey) {
    if (key === sort) {
      setAsc((v) => !v);
    } else {
      setSort(key);
      // Numeric columns default high→low; the rule column defaults A→Z.
      setAsc(key === "rule");
    }
  }

  return (
    <PanelFrame
      title="Deny rates by rule"
      subtitle={
        rows.length ? `${rows.length} rule(s) · sortable` : "no hook rules fired"
      }
    >
      {rows.length ? (
        <Table className="font-mono text-[11px]">
          <TableHeader>
            <TableRow>
              <SortableHead label="rule" col="rule" sort={sort} asc={asc} onClick={toggle} />
              <SortableHead label="fires" col="fires" sort={sort} asc={asc} onClick={toggle} align="right" />
              <SortableHead label="denies" col="denies" sort={sort} asc={asc} onClick={toggle} align="right" />
              <SortableHead label="rate" col="denyRate" sort={sort} asc={asc} onClick={toggle} align="right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const pct = r.denyRate * 100;
              const hot = pct >= 50;
              return (
                <TableRow key={r.rule}>
                  <TableCell className="max-w-[180px] truncate text-foreground" title={r.rule}>
                    {r.rule}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {fmt.format(r.fires)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {fmt.format(r.denies)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={
                        hot
                          ? "text-destructive"
                          : pct > 0
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground"
                      }
                    >
                      {pct.toFixed(1)}%
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <EmptyRow label="No hook rules fired in window." />
      )}
    </PanelFrame>
  );
}

function SortableHead({
  label,
  col,
  sort,
  asc,
  onClick,
  align = "left",
}: {
  label: string;
  col: DenySortKey;
  sort: DenySortKey;
  asc: boolean;
  onClick: (c: DenySortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort === col;
  return (
    <TableHead
      className={align === "right" ? "text-right" : undefined}
      aria-sort={active ? (asc ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onClick(col)}
        className={
          "inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide transition-colors " +
          (active ? "text-foreground" : "text-muted-foreground hover:text-foreground")
        }
      >
        {label}
        {active ? (
          asc ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : null}
      </button>
    </TableHead>
  );
}

// ── Most-invoked artifacts (bars + drill-down list) ─────────────────────────

function MostInvokedPanel({
  data,
  onFocusArtifact,
}: {
  data: TelemetryStatData;
  onFocusArtifact?: (key: string) => void;
}) {
  // Most → least (the payload is already sorted, but make it explicit/safe).
  const rows = useMemo(
    () => [...data.mostInvoked].sort((a, b) => b.count - a.count),
    [data.mostInvoked],
  );
  const top = rows.slice(0, 10);
  const max = top[0]?.count ?? 0;
  const [open, setOpen] = useState<string | null>(null);

  return (
    <PanelFrame
      title="Most-invoked artifacts"
      subtitle={
        rows.length
          ? `${rows.length} key(s) · most → least`
          : "no agent/skill invocations in window"
      }
    >
      {rows.length ? (
        <ul className="flex flex-col divide-y divide-border">
          {top.map((r, i) => {
            const editor = resolveEditor(r.key);
            const isOpen = open === r.key;
            const pct = data.events > 0 ? (r.count / data.events) * 100 : 0;
            const barPct = max > 0 ? (r.count / max) * 100 : 0;
            return (
              <li key={r.key} className="py-1.5 font-mono text-[11px]">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(isOpen ? null : r.key);
                      onFocusArtifact?.(r.key);
                    }}
                    aria-expanded={isOpen}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronRight
                      className={
                        "size-3 shrink-0 transition-transform " +
                        (isOpen ? "rotate-90" : "")
                      }
                    />
                    <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="truncate text-foreground" title={r.key}>
                      {r.key}
                    </span>
                  </button>
                  <span className="shrink-0 tabular-nums text-foreground">
                    {fmt.format(r.count)}
                  </span>
                  {editor ? (
                    <OpenInEditor
                      kind={editor.kind}
                      id={editor.id}
                      iconOnly
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 text-muted-foreground"
                    />
                  ) : null}
                </div>

                {/* Proportional bar — the recharts-free, accessible read. */}
                <div className="mt-1 ml-[1.45rem] h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${barPct}%`, background: C1 }}
                  />
                </div>

                {/* Click-to-expand mini detail (T5). */}
                {isOpen ? (
                  <div className="mt-2 ml-[1.45rem] rounded-md border border-border bg-muted/30 p-2 text-[10px] text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>
                        rank <span className="text-foreground">#{i + 1}</span>
                      </span>
                      <span>
                        count{" "}
                        <span className="text-foreground">{fmt.format(r.count)}</span>
                      </span>
                      <span>
                        share{" "}
                        <span className="text-foreground">{pct.toFixed(1)}%</span> of
                        all events
                      </span>
                      {editor ? (
                        <Badge
                          variant="outline"
                          className="h-4 px-1.5 font-mono text-[9px] text-muted-foreground"
                        >
                          {editor.kind}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="h-4 px-1.5 font-mono text-[9px] text-muted-foreground"
                        >
                          event_type / id
                        </Badge>
                      )}
                    </div>
                    {/* Per-key daily series isn't in the rollup; show the window's
                        overall daily trend as context. */}
                    <div className="mt-1.5">
                      <span className="text-[9px] uppercase tracking-wide">
                        window trend
                      </span>
                      <span className="ml-1.5 font-mono text-foreground">
                        {data.trend.sparkline || "—"}
                      </span>
                    </div>
                    {!editor ? (
                      <p className="mt-1 text-[9px]">
                        plain key (no kind) — not editor-addressable
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
          {rows.length > top.length ? (
            <li className="pt-1.5 font-mono text-[10px] text-muted-foreground">
              +{rows.length - top.length} more not shown
            </li>
          ) : null}
        </ul>
      ) : (
        <EmptyRow label="No agent/skill invocations recorded." />
      )}
    </PanelFrame>
  );
}

// ── Slowest hooks (p50 / p95 / n) ───────────────────────────────────────────

function SlowestHooksTable({ data }: { data: TelemetryStatData }) {
  // Slowest first by p95 (nulls last), then p50.
  const rows = useMemo(() => {
    const copy = [...data.slowestHooks];
    copy.sort((a, b) => {
      const ap = a.p95 ?? -1;
      const bp = b.p95 ?? -1;
      if (bp !== ap) return bp - ap;
      return (b.p50 ?? -1) - (a.p50 ?? -1);
    });
    return copy;
  }, [data.slowestHooks]);

  return (
    <PanelFrame
      title="Slowest hooks"
      subtitle={
        rows.length ? `${rows.length} rule(s) · by p95` : "no hook timings recorded"
      }
      icon={<Timer className="size-3.5" />}
    >
      {rows.length ? (
        <Table className="font-mono text-[11px]">
          <TableHeader>
            <TableRow>
              <TableHead className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                rule
              </TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                p50
              </TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                p95
              </TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                n
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.rule}>
                <TableCell className="max-w-[180px] truncate text-foreground" title={r.rule}>
                  {r.rule}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {fmtMs(r.p50)}
                </TableCell>
                <TableCell className="text-right text-foreground">
                  {fmtMs(r.p95)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {fmt.format(r.n)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyRow label="No hook timings recorded in window." />
      )}
    </PanelFrame>
  );
}

// ── Typecheck rollup ────────────────────────────────────────────────────────

function TypecheckPanel({ data }: { data: TelemetryStatData }) {
  const { runs, fails, failPct } = data.typecheck;
  const passes = Math.max(0, runs - fails);
  const passPct = runs > 0 ? 100 - failPct : 0;

  return (
    <PanelFrame
      title="Typecheck"
      subtitle={runs ? `${fmt.format(runs)} run(s) recorded` : "no typecheck runs"}
      icon={<Gauge className="size-3.5" />}
    >
      {runs ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2 font-mono">
            <Stat label="runs" value={fmt.format(runs)} />
            <Stat
              label="passed"
              value={fmt.format(passes)}
              tone="ok"
              icon={<CheckCircle2 className="size-3" />}
            />
            <Stat
              label="failed"
              value={fmt.format(fails)}
              tone={fails > 0 ? "bad" : undefined}
              icon={fails > 0 ? <XCircle className="size-3" /> : undefined}
            />
          </div>
          {/* Pass/fail proportion bar. */}
          <div>
            <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
              <span>
                pass rate{" "}
                <span className="text-foreground">{passPct.toFixed(1)}%</span>
              </span>
              <span>
                fail rate{" "}
                <span className={fails > 0 ? "text-destructive" : "text-foreground"}>
                  {failPct.toFixed(1)}%
                </span>
              </span>
            </div>
            <div className="flex h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full"
                style={{ width: `${passPct}%`, background: C2 }}
              />
              <div
                className="h-full"
                style={{ width: `${failPct}%`, background: DESTRUCTIVE }}
              />
            </div>
          </div>
        </div>
      ) : (
        <EmptyRow label="No typecheck runs recorded in window." />
      )}
    </PanelFrame>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone?: "ok" | "bad";
  icon?: React.ReactNode;
}) {
  const valueClass =
    tone === "bad"
      ? "text-destructive"
      : tone === "ok"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-muted/20 px-2 py-1.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={`flex items-center gap-1 text-sm ${valueClass}`}>
        {icon}
        {value}
      </span>
    </div>
  );
}

// ── Shared empties ──────────────────────────────────────────────────────────

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="font-mono text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <p className="py-6 text-center font-mono text-[11px] text-muted-foreground">
      {label}
    </p>
  );
}
