"use client";

/**
 * ValidationView — presentational findings renderer for the Validation inbox.
 *
 * Pure render: it receives the (already-strict-or-not) finding list plus the
 * triage controls (groupBy / levelFilter / query) as props and renders the
 * findings as COLLAPSIBLE GROUPS per {@link groupFindings} with errors-first
 * ordering. It owns NO fetch, NO --strict, NO filter STATE — the orchestrator
 * (validation-workspace.tsx) holds all of that and feeds this component.
 *
 * Top of the list carries a compact severity summary (V4) reflecting the
 * *visible* counts — i.e. what survives the level + free-text filters the
 * workspace passed in — so triage progress reads at a glance.
 *
 * Phase-1 jump links are preserved (V2): a finding whose path confidently
 * resolves to a managed resource deep-links to that resource's in-app editor
 * ({@link editorHref}) AND to its node in the dependency graph
 * (/graph?focus=<uid>); everything else falls back to a vscode:// file link and
 * renders the path as plain text where it cannot be resolved.
 */
import { useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  FileWarning,
  Info,
  Network,
  SquarePen,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { editorHref } from "@/components/open-in-editor";
import { cn } from "@/lib/utils";
import type { Finding, FindingLevel } from "@/lib/types";
import {
  groupFindings,
  pathToEditorTarget,
  LEVEL_ORDER,
  type EditorTarget,
  type FindingGroup,
  type GroupBy,
} from "./grouping";

const LEVEL_META: Record<
  FindingLevel,
  { Icon: LucideIcon; row: string; badge: string; label: string; plural: string }
> = {
  ERROR: {
    Icon: XCircle,
    row: "text-red-500",
    badge: "border-red-500/40 bg-red-500/10 text-red-500",
    label: "ERROR",
    plural: "errors",
  },
  WARN: {
    Icon: AlertTriangle,
    row: "text-amber-500",
    badge: "border-amber-500/40 bg-amber-500/10 text-amber-500",
    label: "WARN",
    plural: "warns",
  },
  INFO: {
    Icon: Info,
    row: "text-sky-500",
    badge: "border-sky-500/40 bg-sky-500/10 text-sky-500",
    label: "INFO",
    plural: "info",
  },
};

export interface ValidationViewProps {
  /** The findings to render (already strict-or-not, supplied by the workspace). */
  findings: Finding[];
  /** Which axis to group findings along. */
  groupBy: GroupBy;
  /** The set of levels to show; a finding is hidden unless its level is in here. */
  levelFilter: Set<string>;
  /** Free-text filter; matches path / message / source (case-insensitive). */
  query: string;
}

/** Apply the level + free-text filters to the raw finding list. */
function applyFilters(
  findings: Finding[],
  levelFilter: Set<string>,
  query: string,
): Finding[] {
  const q = query.trim().toLowerCase();
  return findings.filter((f) => {
    if (levelFilter.size > 0 && !levelFilter.has(f.level)) return false;
    if (!q) return true;
    return (
      f.path.toLowerCase().includes(q) ||
      f.message.toLowerCase().includes(q) ||
      f.source.toLowerCase().includes(q)
    );
  });
}

/** Tally visible findings by level for the V4 summary line. */
function countByLevel(findings: Finding[]): Record<FindingLevel, number> {
  const counts: Record<FindingLevel, number> = { ERROR: 0, WARN: 0, INFO: 0 };
  for (const f of findings) counts[f.level] += 1;
  return counts;
}

export function ValidationView({
  findings,
  groupBy,
  levelFilter,
  query,
}: ValidationViewProps) {
  const filtered = applyFilters(findings, levelFilter, query);
  const groups = groupFindings(filtered, groupBy);
  const counts = countByLevel(filtered);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-3">
        <SeveritySummary counts={counts} total={filtered.length} />
        {groups.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">
            {findings.length === 0
              ? "No findings — every validator reported clean."
              : "No findings match the current filters."}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {groups.map((group) => (
              <FindingsGroup key={group.key} group={group} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * V4 — compact severity summary reflecting the *visible* (post-filter) counts.
 * One chip per non-empty level, errors-first; a leading total keeps the eye
 * anchored even when a single level is in view.
 */
function SeveritySummary({
  counts,
  total,
}: {
  counts: Record<FindingLevel, number>;
  total: number;
}) {
  const visibleLevels = LEVEL_ORDER.filter((lvl) => counts[lvl] > 0);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {total} shown
      </span>
      {visibleLevels.length === 0 ? null : (
        <span className="text-muted-foreground/40">·</span>
      )}
      {visibleLevels.map((lvl) => {
        const meta = LEVEL_META[lvl];
        return (
          <span
            key={lvl}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px]",
              meta.badge,
            )}
          >
            <meta.Icon className="size-3" />
            {counts[lvl]} {meta.plural}
          </span>
        );
      })}
    </div>
  );
}

/** A group header — shape depends on the grouping axis. */
function GroupHeader({ group, open }: { group: FindingGroup; open: boolean }) {
  const count = group.items.length;
  const topMeta = LEVEL_META[group.topLevel];
  const Icon =
    group.kind === "file"
      ? FileWarning
      : group.kind === "validator"
        ? Network
        : topMeta.Icon;
  const label = group.kind === "severity" ? topMeta.label : group.label;
  return (
    <div className="flex w-full items-center gap-1.5">
      <ChevronRight
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-90",
        )}
      />
      <Icon className={cn("size-3.5 shrink-0", topMeta.row)} />
      <span
        className={cn(
          "truncate font-mono text-xs font-semibold",
          group.kind === "severity" ? topMeta.row : "text-foreground",
        )}
      >
        {label}
      </span>
      <span className="font-mono text-[10px] text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

/**
 * One collapsible group (V1). Native <details> disclosure — dense, accessible,
 * zero-dependency, and keyboard-operable out of the box. Default open so triage
 * starts fully visible; users collapse noisy groups as they work.
 */
function FindingsGroup({ group }: { group: FindingGroup }) {
  const [open, setOpen] = useState(true);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded-md border border-border/60"
    >
      <summary className="flex cursor-pointer list-none items-center rounded-md px-2 py-1.5 hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <GroupHeader group={group} open={open} />
      </summary>
      <div className="border-t border-border/60 px-1 pb-1">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[12%] font-mono text-[10px] uppercase">
                level
              </TableHead>
              <TableHead className="w-[24%] font-mono text-[10px] uppercase">
                source
              </TableHead>
              <TableHead className="w-[30%] font-mono text-[10px] uppercase">
                path:line
              </TableHead>
              <TableHead className="font-mono text-[10px] uppercase">
                message
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {group.items.map((f, i) => (
              <FindingRow key={`${f.source}-${f.path}-${i}`} finding={f} />
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}

/** The location cell: a resolvable path becomes editor + graph jump links. */
function LocationCell({
  finding,
  managed,
}: {
  finding: Finding;
  managed: EditorTarget | null;
}) {
  const loc = finding.line ? `${finding.path}:${finding.line}` : finding.path;

  // Unmanaged paths cannot be confidently mapped to a resource (hook JSON,
  // absolute/ambiguous paths) — render as plain text so we never produce a dead
  // in-app link. We still expose the raw file:line via a vscode:// link.
  if (!managed) {
    return (
      <a
        href={`vscode://file/${finding.path}${
          finding.line ? `:${finding.line}` : ""
        }`}
        title={`Open ${loc}`}
        className="group inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground underline-offset-2 hover:underline"
      >
        {loc}
      </a>
    );
  }

  const uid = `${managed.kind}:${managed.id}`;
  return (
    <div className="flex flex-col gap-0.5">
      <Link
        href={editorHref(managed.kind, managed.id)}
        title={`Edit ${managed.kind} ${managed.id} (${loc})`}
        className="group inline-flex items-center gap-1 font-mono text-[11px] text-foreground underline-offset-2 hover:underline"
      >
        <SquarePen className="size-3 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        {loc}
      </Link>
      <Link
        href={`/graph?focus=${encodeURIComponent(uid)}`}
        title={`Focus ${uid} in the dependency graph`}
        className="inline-flex w-fit items-center gap-1 font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        <Network className="size-3" />
        graph
      </Link>
    </div>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  const meta = LEVEL_META[finding.level];
  const managed = pathToEditorTarget(finding.path);
  return (
    <TableRow>
      <TableCell className="align-top">
        <span
          className={cn(
            "inline-flex items-center gap-1 font-mono text-[10px] uppercase",
            meta.row,
          )}
        >
          <meta.Icon className="size-3" />
          {meta.label}
        </span>
      </TableCell>
      <TableCell className="align-top font-mono text-[11px] text-muted-foreground">
        {finding.source}
      </TableCell>
      <TableCell className="align-top">
        <LocationCell finding={finding} managed={managed} />
      </TableCell>
      <TableCell className="whitespace-normal font-mono text-[11px] text-foreground">
        {finding.message}
      </TableCell>
    </TableRow>
  );
}
