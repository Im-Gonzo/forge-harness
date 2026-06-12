"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Boxes,
  CircleCheck,
  CircleHelp,
  CircleX,
  FolderGit2,
  Gauge,
  Loader2,
  Package,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ProjectHealth } from "@/lib/forge-bridge/fleet-health";
// Shared birds-eye health presentation — the same primitives the Global-plane
// Projects page uses to render per-project health (single source of truth).
import {
  KindBreakdown,
  SEVERITY_RANK,
  ValidateBadge,
  metric,
  severityOf,
} from "@/components/fleet/project-health-cells";

/**
 * FleetOverview — the L0 BIRDS-EYE health grid.
 *
 * One card per scanned project over the foundation's `ProjectHealth[]`. The
 * point is to "manage + visualize the health of all projects" at a glance:
 * registry size (+ a per-kind mini-breakdown), validation status, and the
 * always-on token floor — colored so an unhealthy project (validate FAIL)
 * stands out in rose. Every metric is fail-soft from the bridge (`null`), which
 * we render as an em-dash.
 *
 * Two navigations:
 *   - SCAN: the path Input + button push `/fleet?scan=<path>`, which re-scans
 *     server-side (the page reads `?scan` and re-runs `scanFleet`).
 *   - OPEN: per-card, POST `/api/harness { root: harness.root }` (sets the
 *     `forge-harness` cookie that scopes the whole app to THAT project), then
 *     navigate to /registry — mirroring HarnessSwitcher's POST-then-navigate.
 *
 * Sort: failing-validate first (most actionable), then degraded (validate
 * unknown), then healthy — already-label-sorted within each band by the bridge.
 */

export interface FleetOverviewProps {
  /** One birds-eye health row per scanned project, sorted by label. */
  health: ProjectHealth[];
  /** The scan root the rows were collected from (echoed for context/refetch). */
  scanRoot: string;
}

function ProjectCard({ p }: { p: ProjectHealth }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [opening, setOpening] = useState(false);
  const severity = severityOf(p);

  // OPEN: mirror HarnessSwitcher — POST the root to set the cookie, then
  // navigate so the whole app is now scoped to this project's harness.
  const onOpen = () => {
    setOpening(true);
    fetch("/api/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: p.harness.root }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then(() => {
        startTransition(() => router.push("/registry"));
      })
      .catch(() => {
        // Switch failed — drop the spinner; the card stays put.
        setOpening(false);
      });
  };

  const busy = opening || isPending;

  return (
    <Card
      size="sm"
      className={cn(
        "ring-1 transition-colors",
        severity === "fail"
          ? "ring-rose-500/30 hover:ring-rose-500/50"
          : "ring-foreground/10 hover:ring-foreground/20",
      )}
    >
      <CardContent className="flex flex-col gap-3">
        {/* Header: identity + validate status */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 font-mono text-sm font-medium text-foreground">
              <FolderGit2 className="size-3.5 shrink-0 text-primary" />
              <span className="truncate" title={p.harness.label}>
                {p.harness.label}
              </span>
            </span>
            <span
              className="truncate font-mono text-[10px] text-muted-foreground"
              title={p.harness.projectPath ?? p.harness.root}
            >
              {p.harness.projectPath ?? p.harness.root}
            </span>
          </div>
          <ValidateBadge p={p} />
        </div>

        {/* Metrics row: artifact count + always-on token floor */}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-0.5 rounded-lg bg-muted/30 px-2.5 py-1.5">
            <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              <Package className="size-3" />
              artifacts
            </span>
            <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
              {metric(p.artifactCount)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-lg bg-muted/30 px-2.5 py-1.5">
            <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              <Gauge className="size-3" />
              always-on
            </span>
            <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
              {metric(p.alwaysOnTokens)}
              {p.alwaysOnTokens != null ? (
                <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                  tok
                </span>
              ) : null}
            </span>
          </div>
        </div>

        {/* Per-kind mini-breakdown */}
        <KindBreakdown byKind={p.byKind} />

        {/* Open action — scope the app to this project */}
        <Button
          variant="outline"
          size="sm"
          onClick={onOpen}
          disabled={busy}
          className="mt-0.5 w-full justify-center font-mono text-xs"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ArrowUpRight className="size-3.5" />
          )}
          {busy ? "opening…" : "Open"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function FleetOverview({ health, scanRoot }: FleetOverviewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pathInput, setPathInput] = useState(scanRoot);

  // Sort failing-validate first (most actionable), then degraded, then healthy.
  // The bridge already label-sorts, so this is a stable re-band within labels.
  const rows = useMemo(
    () =>
      [...health].sort(
        (a, b) => SEVERITY_RANK[severityOf(a)] - SEVERITY_RANK[severityOf(b)],
      ),
    [health],
  );

  // Health tallies for the summary strip.
  const tally = useMemo(() => {
    let fail = 0;
    let unknown = 0;
    let ok = 0;
    for (const p of health) {
      const s = severityOf(p);
      if (s === "fail") fail += 1;
      else if (s === "unknown") unknown += 1;
      else ok += 1;
    }
    return { fail, unknown, ok };
  }, [health]);

  // SCAN: re-scan server-side at a new path. The page reads `?scan` and re-runs
  // scanFleet; an empty path falls back to the default SCAN_ROOT.
  const onScan = () => {
    const next = pathInput.trim();
    const url = next ? `/fleet?scan=${encodeURIComponent(next)}` : "/fleet";
    startTransition(() => router.push(url));
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Scan-path toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:max-w-xl sm:flex-1">
          <FolderGit2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onScan();
              }
            }}
            placeholder="scan root…"
            aria-label="scan root path"
            className="pl-8 font-mono text-xs"
            spellCheck={false}
            disabled={isPending}
          />
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={onScan}
          disabled={isPending}
          className="font-mono text-xs"
        >
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Search className="size-3.5" />
          )}
          Scan
        </Button>

        {/* Summary strip — count + health tallies */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">
            <Boxes className="size-3" />
            {health.length} project{health.length === 1 ? "" : "s"}
          </Badge>
          {tally.ok > 0 ? (
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] text-emerald-500"
            >
              <CircleCheck className="size-3" />
              {tally.ok} pass
            </Badge>
          ) : null}
          {tally.fail > 0 ? (
            <Badge
              variant="outline"
              className="border-rose-500/30 bg-rose-500/10 font-mono text-[10px] text-rose-500"
            >
              <CircleX className="size-3" />
              {tally.fail} fail
            </Badge>
          ) : null}
          {tally.unknown > 0 ? (
            <Badge
              variant="outline"
              className="font-mono text-[10px] text-muted-foreground/70"
            >
              <CircleHelp className="size-3" />
              {tally.unknown} degraded
            </Badge>
          ) : null}
        </div>
      </div>

      {/* Health grid (or empty state) */}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <Boxes className="size-6 text-muted-foreground/50" />
          <p className="font-mono text-xs text-muted-foreground">
            no <span className="text-foreground">.claude/</span> project harnesses
            found under{" "}
            <span className="text-foreground">{scanRoot}</span>.
          </p>
          <p className="font-mono text-[11px] text-muted-foreground/70">
            point the scan root at a workspace that contains tailored projects.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((p) => (
            <ProjectCard key={p.harness.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
