"use client";

/**
 * ResourceBrowser — the client surface of the /resources library browser.
 *
 * A kind selector (tabs) with per-kind counts and a search box that filters rows
 * by id + description. Each row links to its editor via the shared <OpenInEditor>
 * primitive; every WRITABLE kind also gets a "+ New" link. Hooks are listed and
 * editable but get NO "+ New" in Phase 1 (they live inside a shared JSON file).
 *
 * Bridge data arrives as plain props from the server page — this component never
 * touches the server-only bridge.
 */
import * as React from "react";
import Link from "next/link";
import { Plus, Search, X } from "lucide-react";

import { OpenInEditor } from "@/components/open-in-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { KIND_ACCENT } from "@/components/registry/registry-helpers";
import type { ResourceKind } from "@/lib/types";

/** Lean, client-safe row shape projected by the server page. */
export interface BrowserEntry {
  id: string;
  kind: ResourceKind;
  description: string;
}

/** The create route for a writable kind (mirrors editorHref's shape). */
function newResourceHref(kind: ResourceKind): string {
  return `/resources/${kind}/new`;
}

/**
 * The library kinds in browse order; hooks sit between rules and bundles.
 * Memory is omitted on purpose — it is project-local (managed at /fleet/[id]
 * Memory tab, explored read-only at /memory), so it never appears here.
 */
const KIND_ORDER: readonly ResourceKind[] = [
  "agent",
  "skill",
  "command",
  "rule",
  "hook",
  "bundle",
  "workflow",
  "mcp",
];

/** Writable kinds get a "+ New" link; hooks are intentionally excluded. */
const WRITABLE: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "workflow",
  "mcp",
]);

export function ResourceBrowser({
  groups,
}: {
  groups: Record<ResourceKind, BrowserEntry[]>;
}) {
  const [active, setActive] = React.useState<ResourceKind>("agent");
  const [query, setQuery] = React.useState("");

  // @base-ui Tabs#onValueChange yields `unknown`; narrow back to a kind.
  const onTab = (v: unknown) => setActive(v as ResourceKind);

  const entries = React.useMemo(() => groups[active] ?? [], [groups, active]);
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q),
    );
  }, [entries, query]);

  const canCreate = WRITABLE.has(active);

  return (
    <Tabs value={active} onValueChange={onTab} className="flex flex-col gap-3">
      <TabsList variant="line" className="flex-wrap">
        {KIND_ORDER.map((kind) => (
          <TabsTrigger key={kind} value={kind} className="font-mono text-xs">
            <span className={cn(KIND_ACCENT[kind])}>{kind}</span>
            <span className="ml-1 text-[10px] text-muted-foreground">
              {(groups[kind] ?? []).length}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>

      {/* Toolbar: search + per-kind "+ New" + count. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search id or description…"
            className="pl-8 font-mono text-xs"
            aria-label="search resources by id or description"
          />
        </div>

        {query.trim() !== "" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setQuery("")}
            className="font-mono text-xs"
          >
            <X className="size-3" />
            clear
          </Button>
        ) : null}

        {canCreate ? (
          <Button
            variant="outline"
            size="sm"
            className="font-mono text-xs"
            render={<Link href={newResourceHref(active)} />}
          >
            <Plus className="size-3" />
            New
          </Button>
        ) : (
          <Badge
            variant="outline"
            className="font-mono text-[10px] text-muted-foreground"
          >
            read-only create
          </Badge>
        )}

        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {filtered.length} / {entries.length} {active}
        </span>
      </div>

      {/* One panel per kind; only the active one mounts the table. */}
      {KIND_ORDER.map((kind) => (
        <TabsContent key={kind} value={kind}>
          {kind === active ? (
            <ResourceRows rows={filtered} kind={kind} />
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function ResourceRows({
  rows,
  kind,
}: {
  rows: BrowserEntry[];
  kind: ResourceKind;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table className="text-xs">
        <TableHeader className="sticky top-0 z-10 bg-muted/40 backdrop-blur">
          <TableRow className="hover:bg-transparent">
            <TableHead className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              id
            </TableHead>
            <TableHead className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              description
            </TableHead>
            <TableHead className="w-0 text-right font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              edit
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={3}
                className="py-10 text-center font-mono text-xs text-muted-foreground"
              >
                No {kind} resources match the search.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono font-medium text-foreground">
                  {row.id}
                </TableCell>
                <TableCell className="max-w-[36rem] truncate font-mono text-muted-foreground">
                  {row.description || (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <OpenInEditor kind={row.kind} id={row.id} size="xs" />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
