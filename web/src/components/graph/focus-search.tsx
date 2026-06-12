"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { KIND_COLORS, type RegistryArtifact } from "./types";

const MAX_RESULTS = 8;

/**
 * Compact search box that jumps the graph viewport to an artifact. Matches on
 * the kind-local `id` and `kind`; each result shows a KIND_COLORS swatch + id +
 * kind. Picking a result (click / Enter) calls onSelect(uid) and clears.
 * Self-contained — no bridge, no router. Mirrors the registry-table search
 * idiom (Search icon overlaid on a font-mono Input).
 */
export function FocusSearch({
  artifacts,
  onSelect,
  className,
}: {
  artifacts: RegistryArtifact[];
  onSelect: (uid: string) => void;
  className?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return artifacts
      .filter(
        (a) =>
          a.id.toLowerCase().includes(q) || a.kind.toLowerCase().includes(q),
      )
      .slice(0, MAX_RESULTS);
  }, [artifacts, query]);

  // Keep the highlighted row in range whenever the result set changes.
  React.useEffect(() => {
    setActive(0);
  }, [results]);

  const showList = open && results.length > 0;

  const pick = React.useCallback(
    (uid: string) => {
      onSelect(uid);
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
      const hit = results[active];
      if (hit) pick(hit.uid);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Defer the blur close so a result's onClick (which fires after blur)
        // still lands on the item before the list unmounts.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        placeholder="jump to artifact…"
        className="pl-8 font-mono text-xs"
        aria-label="search and focus an artifact"
        role="combobox"
        aria-expanded={showList}
        aria-controls="focus-search-results"
        autoComplete="off"
      />

      {showList ? (
        <ul
          id="focus-search-results"
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
        >
          {results.map((a, i) => {
            const color = KIND_COLORS[a.kind] ?? "var(--muted-foreground)";
            return (
              <li
                key={a.uid}
                role="option"
                aria-selected={i === active}
                // onMouseDown (not onClick) so selection wins the race with the
                // Input's onBlur, which would otherwise close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(a.uid);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 font-mono text-xs outline-none select-none",
                  i === active
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground",
                )}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: color }}
                />
                <span className="truncate font-medium">{a.id}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {a.kind}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
