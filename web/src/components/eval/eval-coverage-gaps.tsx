"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { OpenInEditor } from "@/components/open-in-editor";
import type { EvalArtifact } from "@/components/eval/types";
import type { ResourceKind } from "@/lib/types";

/**
 * Coverage gaps — the "author the eval next" worklist. These are catalogued
 * artifacts that ship NO golden set, so under author-eval discipline they stay
 * grade "U" forever until someone writes one. This rail tells you WHAT to author
 * next: the highest-criticality uncovered artifacts float to the top, and each
 * row links straight to its editor so you can add the golden set in place.
 *
 * Contract: `gaps` is the uncovered-artifact set (no golden set). EvalWorkspace
 * pre-sorts it by criticality; this component re-sorts defensively (stable, by
 * the same rank) so the worklist is correct regardless of upstream ordering.
 */
export interface EvalCoverageGapsProps {
  gaps: EvalArtifact[];
}

/**
 * Only the markdown-file resource kinds have an in-app editor route. An eval
 * artifact uid is "<kind>:<id>"; other kinds (validator, meta-test, engine —
 * and hook, which lives inside hooks/hooks.json) are not per-file editable, so
 * those rows render their uid as plain text with a "not editable here" hint.
 * Mirrors EDITABLE_KINDS in grade-table.tsx.
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
 * Split an eval artifact uid ("<kind>:<id>") into its kind + kind-local id, but
 * only for editable resource kinds. Returns null for non-editable kinds or a
 * malformed uid. Split-on-first-colon keeps any remaining colons in the id.
 */
function editableTarget(uid: string): { kind: ResourceKind; id: string } | null {
  const sep = uid.indexOf(":");
  if (sep <= 0) return null;
  const kind = uid.slice(0, sep);
  const id = uid.slice(sep + 1);
  if (!id || !EDITABLE_KINDS.has(kind as ResourceKind)) return null;
  return { kind: kind as ResourceKind, id };
}

/**
 * Criticality rank — higher number sorts first. Registry criticality is
 * "safety" | "compliance" | "normal"; the report may use "standard" or omit it
 * entirely (older payloads). Anything unrecognized / absent ranks lowest, so an
 * uncovered safety-critical artifact always tops the worklist.
 */
const CRITICALITY_RANK: Record<string, number> = {
  safety: 3,
  compliance: 2,
  standard: 1,
  normal: 1,
};

function rankOf(c: string | undefined): number {
  if (!c) return 0;
  return CRITICALITY_RANK[c.toLowerCase()] ?? 0;
}

/** "safety"/"compliance" gaps are the urgent ones — flag their badge. */
function isUrgent(c: string | undefined): boolean {
  return rankOf(c) >= 2;
}

export function EvalCoverageGaps({ gaps }: EvalCoverageGapsProps) {
  if (gaps.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-foreground/70" />
        Every catalogued artifact ships a golden set — nothing to author.
      </div>
    );
  }

  // Defensive stable sort: highest criticality first, ties broken by uid. The
  // worklist must surface the riskiest uncovered artifacts at the top even if
  // upstream ordering ever changes.
  const sorted = [...gaps].sort((a, b) => {
    const rd = rankOf(b.criticality) - rankOf(a.criticality);
    if (rd !== 0) return rd;
    return a.uid.localeCompare(b.uid);
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">
          <AlertTriangle className="size-3.5" />
          Author the eval next
        </h2>
        <span className="font-mono text-2xl font-semibold leading-none tracking-tight text-foreground">
          {sorted.length}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          artifact{sorted.length === 1 ? "" : "s"} with no golden set (grade
          stays U)
        </span>
      </div>

      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-muted/20">
        {sorted.map((a) => {
          const target = editableTarget(a.uid);
          const urgent = isUrgent(a.criticality);
          return (
            <li
              key={a.uid}
              className="flex items-center justify-between gap-2 px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-xs text-foreground">
                  {a.uid}
                </span>
                {a.criticality ? (
                  <Badge
                    variant={urgent ? "destructive" : "secondary"}
                    className="shrink-0 font-mono text-[10px]"
                  >
                    {a.criticality}
                  </Badge>
                ) : null}
              </span>
              {target ? (
                <OpenInEditor
                  kind={target.kind}
                  id={target.id}
                  variant="outline"
                  size="sm"
                  label="Author eval"
                  className="shrink-0"
                />
              ) : (
                <span
                  className="shrink-0 font-mono text-[10px] text-muted-foreground"
                  title="This artifact kind has no in-app editor — author its golden set on disk."
                >
                  not editable here
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
