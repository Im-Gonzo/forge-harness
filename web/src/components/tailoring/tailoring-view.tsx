"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronRight,
  Filter,
  GitFork,
  Layers,
  Loader2,
  Lock,
  Pin,
  Plus,
  Power,
  SlidersHorizontal,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { KindBadge, SourceChip, StatusPill, TailoredChip } from "@/components/forge";
import { cn } from "@/lib/utils";
import type {
  BridgeEnvelope,
  CompositionEntry,
  Overlay,
  ResolvedPreview,
  TailoredEntry,
  TailoringData,
} from "@/lib/types";

// ──────────────────────────────────────────────────────────────────────────
// POST helper — add / remove an overlay rides POST /api/tailoring (active-scope;
// the bridge resolves the root, the same convention as /api/conflicts and
// /api/composition). Returns the parsed C3 envelope, or null after surfacing the
// error toast. Overlays are RECORDED INTENTIONS in a SEPARATE additive store
// (.forge/tailoring.json) — never applied to real .claude/ files here (Slice 5).
// ──────────────────────────────────────────────────────────────────────────

type TailorPostBody =
  | { action: "add"; uid: string; type: string; detail?: string; sourceId?: string | null }
  | { action: "remove"; uid: string; type: string; detail?: string; sourceId?: string | null };

async function postTailoring(
  body: TailorPostBody,
): Promise<BridgeEnvelope | null> {
  const res = await fetch("/api/tailoring", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json()) as
    | BridgeEnvelope
    | { ok: false; error: string };
  if (!res.ok || !json.ok) {
    const msg =
      "error" in json && typeof json.error === "string"
        ? json.error
        : ((json as BridgeEnvelope).findings?.find((f) => f.level === "ERROR")
            ?.message ?? "Tailoring action failed.");
    toast.error(msg);
    return null;
  }
  return json as BridgeEnvelope;
}

// ──────────────────────────────────────────────────────────────────────────
// Overlay metadata — the prototype OVERLAY_META labels + glyphs, plus the
// add-overlay defaults (ADDABLE). The CLI validates the type + dedupes per the
// rules; the detail strings here mirror the prototype examples (a starting point
// the user can re-add with a different value later — preview-by-default).
// ──────────────────────────────────────────────────────────────────────────

type OverlayType = "pin" | "override" | "layer" | "gate" | "fork" | "disable";

const OVERLAY_META: Record<
  OverlayType,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  pin: { label: "pin version", icon: Pin },
  override: { label: "override frontmatter", icon: SlidersHorizontal },
  layer: { label: "layer on top", icon: Layers },
  gate: { label: "gate · conditional", icon: Filter },
  fork: { label: "fork body", icon: GitFork },
  disable: { label: "disabled", icon: Power },
};

function overlayMeta(type: string) {
  return (
    OVERLAY_META[type as OverlayType] ?? {
      label: type,
      icon: SlidersHorizontal,
    }
  );
}

/** The add-overlay buttons offered in the project-overlays pane (per the contract). */
const ADDABLE: { type: OverlayType; detail?: string; label: string }[] = [
  { type: "pin", detail: "v3.2.0", label: "pin version" },
  { type: "override", detail: "model → opus", label: "override field" },
  { type: "gate", detail: "paths: src/**", label: "add gate" },
  { type: "layer", detail: "+ project rule fragment", label: "layer on top" },
  { type: "fork", detail: "body detached", label: "fork body" },
  { type: "disable", detail: undefined, label: "disable" },
];

// ──────────────────────────────────────────────────────────────────────────
// Tailorable row model — the union of every ADOPTED resource (the tailorable
// universe, from the composition) with the entries that already carry overlays
// (the tailoring read, which also supplies the resolved preview). A resource
// with no overlays still appears, ready to tailor.
// ──────────────────────────────────────────────────────────────────────────

type Row = {
  uid: string;
  sourceId: string | null;
  kind: string;
  version: string;
  criticality: string;
  overlays: Overlay[];
  resolved: ResolvedPreview | null;
};

/** Stable per-(uid, sourceId) key — null sourceId is the library-local copy. */
function rowKey(r: { uid: string; sourceId: string | null }): string {
  return `${r.sourceId ?? "lib"}:${r.uid}`;
}

function mergeRows(
  tailored: TailoredEntry[],
  adopted: CompositionEntry[],
): Row[] {
  const byKey = new Map<string, Row>();

  // Seed from the adopted composition — every adopted resource is tailorable.
  for (const e of adopted) {
    byKey.set(rowKey(e), {
      uid: e.uid,
      sourceId: e.sourceId,
      kind: e.kind,
      version: e.version,
      criticality: e.criticality,
      overlays: [],
      resolved: null,
    });
  }

  // Fold in the tailoring read — overlays + the resolved preview (and the
  // catalog-joined kind). An already-tailored entry whose resource is no longer
  // adopted is DROPPED by the CLI read, so it never appears here without a seed;
  // we still defensively upsert so a tailored entry is never lost from the view.
  for (const t of tailored) {
    const key = rowKey(t);
    const seed = byKey.get(key);
    byKey.set(key, {
      uid: t.uid,
      sourceId: t.sourceId,
      kind: t.kind || seed?.kind || "",
      version: t.resolved.version || seed?.version || "",
      criticality: seed?.criticality ?? "",
      overlays: t.overlays,
      resolved: t.resolved,
    });
  }

  return Array.from(byKey.values()).sort((a, b) => {
    if (a.uid !== b.uid) return a.uid.localeCompare(b.uid);
    return rowKey(a).localeCompare(rowKey(b));
  });
}

// ──────────────────────────────────────────────────────────────────────────
// TailoringView — the prototype TailoringView (list) + TailorDetail. Selecting a
// row opens the base + overlays + resolved-preview panes. Add-overlay buttons per
// type + a Remove on each overlay card, wired to POST /api/tailoring with a busy
// state, a toast, and router.refresh().
// ──────────────────────────────────────────────────────────────────────────

export function TailoringView({
  data,
  adopted = [],
}: {
  data: TailoringData;
  /**
   * The per-project ADOPTED composition entries (ADR-0019) — the tailorable
   * universe. Every adopted resource appears in the list, even with no overlays
   * yet; the tailoring read supplies overlays + the resolved preview for those
   * that carry them. Defaults to none (only already-tailored entries show).
   */
  adopted?: CompositionEntry[];
}) {
  const router = useRouter();
  const { tailored, counts, tailoringPath } = data;

  const rows = React.useMemo(
    () => mergeRows(tailored, adopted),
    [tailored, adopted],
  );

  // Detail selection — the tailor panel opens for one resource at a time, keyed
  // by (uid, sourceId).
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const active = React.useMemo(
    () => rows.find((r) => rowKey(r) === activeKey) ?? null,
    [rows, activeKey],
  );

  // Single in-flight slot for the add/remove mutation.
  const [busy, setBusy] = React.useState(false);

  const runAdd = React.useCallback(
    async (row: Row, type: OverlayType, detail?: string) => {
      setBusy(true);
      try {
        const env = await postTailoring({
          action: "add",
          uid: row.uid,
          type,
          detail,
          sourceId: row.sourceId,
        });
        if (!env) return;
        toast.success(
          `Applied overlay · ${overlayMeta(type).label} on ${row.uid}.`,
        );
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const runRemove = React.useCallback(
    async (row: Row, overlay: Overlay) => {
      setBusy(true);
      try {
        const env = await postTailoring({
          action: "remove",
          uid: row.uid,
          type: overlay.type,
          detail: overlay.detail || undefined,
          sourceId: row.sourceId,
        });
        if (!env) return;
        toast.success(
          `Removed ${overlayMeta(overlay.type).label} overlay from ${row.uid}.`,
        );
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  // ── Detail view — base + overlays + resolved preview for one resource ──────
  if (active) {
    return (
      <TailorDetail
        row={active}
        busy={busy}
        onBack={() => setActiveKey(null)}
        onAdd={runAdd}
        onRemove={runRemove}
      />
    );
  }

  // ── List view — stat strip + the tailorable/tailored table ─────────────────
  const tailoredRows = rows.filter((r) => r.overlays.length > 0).length;

  return (
    <div className="flex flex-col gap-5">
      {/* Intro banner — explains the overlay model (project-toned, calm). */}
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-state-ok/40 bg-state-ok/[0.06] px-4 py-3 font-mono text-[length:var(--text-sm)] text-foreground">
        <SlidersHorizontal className="size-4 shrink-0 text-state-ok" />
        <span>
          Make a source resource yours without mutating it — pin a version,
          override frontmatter, gate activation, layer a project rule on top, or
          fork the body. Pick an adopted resource to open its{" "}
          <b className="text-foreground">base + overlays</b> view.
        </span>
      </div>

      {/* Roll-up stat strip. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatPanel
          icon={<SlidersHorizontal className="size-3" />}
          title="tailored"
          metric={tailoredRows}
          caption="resources with overlays"
          tone={tailoredRows > 0 ? "ok" : "neutral"}
        />
        <StatPanel
          icon={<Layers className="size-3" />}
          title="overlays"
          metric={counts.overlays}
          caption="recorded intentions"
          tone="neutral"
        />
        <StatPanel
          icon={<Plus className="size-3" />}
          title="tailorable"
          metric={rows.length}
          caption="adopted resources"
          tone="neutral"
        />
        {/* PLACEHOLDER — overlays APPLY to real files in Slice 5 (compose --write). */}
        <StatPanel
          title="applied"
          metric="—"
          caption="compose --write · Slice 5"
          tone="nodata"
        />
      </div>

      {/* Tailorable table — the prototype `.cat` grid. Every adopted resource is
          a row; selecting one opens its base + overlays + resolved-preview panes. */}
      <div className="overflow-hidden rounded-lg ring-1 ring-border">
        <Table className="text-[length:var(--text-xs)]">
          <TableHeader className="sticky top-0 z-10 bg-muted/45 backdrop-blur">
            <TableRow className="hover:bg-transparent">
              <Th>uid</Th>
              <Th>source</Th>
              <Th>kind</Th>
              <Th>overlays</Th>
              <TableHead className="w-px text-right font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
                <span className="sr-only">open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-12 text-center font-mono text-[length:var(--text-sm)] text-muted-foreground"
                >
                  Nothing adopted yet — only adopted resources can be tailored.
                  Adopt resources on the Browse &amp; Adopt page, then tailor
                  them here.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const key = rowKey(row);
                return (
                  <TableRow
                    key={key}
                    onClick={() => setActiveKey(key)}
                    className="cursor-pointer align-top transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:bg-muted/35"
                  >
                    <TableCell className="px-3 py-2.5 font-mono font-medium whitespace-nowrap text-foreground">
                      {row.uid}
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <span
                        title={
                          row.sourceId
                            ? `adopted from source "${row.sourceId}"`
                            : "library-local copy (no external source)"
                        }
                      >
                        <SourceChip
                          source={row.sourceId ?? "library"}
                          className={cn(
                            !row.sourceId &&
                              "border-dashed text-muted-foreground",
                          )}
                        />
                      </span>
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <KindBadge kind={row.kind} />
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      {row.overlays.length ? (
                        <TailoredChip count={row.overlays.length} compact />
                      ) : (
                        <span className="font-mono text-[length:var(--text-2xs)] text-muted-foreground/60">
                          none
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="w-px px-3 py-2 text-right">
                      <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Footer — the tailoring sidecar path. */}
      <p
        className="truncate font-mono text-[length:var(--text-2xs)] text-muted-foreground"
        title={tailoringPath}
      >
        {tailoringPath}
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// TailorDetail — the prototype detail: a base (read-only) pane + a project-
// overlays pane (dashed, project-toned cards with a Remove each + add-overlay
// buttons per type) + a resolved-preview pane. The resolved preview is the CLI's
// deterministic fold; we DISPLAY it (never recompute) and mark fields that the
// overlays changed.
// ──────────────────────────────────────────────────────────────────────────

function TailorDetail({
  row,
  busy,
  onBack,
  onAdd,
  onRemove,
}: {
  row: Row;
  busy: boolean;
  onBack: () => void;
  onAdd: (row: Row, type: OverlayType, detail?: string) => void | Promise<void>;
  onRemove: (row: Row, overlay: Overlay) => void | Promise<void>;
}) {
  const { overlays, resolved } = row;
  const hasOverlay = (type: OverlayType) =>
    overlays.some((o) => o.type === type);

  // The base values: when no resolved preview exists yet (a freshly adopted,
  // untailored resource), the base is the resolved's "source-tracking" defaults.
  // The CLI is the source of truth for the resolved fold; we render its output.
  const r: ResolvedPreview = resolved ?? {
    model: "—",
    residency: "—",
    activation: "default",
    body: "tracks source",
    status: "active",
    version: row.version || "—",
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Back link */}
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 font-mono text-[length:var(--text-xs)] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        tailoring
      </button>

      {/* Head — uid + source + version + overlay count + kind. */}
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h2 className="font-mono text-[length:var(--text-xl)] font-semibold leading-none text-foreground">
            {row.uid}
          </h2>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <span
              title={
                row.sourceId
                  ? `adopted from source "${row.sourceId}"`
                  : "library-local copy (no external source)"
              }
            >
              <SourceChip
                source={row.sourceId ?? "library"}
                className={cn(
                  !row.sourceId && "border-dashed text-muted-foreground",
                )}
              />
            </span>
            <span className="font-mono text-[length:var(--text-xs)] text-muted-foreground">
              {r.version}
            </span>
            {overlays.length ? (
              <TailoredChip count={overlays.length} />
            ) : null}
          </p>
        </div>
        <KindBadge kind={row.kind} />
      </div>

      {/* Base + overlays panes — the prototype `.detail` two-up grid. */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* BASE — read-only, core-toned left border. */}
        <div className="overflow-hidden rounded-lg border border-border border-l-2 border-l-state-info/60 bg-card">
          <PaneHead icon={<Lock className="size-3.5" />}>
            source base · read-only
          </PaneHead>
          <div className="p-4">
            <FmRow k="model" v={r.model} />
            <FmRow k="residency" v={r.residency} />
            <FmRow k="criticality" v={row.criticality || "—"} />
            <FmRow k="status" v={r.status} />
            <div className="mt-3.5 mb-1.5 font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
              body
            </div>
            <div className="flex flex-col gap-[7px]">
              {[92, 78, 85, 60].map((w, i) => (
                <span
                  key={i}
                  aria-hidden
                  className="block h-[7px] rounded-[3px] bg-muted"
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* OVERLAYS — dashed, project-toned cards + the add buttons. */}
        <div className="overflow-hidden rounded-lg border border-border border-l-2 border-l-state-ok/60 bg-card">
          <PaneHead
            icon={<SlidersHorizontal className="size-3.5 text-state-ok" />}
          >
            project overlays
          </PaneHead>
          <div className="p-4">
            {overlays.length ? (
              <div className="flex flex-col gap-2">
                {overlays.map((o, i) => {
                  const meta = overlayMeta(o.type);
                  const Glyph = meta.icon;
                  return (
                    <div
                      key={`${o.type}:${o.detail}:${i}`}
                      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md border border-dashed border-state-ok/45 bg-state-ok/[0.06] px-3 py-2.5"
                    >
                      <span className="flex size-[26px] items-center justify-center rounded-sm border border-state-ok/30 text-state-ok">
                        <Glyph className="size-3.5" />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[length:var(--text-xs)] text-foreground">
                          {meta.label}
                        </div>
                        {o.detail ? (
                          <div className="mt-0.5 truncate font-mono text-[length:var(--text-2xs)] text-muted-foreground">
                            {o.detail}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={busy}
                        onClick={() => onRemove(row, o)}
                        title="remove overlay"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        {busy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <X className="size-3" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="py-2 font-mono text-[length:var(--text-xs)] text-muted-foreground">
                No overlays yet — this resource runs exactly as the source ships
                it.
              </p>
            )}

            {/* Add-overlay buttons per type. A second pin/override/disable/fork
                REPLACES the latest detail per type (the CLI dedupes); layer/gate
                dedupe by (type, detail). The detail strings here are starting
                examples — preview-by-default. */}
            <div className="mt-3 flex flex-wrap gap-2">
              {ADDABLE.map((a) => {
                const Glyph = overlayMeta(a.type).icon;
                const already = hasOverlay(a.type);
                return (
                  <Button
                    key={`${a.type}:${a.detail ?? ""}`}
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() => onAdd(row, a.type, a.detail)}
                    title={
                      already
                        ? `replace the existing ${a.type} overlay`
                        : `add a ${a.type} overlay`
                    }
                    className={cn(
                      "border-dashed border-state-ok/45 font-mono text-[length:var(--text-xs)] text-state-ok hover:bg-state-ok/10 hover:text-state-ok",
                      already && "opacity-70",
                    )}
                  >
                    <Glyph className="size-3" />
                    {a.label}
                  </Button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* RESOLVED preview — the CLI's deterministic fold (display-only). */}
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
          <Zap className="size-3.5" />
          resolved preview
          <span className="flex-1" />
          <StatusPill tone="neutral">view · not applied</StatusPill>
        </div>
        <div className="p-4">
          <FmRow k="model" v={r.model} changed={hasOverlay("override")} />
          <FmRow k="residency" v={r.residency} />
          <FmRow k="activation" v={r.activation} changed={hasOverlay("gate")} />
          <FmRow
            k="body"
            v={r.body}
            changed={hasOverlay("fork") || hasOverlay("layer")}
          />
          <FmRow k="status" v={r.status} changed={hasOverlay("disable")} />
          <FmRow k="version" v={r.version} changed={hasOverlay("pin")} />
        </div>
      </div>

      {/* Footnote — overlays are recorded intentions, applied in Slice 5. */}
      <p className="font-mono text-[length:var(--text-xs)] leading-[var(--leading-snug)] text-muted-foreground">
        Overlays are recorded intentions in{" "}
        <span className="text-foreground">.forge/tailoring.json</span> — the
        resolved preview is a deterministic, display-only view. Nothing is written
        to the library or real .claude/ files here; application is{" "}
        <span className="text-foreground">compose --write</span> (Slice 5).
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Small presentational helpers — the prototype `.pane-head`, `.fm-row` (with the
// `.changed` project-toned variant), and the Composition-style StatPanel.
// ──────────────────────────────────────────────────────────────────────────

function PaneHead({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-3 font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

function FmRow({
  k,
  v,
  changed = false,
}: {
  k: string;
  v: string;
  changed?: boolean;
}) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 border-b border-border py-[7px] font-mono text-[length:var(--text-xs)] last:border-b-0">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn(changed ? "text-state-ok" : "text-foreground")}>
        {v}
      </span>
    </div>
  );
}

type StatTone = "ok" | "neutral" | "nodata";

const DOT_CLASS: Record<StatTone, string> = {
  ok: "bg-state-ok",
  neutral: "bg-muted-foreground",
  nodata: "bg-border",
};

function StatPanel({
  icon,
  title,
  metric,
  caption,
  tone = "neutral",
}: {
  icon?: React.ReactNode;
  title: string;
  metric: React.ReactNode;
  caption?: React.ReactNode;
  tone?: StatTone;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
            {icon}
            {title}
          </span>
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])}
          />
        </div>
        <span
          className={cn(
            "font-mono text-2xl font-semibold leading-none tracking-[var(--tracking-tight)] tabular-nums",
            tone === "nodata" ? "text-muted-foreground/50" : "text-foreground",
          )}
        >
          {metric}
        </span>
        {caption ? (
          <span className="font-mono text-[length:var(--text-2xs)] text-muted-foreground">
            {caption}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <TableHead className="h-9 px-3 font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
      {children}
    </TableHead>
  );
}
