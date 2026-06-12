"use client";

/**
 * project-health-cells — the shared BIRDS-EYE health presentation primitives.
 *
 * The cross-project health roll-up (`ProjectHealth[]` from the fleet-health
 * bridge) is rendered in TWO places now:
 *   - the legacy /fleet overview grid (fleet-overview.tsx), and
 *   - the Global-plane Projects page (projects-view.tsx), which MERGES the fleet
 *     birds-eye into each project row (health + drift-vs-library) per V2-A.
 *
 * To keep both surfaces consistent (same severity bands, same validate badge,
 * same per-kind breakdown, same em-dash for a degraded metric) the presentation
 * lives HERE and both import it. These are pure, client-safe helpers — they take
 * a `ProjectHealth` (a type-only import; the bridge that PRODUCES it is
 * server-only) and render tokens/Lucide chrome, nothing server-bound.
 */
import { CircleCheck, CircleHelp, CircleX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { KIND_ACCENT } from "@/components/registry/registry-helpers";
import type { ProjectHealth } from "@/lib/forge-bridge/fleet-health";
import type { ArtifactKind } from "@/lib/types";

/**
 * The metrics-only subset of a birds-eye health row — everything these cells
 * render, WITHOUT the server-only `harness` identity. Both the full
 * `ProjectHealth` (the /fleet grid) and the lean root-keyed `ProjectHealthLite`
 * (the Projects overview) structurally satisfy this, so the cells render either.
 */
export type ProjectHealthMetrics = Pick<
  ProjectHealth,
  | "artifactCount"
  | "byKind"
  | "validateOk"
  | "errors"
  | "warnings"
  | "alwaysOnTokens"
>;

const numberFmt = new Intl.NumberFormat("en-US");

/** Health severity band — drives sort order and accent color. */
export type Severity = "fail" | "unknown" | "ok";

/**
 * Severity of one project's health: FAIL when validate reported errors, UNKNOWN
 * when the bridge could not run validate (degraded), else OK. This doubles as
 * the "drift-vs-library" signal surfaced on the Projects overview — a FAIL/
 * UNKNOWN row is what stands out against a clean library baseline.
 */
export function severityOf(p: ProjectHealthMetrics): Severity {
  if (p.validateOk === false) return "fail";
  if (p.validateOk === null) return "unknown";
  return "ok";
}

/** Sort rank: failing first (most actionable), then unknown, then healthy. */
export const SEVERITY_RANK: Record<Severity, number> = {
  fail: 0,
  unknown: 1,
  ok: 2,
};

/** Render a nullable numeric metric — em-dash when the bridge degraded it. */
export function metric(value: number | null): string {
  return value == null ? "—" : numberFmt.format(value);
}

/**
 * The validate badge: PASS (emerald) when zero errors, FAIL (rose) with the
 * error count when validation failed, and a muted em-dash when the bridge
 * couldn't run validate for this project.
 */
export function ValidateBadge({ p }: { p: ProjectHealthMetrics }) {
  if (p.validateOk === null) {
    return (
      <Badge
        variant="outline"
        className="font-mono text-[10px] text-muted-foreground/70"
        title="validate could not be run for this project"
      >
        <CircleHelp className="size-3" />—
      </Badge>
    );
  }
  if (p.validateOk) {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] text-emerald-500"
        title={
          p.warnings && p.warnings > 0
            ? `${p.warnings} warning${p.warnings === 1 ? "" : "s"}`
            : "no errors"
        }
      >
        <CircleCheck className="size-3" />
        PASS
        {p.warnings && p.warnings > 0 ? (
          <span className="text-emerald-500/70">· {p.warnings}w</span>
        ) : null}
      </Badge>
    );
  }
  const errs = p.errors ?? 0;
  return (
    <Badge
      variant="outline"
      className="border-rose-500/30 bg-rose-500/10 font-mono text-[10px] text-rose-500"
      title={`${errs} validation error${errs === 1 ? "" : "s"}`}
    >
      <CircleX className="size-3" />
      FAIL
      <span className="text-rose-500/80">· {errs}</span>
    </Badge>
  );
}

/** Compact per-kind artifact breakdown (kind-accented chips), sorted by count. */
export function KindBreakdown({
  byKind,
}: {
  byKind: ProjectHealthMetrics["byKind"];
}) {
  const entries = Object.entries(byKind) as [ArtifactKind, number][];
  if (entries.length === 0) {
    return (
      <span className="font-mono text-[10px] text-muted-foreground/60">—</span>
    );
  }
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([kind, count]) => (
        <span
          key={kind}
          className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          title={`${count} ${kind}${count === 1 ? "" : "s"}`}
        >
          <span className={cn("font-medium", KIND_ACCENT[kind] ?? "")}>
            {kind}
          </span>
          <span className="tabular-nums text-muted-foreground/80">{count}</span>
        </span>
      ))}
    </div>
  );
}
