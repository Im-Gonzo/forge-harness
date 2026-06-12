"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { MemoryEntry } from "@/lib/forge-bridge";

import { memoryTypeColor } from "./memory-colors";

const MAX_RESULTS = 8;

/**
 * Compact search box that centers the memory lens on an entry. Matches on
 * title and id; each result shows a type swatch + title + type. Picking a
 * result (click / Enter) calls onSelect(id) and clears. Mirrors
 * graph/focus-search.tsx.
 */
export function MemorySearch({
  entries,
  onSelect,
  className,
}: {
  entries: MemoryEntry[];
  onSelect: (id: string) => void;
  className?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return entries
      .filter(
        (e) =>
          e.title.toLowerCase().includes(q) || e.id.toLowerCase().includes(q),
      )
      .slice(0, MAX_RESULTS);
  }, [entries, query]);

  // Keep the highlighted row in range whenever the result set shrinks, without
  // a setState-in-effect (React's "adjust state during render" pattern).
  const clampedActive = active < results.length ? active : 0;

  const showList = open && results.length > 0;

  const pick = React.useCallback(
    (id: string) => {
      onSelect(id);
      setQuery("");
      setOpen(false);
      setActive(0);
    },
    [onSelect],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showList) {
      if (e.key === "ArrowDown" && results.length > 0) {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[clampedActive];
      if (hit) pick(hit.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className={cn("relative w-full sm:w-72", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        placeholder="jump to memory entry…"
        className="pl-8 font-mono text-xs"
        aria-label="search and focus a memory entry"
        role="combobox"
        aria-expanded={showList}
        aria-controls="memory-search-results"
        autoComplete="off"
      />

      {showList ? (
        <ul
          id="memory-search-results"
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
        >
          {results.map((e, i) => {
            const color = memoryTypeColor(e.type);
            return (
              <li
                key={e.id}
                role="option"
                aria-selected={i === clampedActive}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  pick(e.id);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 font-mono text-xs outline-none select-none",
                  i === clampedActive
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground",
                )}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: color }}
                />
                <span className="truncate font-medium">{e.title}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {e.type ?? "memory"}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
