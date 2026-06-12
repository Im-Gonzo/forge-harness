"use client";

/**
 * diff-view — render the additive-write DIFF (draft vs the file on disk) as
 * collapsed hunks. On create the whole serialized document is shown as additions.
 */
import { cn } from "@/lib/utils";

import { diffLines, hasChanges, toHunks } from "./diff";

export function DiffView({
  original,
  next,
  isNew,
}: {
  original: string;
  next: string;
  isNew: boolean;
}) {
  if (isNew) {
    const lines = next.split("\n");
    return (
      <pre className="overflow-x-auto rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] p-3 font-mono text-[11px] leading-relaxed">
        {lines.map((line, i) => (
          <div key={i} className="text-emerald-500">
            <span className="select-none pr-2 text-emerald-500/50">+</span>
            {line || " "}
          </div>
        ))}
      </pre>
    );
  }

  if (!hasChanges(original, next)) {
    return (
      <p className="font-mono text-xs text-muted-foreground">
        No pending changes — the draft matches the file on disk.
      </p>
    );
  }

  const hunks = toHunks(diffLines(original, next));

  return (
    <div className="flex flex-col gap-3">
      {hunks.map((hunk, hi) => (
        <pre
          key={hi}
          className="overflow-x-auto rounded-lg border border-border bg-background/50 p-3 font-mono text-[11px] leading-relaxed"
        >
          {hunk.map((l, li) => (
            <div
              key={li}
              className={cn(
                l.kind === "add" && "text-emerald-500",
                l.kind === "del" && "text-destructive",
                l.kind === "ctx" && "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "select-none pr-2",
                  l.kind === "add" && "text-emerald-500/50",
                  l.kind === "del" && "text-destructive/50",
                  l.kind === "ctx" && "text-muted-foreground/40",
                )}
              >
                {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
              </span>
              {l.text || " "}
            </div>
          ))}
        </pre>
      ))}
    </div>
  );
}
