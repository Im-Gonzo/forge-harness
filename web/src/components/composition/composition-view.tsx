"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Layers,
  Loader2,
  PackageSearch,
  Plus,
  Scale,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { KindBadge, SourceChip, StatusPill, TailoredChip } from "@/components/forge";
import { cn } from "@/lib/utils";
import type { BridgeEnvelope, CompositionData, CompositionEntry } from "@/lib/types";

// ──────────────────────────────────────────────────────────────────────────
// POST helper — the remove action rides POST /api/composition (active-scope; the
// bridge resolves the root, the same convention as /api/catalog). Returns the
// parsed C3 envelope, or null after surfacing the error toast. Adopt lives on the
// PROJECT-plane Browse & Adopt surface (/browse); this view only owns the inverse
// Remove of an already-adopted entry.
// ──────────────────────────────────────────────────────────────────────────

type ComposePostBody = {
  action: "adopt" | "remove";
  uid: string;
  sourceId?: string | null;
};

async function postComposition(
  body: ComposePostBody,
): Promise<BridgeEnvelope | null> {
  const res = await fetch("/api/composition", {
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
            ?.message ?? "Composition action failed.");
    toast.error(msg);
    return null;
  }
  return json as BridgeEnvelope;
}

// The composition entry key the CLI keys on: (uid, sourceId). null = the
// library-local copy. Used both for the per-row busy slot and the remove call.
function entryKey(entry: Pick<CompositionEntry, "uid" | "sourceId">): string {
  return `${entry.sourceId ?? "lib"}:${entry.uid}`;
}

export function CompositionView({
  data,
  blockingCount = 0,
  conflictedUids = [],
  tailoredKeys = [],
}: {
  data: CompositionData;
  /**
   * Count of BLOCKING conflicts (state === "blocking") in the read-view, from
   * `forge conflict list` (ADR-0020). When > 0 the composition is not yet
   * resolvable and the banner flips to the attention-toned "blocked" variant.
   */
  blockingCount?: number;
  /**
   * The uids of the blocking conflicts — drives the per-row ⚖ affordance on an
   * adopted entry whose uid is still unresolved. The full adjudication lives on
   * /conflicts; here it is a calm marker, not an action.
   */
  conflictedUids?: string[];
  /**
   * The TAILORED entry keys ("<sourceId|'lib'>:<uid>") from `forge tailor list`
   * (ADR-0021) — an adopted resource carrying >= 1 overlay. Drives the dashed,
   * project-toned "tailored" chip on its row + the "tailored" stat panel.
   * Tailoring is managed on /tailoring; here the chip is a marker, not an action.
   */
  tailoredKeys?: string[];
}) {
  const router = useRouter();
  const { adopted, counts, compositionPath } = data;

  // Blocking-conflict read — drives the banner variant + the per-row ⚖ marker.
  const conflictedSet = React.useMemo(
    () => new Set(conflictedUids),
    [conflictedUids],
  );
  const blocked = blockingCount > 0;

  // Tailoring read — which adopted entries carry >= 1 overlay (drives the
  // dashed "tailored" chip per row + the "tailored" stat panel).
  const tailoredSet = React.useMemo(
    () => new Set(tailoredKeys),
    [tailoredKeys],
  );

  // Per-row in-flight slot keyed by (uid, sourceId) so each Remove spins
  // individually without re-rendering the whole table.
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const isBusy = busyKey !== null;

  const runRemove = React.useCallback(
    async (entry: CompositionEntry) => {
      const key = entryKey(entry);
      setBusyKey(key);
      try {
        const env = await postComposition({
          action: "remove",
          uid: entry.uid,
          sourceId: entry.sourceId,
        });
        if (!env) return;
        toast.success(
          `Removed ${entry.uid}${
            entry.sourceId ? ` (${entry.sourceId})` : ""
          } from the composition.`,
        );
        router.refresh();
      } finally {
        setBusyKey(null);
      }
    },
    [router],
  );

  return (
    <div className="flex flex-col gap-5">
      {/* ── Health banner — the prototype `.comp-banner`. Slice 3 SEAM: when the
          read surfaces BLOCKING conflicts, render the `.comp-banner.block` variant
          (attention-toned, "Composition blocked — N unresolved conflict(s)") with
          a "resolve" link to /conflicts; otherwise the calm ok-toned banner. The
          lockfile arrives in Slice 5, so the "in sync" copy is a placeholder. */}
      {blocked ? (
        <div className="flex items-center gap-3 rounded-lg border border-state-attention/40 bg-state-attention/[0.10] px-4 py-3 font-mono text-[length:var(--text-sm)] text-foreground">
          <AlertTriangle className="size-4 shrink-0 text-state-attention" />
          <span>
            <b className="text-foreground">Composition blocked</b> —{" "}
            {blockingCount} unresolved conflict
            {blockingCount === 1 ? "" : "s"} must be adjudicated before the
            composition resolves.
          </span>
          <span className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            render={<Link href="/conflicts" />}
            className="border-state-attention/45 font-mono text-[length:var(--text-xs)] text-state-attention hover:bg-state-attention/10 hover:text-state-attention"
          >
            resolve
            <ArrowRight className="size-3" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-lg border border-state-ok/35 bg-state-ok/[0.08] px-4 py-3 font-mono text-[length:var(--text-sm)] text-foreground">
          <CheckCircle2 className="size-4 shrink-0 text-state-ok" />
          <span>
            <b className="text-foreground">Composition resolved</b> — every
            adopted resource is in the read-view · 0 conflicts
          </span>
          <span className="flex-1" />
          <StatusPill tone="ok">in sync</StatusPill>
        </div>
      )}

      {/* ── Stat panels — the prototype `.stat-row` (4-up grid, mono StatPanel
          look). adopted + sources are LIVE from the composition; always-on
          budget and tailored overlays are PLACEHOLDERS ("—") — they arrive in
          later slices (budget residency reuse + Slice 4 tailoring), so they
          read as no-data, not zero. ─────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatPanel
          icon={<Layers className="size-3" />}
          title="adopted"
          metric={counts.adopted}
          caption={`${counts.sources} source${counts.sources === 1 ? "" : "s"}`}
          tone="ok"
        />
        <StatPanel
          icon={<PackageSearch className="size-3" />}
          title="sources"
          metric={counts.sources}
          caption="distinct origins"
          tone="neutral"
        />
        {/* PLACEHOLDER — always-on context budget reuses the budget residency
            model in a later slice. No data yet, so it reads "—". */}
        <StatPanel
          title="always-on"
          metric="—"
          caption="context budget · later slice"
          tone="nodata"
        />
        {/* Slice 4 — local overlays (tailoring, ADR-0021). LIVE from
            `forge tailor list`: the count of adopted resources carrying >= 1
            overlay. Manage on the Tailoring page. */}
        <StatPanel
          icon={<SlidersHorizontal className="size-3" />}
          title="tailored"
          metric={tailoredSet.size}
          caption="local overlays"
          tone={tailoredSet.size > 0 ? "ok" : "nodata"}
        />
      </div>

      {/* ── Adopted table — the prototype `.cat` grid in a hairline-ringed
          surface. uid + SourceChip + KindBadge + criticality + a Remove action.
          SLICE 3/4 SEAM: a `residency`, `overlays`, and per-row conflict marker
          (⚖) column join here once those slices land. ───────────────────────── */}
      <div className="overflow-hidden rounded-lg ring-1 ring-border">
        <Table className="text-[length:var(--text-xs)]">
          <TableHeader className="sticky top-0 z-10 bg-muted/45 backdrop-blur">
            <TableRow className="hover:bg-transparent">
              <Th>uid</Th>
              <Th>source</Th>
              <Th>kind</Th>
              <Th>version</Th>
              <Th>criticality</Th>
              <TableHead className="w-px text-right font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
                <span className="sr-only">actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adopted.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-12 text-center font-mono text-[length:var(--text-sm)] text-muted-foreground"
                >
                  Nothing adopted yet. Open{" "}
                  <Link
                    href="/browse"
                    className="text-foreground underline underline-offset-4 hover:text-state-ok"
                  >
                    Browse &amp; Adopt
                  </Link>{" "}
                  to subscribe to source slices and adopt resources into this
                  project.
                </TableCell>
              </TableRow>
            ) : (
              adopted.map((entry) => {
                const key = entryKey(entry);
                const rowBusy = busyKey === key;
                const conflicted = conflictedSet.has(entry.uid);
                const tailored = tailoredSet.has(key);
                return (
                  <TableRow
                    key={key}
                    className={cn(
                      "align-top transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                      conflicted && "bg-state-attention/[0.05]",
                    )}
                  >
                    <TableCell className="px-3 py-2.5 font-mono font-medium whitespace-nowrap text-foreground">
                      {conflicted ? (
                        <Link
                          href="/conflicts"
                          title="unresolved conflict — adjudicate on the Conflicts page"
                          className="mr-1.5 inline-flex align-[-2px] text-state-attention hover:text-state-warn"
                        >
                          <Scale className="size-3.5" />
                        </Link>
                      ) : null}
                      {entry.uid}
                      {tailored ? (
                        <Link
                          href="/tailoring"
                          title="tailored — carries project overlays; manage on the Tailoring page"
                          className="ml-2 inline-flex align-[-2px]"
                        >
                          <TailoredChip>tailored</TailoredChip>
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <span
                        title={
                          entry.sourceId
                            ? `adopted from source "${entry.sourceId}"`
                            : "library-local copy (no external source)"
                        }
                      >
                        <SourceChip
                          source={entry.sourceId ?? "library"}
                          className={cn(
                            !entry.sourceId &&
                              "border-dashed text-muted-foreground",
                          )}
                        />
                      </span>
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <KindBadge kind={entry.kind} />
                    </TableCell>
                    <TableCell className="px-3 py-2.5 font-mono text-muted-foreground">
                      {entry.version || "—"}
                    </TableCell>
                    <TableCell className="px-3 py-2.5 font-mono text-muted-foreground">
                      {entry.criticality || "—"}
                    </TableCell>
                    <TableCell className="w-px px-3 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={isBusy}
                        onClick={() => runRemove(entry)}
                        className="font-mono text-[length:var(--text-xs)] hover:text-destructive"
                        title="Remove from this project's composition (does not touch the library)"
                      >
                        {rowBusy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Trash2 className="size-3" />
                        )}
                        remove
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Footer actions — the "adopt from catalog" link now points at the
          PROJECT-plane Browse & Adopt surface (Fix B): subscribe to slices +
          adopt resources there. (Export composition + the lockfile view arrive
          with Slice 5.) ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <p
          className="truncate font-mono text-[length:var(--text-2xs)] text-muted-foreground"
          title={compositionPath}
        >
          {compositionPath}
        </p>
        <Button
          variant="outline"
          size="sm"
          render={<Link href="/browse" />}
          className="font-mono text-[length:var(--text-xs)]"
        >
          <Plus className="size-3" />
          browse &amp; adopt
        </Button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// StatPanel — the prototype `.forge-stat` look (mono uppercase title + state
// dot, a large metric, a muted caption) rebuilt on the shared Card primitive.
// "nodata" placeholders dim the metric so a "—" never reads as a real zero.
// ──────────────────────────────────────────────────────────────────────────

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
