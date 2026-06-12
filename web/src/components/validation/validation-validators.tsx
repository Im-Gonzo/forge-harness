"use client";

/**
 * ValidationValidators — the "Validators" tab of the Validation inbox.
 *
 * Presentational: renders the per-validator pass/fail roll-up from the validate
 * payload (`forge validate --json` → `data.validators`, each entry is
 * `{ file, status, code }`), with per-validator finding counts broken down by
 * level. The orchestrator (validation-workspace.tsx) owns the data and hands the
 * already-extracted validator-outcome list + the flat finding list down as props.
 *
 * Each row shows the validator, its pass/fail status, and a level breakdown
 * (ERROR/WARN/INFO chips). Rows that emitted findings are EXPANDABLE to reveal
 * the findings themselves, reusing the same managed-resource jump links as the
 * Findings tab (pathToEditorTarget → editorHref, with a vscode:// fallback).
 *
 * Ordering (ADR-0007 triage): failing validators first, then most-findings
 * first, then alphabetically — so the things needing attention float to the top.
 */
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { editorHref } from "@/components/open-in-editor";
import { cn } from "@/lib/utils";
import type { Finding, FindingLevel } from "@/lib/types";
import { LEVEL_ORDER, pathToEditorTarget } from "./grouping";

/**
 * One child validator's outcome, as the CLI reports it in `data.validators`:
 * the validator script filename, a textual status, and its process exit code.
 */
export interface ValidatorOutcome {
  file: string;
  /** "passed" | "failed" | "skipped" | ... */
  status: string;
  code: number | null;
}

/** A validator "passed" iff status is passed AND its exit code is 0 (or null). */
export function validatorPassed(v: ValidatorOutcome): boolean {
  const okStatus = v.status.toLowerCase() === "passed";
  const okCode = v.code === 0 || v.code === null;
  return okStatus && okCode;
}

/** Pull the validator-outcome list out of an untyped envelope `data` payload. */
export function readValidators(data: unknown): ValidatorOutcome[] {
  if (typeof data !== "object" || data === null) return [];
  const raw = (data as { validators?: unknown }).validators;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is ValidatorOutcome =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as ValidatorOutcome).file === "string" &&
      typeof (v as ValidatorOutcome).status === "string",
  );
}

const LEVEL_META: Record<
  FindingLevel,
  { Icon: LucideIcon; row: string; badge: string; label: string }
> = {
  ERROR: {
    Icon: XCircle,
    row: "text-red-500",
    badge: "border-red-500/40 bg-red-500/10 text-red-500",
    label: "ERROR",
  },
  WARN: {
    Icon: AlertTriangle,
    row: "text-amber-500",
    badge: "border-amber-500/40 bg-amber-500/10 text-amber-500",
    label: "WARN",
  },
  INFO: {
    Icon: Info,
    row: "text-sky-500",
    badge: "border-sky-500/40 bg-sky-500/10 text-sky-500",
    label: "INFO",
  },
};

export interface ValidationValidatorsProps {
  /** The validate payload's validators collection (data.validators). */
  validators: ValidatorOutcome[];
  /** The flat finding list — used to attribute counts back to each validator. */
  findings?: Finding[];
}

/** Per-level + total tally of one validator's findings (errors-first ordered). */
interface LevelTally {
  total: number;
  byLevel: Record<FindingLevel, number>;
}

/**
 * A validator paired with the findings it emitted (matched on `source`) and a
 * per-level tally — the row's view model. `pass` folds the CLI status together
 * with whether it actually emitted any ERROR finding, so an unattributed error
 * can never read as green.
 */
interface ValidatorRow {
  outcome: ValidatorOutcome;
  pass: boolean;
  findings: Finding[];
  tally: LevelTally;
}

/** Errors-first tally of a validator's findings. */
function tallyOf(findings: Finding[]): LevelTally {
  const byLevel: Record<FindingLevel, number> = { ERROR: 0, WARN: 0, INFO: 0 };
  for (const f of findings) byLevel[f.level] += 1;
  return { total: findings.length, byLevel };
}

/**
 * Build the sorted row list. A validator is grouped with every finding whose
 * `source` is its filename; pass = CLI-passed AND no ERROR attributed to it.
 * Sort: failing first, then most findings, then alphabetically by file.
 */
function buildRows(
  validators: ValidatorOutcome[],
  findings: Finding[],
): ValidatorRow[] {
  // Bucket findings by emitting validator once, then attribute per validator.
  const bySource = new Map<string, Finding[]>();
  for (const f of findings) {
    const bucket = bySource.get(f.source);
    if (bucket) bucket.push(f);
    else bySource.set(f.source, [f]);
  }

  const rows = validators.map((outcome): ValidatorRow => {
    const own = bySource.get(outcome.file) ?? [];
    const tally = tallyOf(own);
    const pass = validatorPassed(outcome) && tally.byLevel.ERROR === 0;
    return { outcome, pass, findings: own, tally };
  });

  rows.sort((a, b) => {
    // Failing first.
    if (a.pass !== b.pass) return a.pass ? 1 : -1;
    // Then most findings first.
    if (a.tally.total !== b.tally.total) return b.tally.total - a.tally.total;
    // Then deterministic alphabetical.
    return a.outcome.file.localeCompare(b.outcome.file);
  });

  return rows;
}

export function ValidationValidators({
  validators,
  findings = [],
}: ValidationValidatorsProps) {
  const rows = useMemo(
    () => buildRows(validators, findings),
    [validators, findings],
  );
  const failing = rows.filter((r) => !r.pass).length;
  const allPass = validators.length > 0 && failing === 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
          Validators ({validators.length})
          {failing > 0 ? (
            <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-500">
              {failing} failing
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {validators.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">
            No validator results in this envelope.
          </p>
        ) : (
          <>
            {allPass ? (
              <p className="mb-3 flex items-center gap-1.5 font-mono text-xs text-emerald-500">
                <ShieldCheck className="size-3.5" />
                All {validators.length} validators pass.
              </p>
            ) : null}
            <ul className="flex flex-col gap-1.5">
              {rows.map((row) => (
                <ValidatorRowItem key={row.outcome.file} row={row} />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** One validator row: header (status + counts) with an expandable finding list. */
function ValidatorRowItem({ row }: { row: ValidatorRow }) {
  const [open, setOpen] = useState(false);
  const { outcome, pass, tally, findings } = row;
  const expandable = findings.length > 0;
  const StatusIcon = pass ? CheckCircle2 : XCircle;

  return (
    <li
      className={cn(
        "rounded border border-border",
        !pass && "border-red-500/40",
      )}
    >
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left",
          expandable && "hover:bg-muted/50",
          !expandable && "cursor-default",
        )}
      >
        {expandable ? (
          open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="size-3.5 shrink-0" aria-hidden />
        )}
        <StatusIcon
          className={cn(
            "size-3.5 shrink-0",
            pass ? "text-emerald-500" : "text-red-500",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
          {outcome.file}
        </span>

        {/* Per-level finding chips, errors-first. */}
        <span className="flex shrink-0 items-center gap-1">
          {LEVEL_ORDER.map((level) => {
            const n = tally.byLevel[level];
            if (n === 0) return null;
            const meta = LEVEL_META[level];
            return (
              <Badge
                key={level}
                variant="outline"
                className={cn("gap-1 font-mono text-[10px]", meta.badge)}
              >
                <meta.Icon className="size-2.5" />
                {n}
              </Badge>
            );
          })}
        </span>

        <span
          className={cn(
            "shrink-0 font-mono text-[10px] uppercase",
            pass ? "text-emerald-500" : "text-red-500",
          )}
        >
          {outcome.status}
          {outcome.code !== null && outcome.code !== 0
            ? ` (${outcome.code})`
            : ""}
        </span>
      </button>

      {expandable && open ? (
        <ul className="border-t border-border">
          {findings.map((f, i) => (
            <ValidatorFindingRow
              key={`${f.path}-${f.line ?? ""}-${i}`}
              finding={f}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * One finding under an expanded validator. Mirrors the Findings-tab jump link:
 * a managed-resource path deep-links to its in-app editor; everything else
 * falls back to a plain vscode:// file link.
 */
function ValidatorFindingRow({ finding }: { finding: Finding }) {
  const meta = LEVEL_META[finding.level];
  const loc = finding.line ? `${finding.path}:${finding.line}` : finding.path;
  const managed = pathToEditorTarget(finding.path);
  const vscodeHref = `vscode://file/${finding.path}${
    finding.line ? `:${finding.line}` : ""
  }`;
  const href = managed ? editorHref(managed.kind, managed.id) : vscodeHref;

  return (
    <li className="flex items-start gap-2 px-2 py-1.5 pl-7">
      <span
        className={cn(
          "mt-px inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase",
          meta.row,
        )}
      >
        <meta.Icon className="size-3" />
        {meta.label}
      </span>
      <a
        href={href}
        title={
          managed ? `Edit ${managed.kind} ${managed.id} (${loc})` : `Open ${loc}`
        }
        className="group inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-foreground underline-offset-2 hover:underline"
      >
        <ChevronRight className="size-3 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        {loc}
      </a>
      <span className="min-w-0 flex-1 whitespace-normal font-mono text-[11px] text-muted-foreground">
        {finding.message}
      </span>
    </li>
  );
}
