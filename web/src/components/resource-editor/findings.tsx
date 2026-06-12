"use client";

/**
 * findings — render `forge validate` findings (C2) for the Validate/Preview tab.
 *
 * Severity is colour-coded; ERRORs block (ok:false), WARN/INFO are advisory and
 * NON-BLOCKING (ADR-0007). A finding scoped to the resource being edited is the
 * common case, but the list shows every finding the write cycle surfaced so the
 * editor never hides a regression elsewhere in the harness.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Finding, FindingLevel } from "@/lib/types";

const LEVEL_STYLE: Record<
  FindingLevel,
  { badge: string; row: string }
> = {
  ERROR: {
    badge: "border-destructive/40 bg-destructive/15 text-destructive",
    row: "border-destructive/30",
  },
  WARN: {
    badge: "border-amber-500/40 bg-amber-500/15 text-amber-500",
    row: "border-amber-500/30",
  },
  INFO: {
    badge: "border-border bg-muted text-muted-foreground",
    row: "border-border",
  },
};

export function FindingsList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
        <p className="font-mono text-xs text-emerald-500">
          No findings — validate is clean.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {findings.map((f, idx) => {
        const style = LEVEL_STYLE[f.level] ?? LEVEL_STYLE.INFO;
        return (
          <li
            key={`${f.path}:${f.line ?? "?"}:${idx}`}
            className={cn(
              "flex items-start gap-2 rounded-lg border bg-background/50 px-3 py-2",
              style.row,
            )}
          >
            <Badge
              variant="outline"
              className={cn("shrink-0 font-mono text-[10px]", style.badge)}
            >
              {f.level}
            </Badge>
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-xs text-foreground">
                {f.message}
              </span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {f.path}
                {f.line != null ? `:${f.line}` : ""} · {f.source}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
