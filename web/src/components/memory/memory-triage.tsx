"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { MemoryEntry } from "@/lib/forge-bridge";

import { memoryTypeColor } from "./memory-colors";

interface DanglingItem {
  /** id of the entry that owns the unresolved link. */
  source: string;
  /** raw (unresolved) wiki-link target text. */
  rawTarget: string;
}

interface Props {
  /** Entries with zero in AND out links. */
  orphans: string[];
  /** Unresolved [[wiki-link]] occurrences. */
  dangling: DanglingItem[];
  /** All entries (for the type swatch + title lookup). */
  entries: MemoryEntry[];
  /** Center the lens on an entry id. */
  onFocus: (id: string) => void;
}

/**
 * Read+navigate triage of memory-graph health: dangling wiki-links and
 * orphans. Each row clicks into focus (centers the relevant entry). Mirrors
 * graph/triage-panel.tsx. Both sections collapse + carry a count badge.
 */
export function MemoryTriage({ orphans, dangling, entries, onFocus }: Props) {
  const titleById = new Map(entries.map((e) => [e.id, e.title]));
  const typeById = new Map(entries.map((e) => [e.id, e.type]));

  return (
    <div className="flex flex-col gap-2 font-mono text-[11px]">
      <Section
        title="Dangling links"
        count={dangling.length}
        emptyLabel="no dangling links"
        defaultOpen={dangling.length > 0}
      >
        {dangling.map((d, i) => (
          <button
            key={`${d.source}::${d.rawTarget}::${i}`}
            type="button"
            onClick={() => onFocus(d.source)}
            title={`${d.source} → ${d.rawTarget}`}
            className="group flex w-full items-center gap-1 rounded px-1.5 py-1 text-left transition-colors hover:bg-muted"
          >
            <span className="min-w-0 flex-1 truncate text-muted-foreground group-hover:text-foreground">
              {titleById.get(d.source) ?? d.source}
            </span>
            <span className="shrink-0 text-muted-foreground/60">→</span>
            <span className="min-w-0 flex-1 truncate text-destructive">
              {d.rawTarget}
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
        {orphans.map((id) => {
          const color = memoryTypeColor(typeById.get(id) ?? null);
          return (
            <button
              key={id}
              type="button"
              onClick={() => onFocus(id)}
              className="group flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-muted"
            >
              <span
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ background: color }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground group-hover:text-foreground">
                {titleById.get(id) ?? id}
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

export type { DanglingItem };
