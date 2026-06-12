"use client";

import * as React from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Loader2,
  Play,
  ShieldAlert,
  X,
  XCircle,
} from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OpenInEditor } from "@/components/open-in-editor";
import { cn } from "@/lib/utils";
import type { EvalArtifact } from "@/components/eval/types";
import type { EvalLedgerRecord } from "@/lib/forge-bridge";
import type { ResourceKind } from "@/lib/types";

/**
 * Grade-table props: the artifact rows PLUS the shared run contract owned by
 * EvalWorkspace (onRun / runningTarget) and the per-uid ledger history. The run
 * contract + ledger are OPTIONAL today — a feature agent wires the per-row run
 * trigger + history drill-down; until then the table renders read-only.
 */
export interface EvalGradeTableProps {
  artifacts: EvalArtifact[];
  /** Trigger the SAFE grading pass for one uid (or a verb). */
  onRun?: (target: string) => void;
  /** The target currently grading, or null. */
  runningTarget?: string | null;
  /** Per-uid run history (most-recent-first) for the drill-down. */
  ledgerByUid?: Record<string, EvalLedgerRecord[]>;
  /** uid → true when the graded-against hash has drifted (re-eval needed). */
  staleByUid?: Record<string, boolean>;
}

/**
 * Only the markdown-file resource kinds have an in-app editor route. An eval
 * artifact uid is "<kind>:<id>"; other artifact kinds (validator, meta-test,
 * engine — and hook, which lives inside hooks/hooks.json) are not per-file
 * editable, so those rows render their uid as plain text.
 */
const EDITABLE_KINDS: ReadonlySet<ResourceKind> = new Set([
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "memory",
]);

/**
 * Split an eval artifact uid ("<kind>:<id>") into its kind and kind-local id,
 * but only when the kind addresses an editable resource. The id keeps every
 * remaining colon (rule ids never contain ":", but split-on-first is safest).
 * Returns null for non-editable kinds or a malformed uid.
 */
function editableTarget(uid: string): { kind: ResourceKind; id: string } | null {
  const sep = uid.indexOf(":");
  if (sep <= 0) return null;
  const kind = uid.slice(0, sep);
  const id = uid.slice(sep + 1);
  if (!id || !EDITABLE_KINDS.has(kind as ResourceKind)) return null;
  return { kind: kind as ResourceKind, id };
}

/** True when a grade is the unevaluated sentinel ("U" / "UNEVALUATED"). */
function isUnevaluated(grade: string | undefined): boolean {
  return grade === "U" || grade === "UNEVALUATED";
}

/** Criticality sort weight — higher is more urgent (unknown ⇒ lowest). */
const CRITICALITY_RANK: Record<string, number> = {
  safety: 3,
  compliance: 2,
  standard: 1,
};
function criticalityRank(c: string | undefined): number {
  return c ? (CRITICALITY_RANK[c] ?? 0) : 0;
}

/** Render a grade: "U" (unevaluated) shows as an em-dash, never 0. */
function GradeCell({ artifact }: { artifact: EvalArtifact }) {
  const grade = artifact.eval.grade;
  if (isUnevaluated(grade)) {
    return (
      <span
        className="font-mono text-base text-muted-foreground"
        title="Unevaluated — runs once a live reviewer grades the golden set"
      >
        —
      </span>
    );
  }
  return (
    <Badge variant="default" className="font-mono text-[11px]">
      {grade}
    </Badge>
  );
}

function shortHash(hash: string | undefined): string {
  if (!hash) return "—";
  const hex = hash.replace(/^sha256:/, "");
  return hex.slice(0, 10);
}

/** Sentinel value for "no filter" select options (empty string is reserved). */
const ALL = "__all__";

type SortKey = "uid" | "grade" | "status" | "cases";
type SortDir = "asc" | "desc";

/** Coverage / staleness filter buckets. */
type CoverageFilter = "all" | "covered" | "uncovered";
type StaleFilter = "all" | "stale" | "fresh";

export function EvalGradeTable({
  artifacts,
  onRun,
  runningTarget = null,
  ledgerByUid = {},
  staleByUid = {},
}: EvalGradeTableProps) {
  const [query, setQuery] = React.useState("");
  const [gradeFilter, setGradeFilter] = React.useState<string>(ALL);
  const [critFilter, setCritFilter] = React.useState<string>(ALL);
  const [coverageFilter, setCoverageFilter] =
    React.useState<CoverageFilter>("all");
  const [staleFilter, setStaleFilter] = React.useState<StaleFilter>("all");
  const [sortKey, setSortKey] = React.useState<SortKey>("uid");
  const [sortDir, setSortDir] = React.useState<SortDir>("asc");
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());

  const canRun = typeof onRun === "function";
  const busy = runningTarget !== null;

  // Filter facets, derived from the rows actually present.
  const grades = React.useMemo(
    () =>
      Array.from(new Set(artifacts.map((a) => a.eval.grade).filter(Boolean)))
        .sort(),
    [artifacts],
  );
  const criticalities = React.useMemo(
    () =>
      Array.from(
        new Set(
          artifacts
            .map((a) => a.criticality)
            .filter((c): c is string => Boolean(c)),
        ),
      ).sort(),
    [artifacts],
  );
  const hasAnyCriticality = criticalities.length > 0;
  const staleCount = React.useMemo(
    () => artifacts.filter((a) => staleByUid[a.uid]).length,
    [artifacts, staleByUid],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = artifacts.filter((a) => {
      if (q && !a.uid.toLowerCase().includes(q)) return false;
      if (gradeFilter !== ALL && a.eval.grade !== gradeFilter) return false;
      if (critFilter !== ALL && a.criticality !== critFilter) return false;
      if (coverageFilter === "covered" && !a.hasGoldenSet) return false;
      if (coverageFilter === "uncovered" && a.hasGoldenSet) return false;
      const stale = Boolean(staleByUid[a.uid]);
      if (staleFilter === "stale" && !stale) return false;
      if (staleFilter === "fresh" && stale) return false;
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "grade": {
          // Unevaluated grades sort last in asc, regardless of direction flip.
          const au = isUnevaluated(a.eval.grade);
          const bu = isUnevaluated(b.eval.grade);
          if (au !== bu) return au ? 1 : -1;
          cmp = String(a.eval.grade).localeCompare(String(b.eval.grade));
          break;
        }
        case "status":
          cmp = String(a.eval.status).localeCompare(String(b.eval.status));
          break;
        case "cases":
          cmp = a.cases.length - b.cases.length;
          break;
        case "uid":
        default:
          cmp = a.uid.localeCompare(b.uid);
      }
      // Stable criticality tiebreak (most urgent first) then uid.
      if (cmp === 0) {
        cmp =
          criticalityRank(b.criticality) - criticalityRank(a.criticality) ||
          a.uid.localeCompare(b.uid);
        return cmp; // tiebreak is direction-independent
      }
      return cmp * dir;
    });
  }, [
    artifacts,
    query,
    gradeFilter,
    critFilter,
    coverageFilter,
    staleFilter,
    sortKey,
    sortDir,
    staleByUid,
  ]);

  const onSort = React.useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setSortDir("asc");
      return key;
    });
  }, []);

  const toggleExpanded = React.useCallback((uid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const filtersActive =
    query.trim() !== "" ||
    gradeFilter !== ALL ||
    critFilter !== ALL ||
    coverageFilter !== "all" ||
    staleFilter !== "all";

  const clearFilters = React.useCallback(() => {
    setQuery("");
    setGradeFilter(ALL);
    setCritFilter(ALL);
    setCoverageFilter("all");
    setStaleFilter("all");
  }, []);

  // colSpan for the empty-state + drill-down rows: caret, artifact, grade,
  // status, criticality, cases, hash, last-run, run-trigger.
  const COL_SPAN = 9;

  return (
    <div className="flex flex-col gap-2">
      {/* Triage toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search uid…"
          aria-label="search by uid"
          className="w-full font-mono text-xs sm:w-56"
        />

        <Select
          value={gradeFilter}
          onValueChange={(v) => setGradeFilter(v ?? ALL)}
        >
          <SelectTrigger size="sm" className="font-mono text-xs">
            <SelectValue placeholder="grade" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>all grades</SelectItem>
            {grades.map((g) => (
              <SelectItem key={g} value={g}>
                {isUnevaluated(g) ? "U (unevaluated)" : g}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={coverageFilter}
          onValueChange={(v) =>
            setCoverageFilter((v as CoverageFilter) ?? "all")
          }
        >
          <SelectTrigger size="sm" className="font-mono text-xs">
            <SelectValue placeholder="coverage" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all coverage</SelectItem>
            <SelectItem value="covered">covered</SelectItem>
            <SelectItem value="uncovered">uncovered</SelectItem>
          </SelectContent>
        </Select>

        {hasAnyCriticality ? (
          <Select
            value={critFilter}
            onValueChange={(v) => setCritFilter(v ?? ALL)}
          >
            <SelectTrigger size="sm" className="font-mono text-xs">
              <SelectValue placeholder="criticality" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>all criticality</SelectItem>
              {criticalities.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Select
          value={staleFilter}
          onValueChange={(v) => setStaleFilter((v as StaleFilter) ?? "all")}
        >
          <SelectTrigger size="sm" className="font-mono text-xs">
            <SelectValue placeholder="staleness" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all freshness</SelectItem>
            <SelectItem value="stale">
              re-eval needed{staleCount ? ` (${staleCount})` : ""}
            </SelectItem>
            <SelectItem value="fresh">fresh</SelectItem>
          </SelectContent>
        </Select>

        {filtersActive ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="font-mono text-xs"
          >
            <X className="size-3" />
            clear
          </Button>
        ) : null}

        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {filtered.length} / {artifacts.length}
        </span>
      </div>

      <div className="rounded-xl ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-px" aria-hidden />
              <SortHeader
                label="Artifact"
                col="uid"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
              />
              <SortHeader
                label="Grade"
                col="grade"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
              />
              <SortHeader
                label="Gate"
                col="status"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
              />
              <TableHead className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                Crit
              </TableHead>
              <SortHeader
                label="Cases"
                col="cases"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
              />
              <TableHead className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                Graded against
              </TableHead>
              <TableHead className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                Last run
              </TableHead>
              <TableHead className="w-px text-right font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                <span className="sr-only">run</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COL_SPAN}
                  className="py-8 text-center font-mono text-xs text-muted-foreground"
                >
                  {artifacts.length === 0
                    ? "No artifacts ship a golden set yet."
                    : "No artifacts match the current filters."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((a) => {
                const target = editableTarget(a.uid);
                const open = expanded.has(a.uid);
                const stale = Boolean(staleByUid[a.uid]);
                const rowRunning = runningTarget === a.uid;
                const runs = ledgerByUid[a.uid] ?? [];
                const latest = runs[0];
                const lastRun = a.eval.last_run ?? latest?.ts ?? null;
                return (
                  <React.Fragment key={a.uid}>
                    <TableRow
                      aria-expanded={open}
                      data-state={stale ? "selected" : undefined}
                    >
                      <TableCell className="w-px pr-0">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(a.uid)}
                          aria-expanded={open}
                          aria-label={
                            open ? `Collapse ${a.uid}` : `Expand ${a.uid}`
                          }
                          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <ChevronRight
                            className={cn(
                              "size-3.5 transition-transform",
                              open && "rotate-90",
                            )}
                          />
                        </button>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-foreground">
                        <span className="flex items-center gap-1.5">
                          {a.uid}
                          {!a.hasGoldenSet ? (
                            <Badge
                              variant="outline"
                              className="font-mono text-[9px] text-muted-foreground"
                            >
                              no golden set
                            </Badge>
                          ) : null}
                          {stale ? (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 font-mono text-[9px] text-destructive"
                              title="Registry hash drifted from the graded-against hash"
                            >
                              <AlertTriangle className="size-2.5" />
                              re-eval needed
                            </span>
                          ) : null}
                          {target && (
                            <OpenInEditor
                              kind={target.kind}
                              id={target.id}
                              variant="ghost"
                              iconOnly
                            />
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        <GradeCell artifact={a} />
                      </TableCell>
                      <TableCell>
                        <GateBadge status={a.eval.status} />
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {a.criticality ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-foreground">
                        {a.cases.length}
                      </TableCell>
                      <TableCell
                        className="font-mono text-[11px] text-muted-foreground"
                        title={a.eval.graded_against_hash}
                      >
                        {shortHash(a.eval.graded_against_hash)}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {lastRun ?? "—"}
                      </TableCell>
                      <TableCell className="w-px text-right">
                        {canRun ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => onRun?.(a.uid)}
                            className="font-mono text-[11px]"
                            title={`Grade ${a.uid} (deterministic — no model call)`}
                          >
                            {rowRunning ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Play className="size-3.5" />
                            )}
                            {rowRunning ? "grading" : "run"}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                    {open ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell />
                        <TableCell colSpan={COL_SPAN - 1} className="pt-0">
                          <DrillDown
                            artifact={a}
                            stale={stale}
                            runs={runs}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Sortable header cell — mirrors the registry-table SortHeader affordance. */
function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === col;
  const Icon = !active ? ChevronsUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className="select-none p-0">
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "flex h-9 w-full items-center gap-1 px-2 font-mono text-[11px] uppercase tracking-wide transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <Icon className="size-3 shrink-0 opacity-70" />
      </button>
    </TableHead>
  );
}

/**
 * The two-tier gate outcome, surfaced from `eval.status` (the harness'
 * status/staleness computer — see eval-harness.mjs). A Tier-S static block
 * short-circuits to BLOCKED_BY_STATIC; a clean run reads GREEN; an
 * unevaluated/unknown status reads as a neutral chip.
 */
function GateBadge({ status }: { status: string | undefined }) {
  const s = (status ?? "").toUpperCase();
  if (!s || s === "UNEVALUATED" || s === "U") {
    return (
      <span className="font-mono text-[11px] text-muted-foreground">—</span>
    );
  }
  const blocked = s.includes("BLOCK") || s.includes("STATIC");
  const regressed = s.includes("REGRESS") || s === "RED" || s.includes("FAIL");
  const green = s === "GREEN" || s.includes("PASS") || s.includes("SHIP");
  const variant = blocked || regressed ? "destructive" : green ? "default" : "outline";
  const Icon = blocked
    ? ShieldAlert
    : regressed
      ? XCircle
      : green
        ? CheckCircle2
        : Clock;
  return (
    <Badge variant={variant} className="gap-1 font-mono text-[10px]">
      <Icon className="size-3" />
      {status}
    </Badge>
  );
}

/**
 * Per-artifact drill-down: golden cases, the tier gate, last-run (from the
 * ledger), the graded-against hash, plus the latest run's metric bag. The
 * report carries no per-case PASS/FAIL (cases are just ids) — per-case verdicts
 * only exist once a run records them, so absent verdicts read as an explicit
 * "no per-case results" state rather than a misleading all-pass.
 */
function DrillDown({
  artifact,
  stale,
  runs,
}: {
  artifact: EvalArtifact;
  stale: boolean;
  runs: EvalLedgerRecord[];
}) {
  const latest = runs[0];
  const metrics = (latest?.metrics ?? artifact.eval.metrics) as
    | Record<string, unknown>
    | null
    | undefined;
  const metricEntries = metrics
    ? Object.entries(metrics).filter(([, v]) => v !== null && v !== undefined)
    : [];

  return (
    <div className="mb-1 flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
      {/* Summary line: tier gate + graded-against + last run. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px]">
        <span className="text-muted-foreground">
          tier gate:{" "}
          <span className="text-foreground">{artifact.eval.status || "—"}</span>
        </span>
        <span
          className="text-muted-foreground"
          title={artifact.eval.graded_against_hash}
        >
          graded against:{" "}
          <span className="text-foreground">
            {shortHash(artifact.eval.graded_against_hash)}
          </span>
        </span>
        <span className="text-muted-foreground">
          last run:{" "}
          <span className="text-foreground">
            {artifact.eval.last_run ?? latest?.ts ?? "—"}
          </span>
        </span>
        {stale ? (
          <span className="inline-flex items-center gap-1 text-destructive">
            <AlertTriangle className="size-3" />
            registry hash drifted — re-eval needed
          </span>
        ) : null}
      </div>

      {/* Golden cases — ids + PASS/FAIL when a run recorded verdicts. */}
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          Golden cases ({artifact.cases.length})
        </span>
        {artifact.cases.length === 0 ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            No golden-set cases authored.
          </span>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {artifact.cases.map((c) => {
              const verdict = caseVerdict(latest, c);
              return (
                <li
                  key={c}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[10px]"
                >
                  {verdict === "PASS" ? (
                    <CheckCircle2 className="size-3 text-emerald-500" />
                  ) : verdict === "FAIL" ? (
                    <XCircle className="size-3 text-destructive" />
                  ) : null}
                  <span className="text-foreground">{c}</span>
                </li>
              );
            })}
          </ul>
        )}
        {!latest ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            No graded run yet — per-case PASS/FAIL appears after a grading pass.
          </span>
        ) : null}
      </div>

      {/* Latest run's metric bag, when present. */}
      {metricEntries.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Last-run metrics
          </span>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
            {metricEntries.map(([k, v]) => (
              <div
                key={k}
                className="flex items-center justify-between gap-2 font-mono text-[10px]"
              >
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-foreground">{formatMetric(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Best-effort per-case verdict from a ledger record. The report has no per-case
 * results; a run MAY expose them under a `cases`/`verdicts` map. Unknown ⇒ null
 * (the case renders without a PASS/FAIL marker).
 */
function caseVerdict(
  record: EvalLedgerRecord | undefined,
  caseId: string,
): "PASS" | "FAIL" | null {
  if (!record) return null;
  const bag =
    (record.cases as Record<string, unknown> | undefined) ??
    (record.verdicts as Record<string, unknown> | undefined);
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  const raw = bag[caseId];
  if (raw === undefined || raw === null) return null;
  const s = String(typeof raw === "object" ? (raw as { verdict?: unknown }).verdict ?? "" : raw)
    .toUpperCase();
  if (s === "PASS" || s === "TRUE" || s === "1") return "PASS";
  if (s === "FAIL" || s === "FALSE" || s === "0") return "FAIL";
  return null;
}

/** Compact metric rendering: round floats, pass through ints/strings. */
function formatMetric(v: unknown): string {
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
