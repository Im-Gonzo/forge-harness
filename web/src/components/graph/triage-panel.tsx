"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { KIND_COLORS, type DanglingRef, type RegistryArtifact } from "./types";

interface Props {
  dangling: DanglingRef[];
  orphans: string[];
  artifacts: RegistryArtifact[];
  onFocus: (uid: string) => void;
}

/**
 * Read+navigate triage of graph health problems. Replaces the ambient
 * red-across-the-canvas treatment with a compact, navigable list:
 *
 *   • Dangling refs — each row is `from → rawRef`; clicking centers the
 *     referrer (onFocus(d.from)), which surfaces the existing in-canvas
 *     resolve flow. No resolve dialog lives here.
 *   • Orphans — each row is an orphan uid; clicking centers that node.
 *
 * Both sections collapse and carry a count badge; each has an explicit
 * empty state.
 */
export function TriagePanel({ dangling, orphans, onFocus }: Props) {
  return (
    <div className="flex flex-col gap-2 font-mono text-[11px]">
      <Section
        title="Dangling refs"
        count={dangling.length}
        emptyLabel="no dangling refs"
        defaultOpen={dangling.length > 0}
      >
        {dangling.map((d, i) => (
          <button
            key={`${d.from}::${d.rawRef}::${i}`}
            type="button"
            onClick={() => onFocus(d.from)}
            title={d.reason}
            className="group flex w-full items-center gap-1 rounded px-1.5 py-1 text-left transition-colors hover:bg-muted"
          >
            <span className="min-w-0 flex-1 truncate text-muted-foreground group-hover:text-foreground">
              {d.from}
            </span>
            <span className="shrink-0 text-muted-foreground/60">→</span>
            <span className="min-w-0 flex-1 truncate text-destructive">
              {d.rawRef}
            </span>
          </button>
        ))}
      </Section>

      <Section
        title="Orphans"
        count={orphans.length}
        emptyLabel="no orphans"
        defaultOpen={orphans.length > 0}
      >
        {orphans.map((uid) => {
          const kind = uid.includes(":") ? uid.slice(0, uid.indexOf(":")) : "";
          const color = KIND_COLORS[kind] ?? "var(--muted-foreground)";
          return (
            <button
              key={uid}
              type="button"
              onClick={() => onFocus(uid)}
              className="group flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-muted"
            >
              <span
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ background: color }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground group-hover:text-foreground">
                {uid}
              </span>
            </button>
          );
        })}
      </Section>
    </div>
  );
}

interface SectionProps {
  title: string;
  count: number;
  emptyLabel: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}

/** A collapsible, count-badged section with a scrollable body + empty state. */
function Section({
  title,
  count,
  emptyLabel,
  defaultOpen,
  children,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
      >
        <Chevron className="size-3 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <Badge
          variant={count > 0 ? "destructive" : "outline"}
          className="text-[9px]"
        >
          {count}
        </Badge>
      </button>

      {open ? (
        <div className={cn("border-t border-border", count === 0 && "px-2 py-2")}>
          {count === 0 ? (
            <p className="text-[10px] text-muted-foreground">{emptyLabel}</p>
          ) : (
            <ScrollArea className="max-h-48">
              <div className="space-y-0.5 p-1">{children}</div>
            </ScrollArea>
          )}
        </div>
      ) : null}
    </div>
  );
}

export type { Props as TriagePanelProps };
export default TriagePanel;
