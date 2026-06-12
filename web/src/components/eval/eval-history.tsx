"use client";

import { Minus, TrendingDown, TrendingUp } from "lucide-react";

import { OpenInEditor } from "@/components/open-in-editor";
import type { EvalLedgerRecord } from "@/lib/forge-bridge";
import type { ResourceKind } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Per-artifact grade TREND from the append-only eval ledger.
 *
 * For each artifact uid we read its run records (passed MOST-RECENT-FIRST by
 * `EvalWorkspace`) and render a compact grade-over-time row: a sparkline of the
 * per-run grades oldest→newest plus a trend verdict (improving / regressing /
 * stable) derived from the two latest runs. Each editable uid links to its
 * editor; non-editable kinds (validator / meta-test / engine / hook) render the
 * uid as plain text. When the ledger is empty the rail shows the explicit
 * "no runs recorded yet" empty state.
 *
 * Contract: ledgerByUid maps each artifact uid → its run records, most-recent
 * -first (the grouping `EvalWorkspace` passes down).
 */
export interface EvalHistoryProps {
  ledgerByUid: Record<string, EvalLedgerRecord[]>;
}

/**
 * Only the markdown-file resource kinds have an in-app editor route (mirrors the
 * grade-table set). An eval artifact uid is "<kind>:<id>"; other kinds
 * (validator, meta-test, engine, hook) are not per-file editable.
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
 * but only when the kind addresses an editable resource. Returns null for
 * non-editable kinds or a malformed uid.
 */
function editableTarget(
  uid: string,
): { kind: ResourceKind; id: string } | null {
  const sep = uid.indexOf(":");
  if (sep <= 0) return null;
  const kind = uid.slice(0, sep);
  const id = uid.slice(sep + 1);
  if (!id || !EDITABLE_KINDS.has(kind as ResourceKind)) return null;
  return { kind: kind as ResourceKind, id };
}

/** Ordinal score for a letter grade (higher = better); unknown ⇒ null. */
const GRADE_RANK: Record<string, number> = {
  A: 5,
  B: 4,
  C: 3,
  D: 2,
  F: 1,
};

/**
 * A single run reduced to what the trend row needs: the symbol to display, an
 * optional ordinal score for trend comparison, and a tone class.
 *
 * A run shows its letter grade when it has one; otherwise it falls back to a
 * status glyph ("U" for unevaluated, "•" for any other non-grading status).
 */
interface RunPoint {
  /** Glyph rendered in the sparkline (letter grade or "U" / "•"). */
  symbol: string;
  /** Ordinal for trend comparison, or null when not comparable. */
  score: number | null;
  /** Tailwind tone class for the glyph. */
  tone: string;
  /** Tooltip (status + timestamp). */
  title: string;
}

function isUnevaluated(grade: string | undefined, status: string | undefined) {
  return (
    grade === "U" ||
    grade === "UNEVALUATED" ||
    status === "UNEVALUATED" ||
    (!grade && !status)
  );
}

function toRunPoint(rec: EvalLedgerRecord): RunPoint {
  const grade = typeof rec.grade === "string" ? rec.grade : undefined;
  const status = typeof rec.status === "string" ? rec.status : undefined;
  const when = typeof rec.ts === "string" ? rec.ts : "unknown time";

  const rank = grade ? GRADE_RANK[grade] : undefined;
  if (rank !== undefined) {
    return {
      symbol: grade as string,
      score: rank,
      tone:
        rank >= 4
          ? "text-emerald-500"
          : rank >= 3
            ? "text-amber-500"
            : "text-destructive",
      title: `${grade}${status ? ` · ${status}` : ""} · ${when}`,
    };
  }

  if (isUnevaluated(grade, status)) {
    return {
      symbol: "U",
      score: null,
      tone: "text-muted-foreground",
      title: `Unevaluated · ${when}`,
    };
  }

  // A non-grading run (GREEN / REGRESSED / BLOCKED_BY_STATIC / …). Score it from
  // the status so consecutive GREEN→REGRESSED still reads as a regression.
  const statusScore =
    status === "GREEN" ? 5 : status === "REGRESSED" ? 1 : null;
  return {
    symbol: "•",
    score: statusScore,
    tone:
      status === "GREEN"
        ? "text-emerald-500"
        : status === "REGRESSED"
          ? "text-destructive"
          : "text-muted-foreground",
    title: `${status ?? "run"} · ${when}`,
  };
}

type TrendDir = "improving" | "regressing" | "stable" | "unknown";

/**
 * Trend from the two MOST-RECENT comparable runs (records arrive
 * most-recent-first). Needs ≥2 runs with comparable scores; otherwise unknown.
 */
function trendOf(records: EvalLedgerRecord[]): TrendDir {
  const scores = records
    .map((r) => toRunPoint(r).score)
    .filter((s): s is number => s !== null);
  if (scores.length < 2) return "unknown";
  const [latest, previous] = scores; // most-recent-first
  if (latest > previous) return "improving";
  if (latest < previous) return "regressing";
  return "stable";
}

function TrendBadge({ dir }: { dir: TrendDir }) {
  if (dir === "improving") {
    return (
      <span className="flex items-center gap-1 text-emerald-500">
        <TrendingUp className="size-3" />
        improving
      </span>
    );
  }
  if (dir === "regressing") {
    return (
      <span className="flex items-center gap-1 text-destructive">
        <TrendingDown className="size-3" />
        regressing
      </span>
    );
  }
  if (dir === "stable") {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Minus className="size-3" />
        stable
      </span>
    );
  }
  return (
    <span className="text-muted-foreground/70" title="Need ≥2 graded runs">
      —
    </span>
  );
}

/**
 * Compact grade-over-time sparkline: per-run glyphs oldest→newest. The latest
 * run is the last (rightmost) glyph and is emphasised.
 */
function Sparkline({ records }: { records: EvalLedgerRecord[] }) {
  // Records are most-recent-first → reverse so time flows left→right.
  const points = [...records].reverse().map(toRunPoint);
  const lastIdx = points.length - 1;
  return (
    <span className="flex items-center gap-0.5">
      {points.map((p, i) => (
        <span
          key={i}
          title={p.title}
          className={cn(
            "font-mono text-[11px] leading-none",
            p.tone,
            i === lastIdx && "font-semibold",
          )}
        >
          {p.symbol}
        </span>
      ))}
    </span>
  );
}

/** Latest run timestamp for a uid (records are most-recent-first). */
function latestTs(records: EvalLedgerRecord[]): string {
  const ts = records.find((r) => typeof r.ts === "string")?.ts;
  return ts ?? "—";
}

export function EvalHistory({ ledgerByUid }: EvalHistoryProps) {
  // Sort uids by their latest run (newest activity first); ties keep uid order.
  const uids = Object.keys(ledgerByUid).sort((a, b) => {
    const ta = Date.parse(latestTs(ledgerByUid[a]));
    const tb = Date.parse(latestTs(ledgerByUid[b]));
    const na = Number.isNaN(ta) ? 0 : ta;
    const nb = Number.isNaN(tb) ? 0 : tb;
    if (nb !== na) return nb - na;
    return a.localeCompare(b);
  });
  const runs = uids.reduce((n, uid) => n + ledgerByUid[uid].length, 0);

  if (uids.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
          Grade trend
        </h2>
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          No runs recorded yet — run a grading pass.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        Grade trend
      </h2>
      <p className="font-mono text-[11px] text-muted-foreground">
        {runs} run{runs === 1 ? "" : "s"} across {uids.length} artifact
        {uids.length === 1 ? "" : "s"}.
      </p>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-muted/20">
        {uids.map((uid) => {
          const records = ledgerByUid[uid];
          const target = editableTarget(uid);
          const dir = trendOf(records);
          return (
            <li
              key={uid}
              className="flex items-center justify-between gap-3 px-3 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-[11px] text-foreground">
                  {uid}
                </span>
                {target && (
                  <OpenInEditor
                    kind={target.kind}
                    id={target.id}
                    variant="ghost"
                    iconOnly
                  />
                )}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <Sparkline records={records} />
                <span
                  className="font-mono text-[10px] text-muted-foreground/80"
                  title={`Latest run: ${latestTs(records)}`}
                >
                  {records.length} run{records.length === 1 ? "" : "s"}
                </span>
                <span className="font-mono text-[11px]">
                  <TrendBadge dir={dir} />
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
