"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Checkbox } from "@base-ui/react/checkbox";
import { Menu } from "@base-ui/react/menu";
import {
  ArrowUp,
  ArrowDown,
  Check,
  ChevronsUpDown,
  Columns3,
  Loader2,
  Plus,
  Rows3,
  Rows4,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ArtifactKind, RegistryArtifact, ResourceKind } from "@/lib/types";
import { OpenInEditor } from "@/components/open-in-editor";
import { RegistryDetailDrawer } from "./registry-detail-drawer";
import {
  ALL,
  CREATABLE_KINDS,
  KIND_ACCENT,
  decodeViewState,
  encodeViewState,
  formatCost,
  isSelectableKind,
  shortHash,
  statusBadgeVariant,
  criticalityBadgeVariant,
} from "./registry-helpers";
import type {
  CostByUid,
  DependentsByUid,
  Density,
  FindingsByUid,
  TableViewState,
} from "./registry-helpers";

type SortKey =
  | "uid"
  | "kind"
  | "version"
  | "revision"
  | "status"
  | "criticality"
  | "cost";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "uid", label: "uid" },
  { key: "kind", label: "kind" },
  { key: "version", label: "version" },
  { key: "revision", label: "rev", className: "text-right" },
  { key: "status", label: "status" },
  { key: "criticality", label: "criticality" },
  { key: "cost", label: "cost", className: "text-right" },
];

// Non-sortable, always-present columns the visibility menu can also toggle.
const EXTRA_COLUMNS: { key: string; label: string }[] = [
  { key: "modules", label: "modules" },
  { key: "hash", label: "hash" },
];

// Every toggleable column key (the visibility menu lists these in table order).
const ALL_COLUMN_KEYS: { key: string; label: string }[] = [
  ...COLUMNS.map((c) => ({ key: c.key as string, label: c.label })),
  ...EXTRA_COLUMNS,
];

function uniqueSorted<T>(values: T[]): T[] {
  return Array.from(new Set(values)).sort();
}

// Only the editable resource kinds have an in-app editor route. ArtifactKind is
// a superset (validator/meta-test/engine have no editor), so we narrow before
// linking and skip the affordance for non-editable kinds — mirroring the
// validation-view precedent of leaving unlinkable artifacts untouched.
const EDITABLE_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "memory",
  "hook",
]);

function editableKind(kind: ArtifactKind): ResourceKind | null {
  return (EDITABLE_KINDS as ReadonlySet<string>).has(kind)
    ? (kind as ResourceKind)
    : null;
}

function compare(
  a: RegistryArtifact,
  b: RegistryArtifact,
  key: SortKey,
  costByUid: CostByUid,
): number {
  if (key === "revision") return a.revision - b.revision;
  if (key === "cost") {
    // Nulls sort last in asc (treated as -Infinity flipped): keep them grouped
    // at the bottom of an ascending sort regardless of direction-multiplier by
    // comparing on a large sentinel when absent.
    const av = costByUid[a.uid]?.alwaysOn;
    const bv = costByUid[b.uid]?.alwaysOn;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av - bv;
  }
  const av = String(a[key] ?? "");
  const bv = String(b[key] ?? "");
  return av.localeCompare(bv, undefined, { numeric: true });
}

function SortHeader({
  col,
  sortKey,
  sortDir,
  onSort,
}: {
  col: (typeof COLUMNS)[number];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === col.key;
  const Icon = !active ? ChevronsUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={cn("select-none p-0", col.className)}>
      <button
        type="button"
        onClick={() => onSort(col.key)}
        className={cn(
          "flex h-9 w-full items-center gap-1 px-2 font-mono text-[11px] uppercase tracking-wide transition-colors hover:text-foreground",
          col.className === "text-right" ? "justify-end" : "justify-start",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {col.label}
        <Icon className="size-3 shrink-0 opacity-70" />
      </button>
    </TableHead>
  );
}

/** Shared base-ui Menu popup styling (matches the Select popup tokens). */
const MENU_POPUP_CLASS =
  "isolate z-50 min-w-44 origin-(--transform-origin) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";
const MENU_ITEM_CLASS =
  "relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 font-mono text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground";

export function RegistryTable({
  artifacts,
  costByUid = {},
  dependentsByUid = {},
  findingsByUid = {},
}: {
  artifacts: RegistryArtifact[];
  /** uid → joined `forge analyze` cost slice. */
  costByUid?: CostByUid;
  /** uid → reverse-dependency uids (who depends on this artifact). */
  dependentsByUid?: DependentsByUid;
  /** uid → `forge validate` findings for this artifact's file. */
  findingsByUid?: FindingsByUid;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Saved/shareable view (R5): the URL is the source of truth, hydrated once
  // on mount and written back (shallow) whenever the view changes. Defaults are
  // diffed out of the URL so a pristine table keeps the address bar clean.
  const defaults = React.useMemo<TableViewState>(
    () => ({
      query: "",
      kind: ALL,
      status: ALL,
      crit: ALL,
      sortKey: "uid",
      sortDir: "asc",
      density: "comfortable",
      hidden: [],
    }),
    [],
  );
  const initial = React.useMemo<TableViewState>(
    () => decodeViewState(new URLSearchParams(searchParams.toString()), defaults),
    // Hydrate from the URL ONCE on mount; later edits flow URL ← state, not back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [query, setQuery] = React.useState(initial.query);
  const [kindFilter, setKindFilter] = React.useState<string>(initial.kind);
  const [statusFilter, setStatusFilter] = React.useState<string>(initial.status);
  const [critFilter, setCritFilter] = React.useState<string>(initial.crit);
  const [sortKey, setSortKey] = React.useState<SortKey>(
    initial.sortKey as SortKey,
  );
  const [sortDir, setSortDir] = React.useState<SortDir>(initial.sortDir);
  const [density, setDensity] = React.useState<Density>(initial.density);
  const [hidden, setHidden] = React.useState<string[]>(initial.hidden);

  const [selected, setSelected] = React.useState<RegistryArtifact | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // ── Bulk selection (R2): a set of selected uids; only ResourceKind rows are
  // ever added (validator/meta-test/engine are excluded from selection).
  const [checkedUids, setCheckedUids] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const kinds = React.useMemo(
    () => uniqueSorted(artifacts.map((a) => a.kind)),
    [artifacts],
  );
  const statuses = React.useMemo(
    () => uniqueSorted(artifacts.map((a) => a.status)),
    [artifacts],
  );
  const criticalities = React.useMemo(
    () => uniqueSorted(artifacts.map((a) => a.criticality)),
    [artifacts],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = artifacts.filter((a) => {
      if (kindFilter !== ALL && a.kind !== kindFilter) return false;
      if (statusFilter !== ALL && a.status !== statusFilter) return false;
      if (critFilter !== ALL && a.criticality !== critFilter) return false;
      if (q && !a.uid.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return rows.sort((a, b) => compare(a, b, sortKey, costByUid) * dir);
  }, [
    artifacts,
    query,
    kindFilter,
    statusFilter,
    critFilter,
    sortKey,
    sortDir,
    costByUid,
  ]);

  // Mirror the live view into the URL (shallow, default-diffed) so it is
  // shareable and reload-stable, without re-rendering the server page.
  React.useEffect(() => {
    const view: TableViewState = {
      query,
      kind: kindFilter,
      status: statusFilter,
      crit: critFilter,
      sortKey,
      sortDir,
      density,
      hidden,
    };
    const qs = encodeViewState(view, defaults).toString();
    const next = qs ? `?${qs}` : window.location.pathname;
    if (window.location.search.replace(/^\?/, "") !== qs) {
      router.replace(next, { scroll: false });
    }
  }, [
    query,
    kindFilter,
    statusFilter,
    critFilter,
    sortKey,
    sortDir,
    density,
    hidden,
    defaults,
    router,
  ]);

  const isHidden = React.useCallback(
    (key: string) => hidden.includes(key),
    [hidden],
  );

  const onSort = React.useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prevKey;
      }
      setSortDir("asc");
      return key;
    });
  }, []);

  const openRow = React.useCallback((a: RegistryArtifact) => {
    setSelected(a);
    setDrawerOpen(true);
  }, []);

  // @base-ui Select#onValueChange yields `string | null`; coalesce to ALL.
  const onKind = (v: string | null) => setKindFilter(v ?? ALL);
  const onStatus = (v: string | null) => setStatusFilter(v ?? ALL);
  const onCrit = (v: string | null) => setCritFilter(v ?? ALL);

  const filtersActive =
    query.trim() !== "" ||
    kindFilter !== ALL ||
    statusFilter !== ALL ||
    critFilter !== ALL;

  const clearFilters = () => {
    setQuery("");
    setKindFilter(ALL);
    setStatusFilter(ALL);
    setCritFilter(ALL);
  };

  // ── Selection helpers (R2) ────────────────────────────────────────────────
  // Selectable subset of the CURRENTLY-FILTERED rows (drives select-all state).
  const selectableFiltered = React.useMemo(
    () => filtered.filter((a) => isSelectableKind(a.kind)),
    [filtered],
  );
  const selectedRows = React.useMemo(
    () => artifacts.filter((a) => checkedUids.has(a.uid)),
    [artifacts, checkedUids],
  );
  const allFilteredSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((a) => checkedUids.has(a.uid));
  const someFilteredSelected =
    selectableFiltered.some((a) => checkedUids.has(a.uid)) &&
    !allFilteredSelected;

  const toggleRow = React.useCallback((uid: string) => {
    setCheckedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const toggleSelectAll = React.useCallback(() => {
    setCheckedUids((prev) => {
      const next = new Set(prev);
      const everySelected = selectableFiltered.every((a) => next.has(a.uid));
      // Select-all toggles only the visible/selectable rows, leaving selections
      // from other filter states untouched (predictable across filter changes).
      for (const a of selectableFiltered) {
        if (everySelected) next.delete(a.uid);
        else next.add(a.uid);
      }
      return next;
    });
  }, [selectableFiltered]);

  // ── Bulk delete (R2) ──────────────────────────────────────────────────────
  // Client-side SEQUENTIAL DELETE, one row at a time, with a progress toast.
  // NOTE: each DELETE hits /api/resource/<kind>/<id>?confirm=1, which runs the
  // full write cycle (forge validate + forge registry build --write) per row.
  // That serial validate/rebuild is why we don't fire these in parallel; a
  // future batched bulk endpoint could run validate+build ONCE for the set.
  const runBulkDelete = React.useCallback(async () => {
    setConfirmOpen(false);
    const rows = selectedRows.filter((a) => isSelectableKind(a.kind));
    if (rows.length === 0) return;

    setDeleting(true);
    const toastId = toast.loading(`Deleting 0 / ${rows.length}…`);
    let ok = 0;
    const failures: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      toast.loading(`Deleting ${i + 1} / ${rows.length} · ${a.uid}`, {
        id: toastId,
      });
      try {
        const url = `/api/resource/${a.kind}/${encodeURIComponent(a.id)}?confirm=1`;
        const res = await fetch(url, { method: "DELETE", cache: "no-store" });
        const json = (await res.json()) as
          | { ok: boolean; error?: string }
          | { ok: false; error: string };
        if (!res.ok || ("error" in json && json.error)) {
          failures.push(a.uid);
        } else {
          ok += 1;
          // Drop the successfully-deleted uid from the selection as we go.
          setCheckedUids((prev) => {
            const next = new Set(prev);
            next.delete(a.uid);
            return next;
          });
        }
      } catch {
        failures.push(a.uid);
      }
    }

    if (failures.length === 0) {
      toast.success(`Deleted ${ok} artifact${ok === 1 ? "" : "s"}.`, {
        id: toastId,
      });
    } else {
      toast.error(
        `Deleted ${ok}, ${failures.length} failed: ${failures.join(", ")}`,
        { id: toastId },
      );
    }
    setDeleting(false);
    router.refresh();
  }, [selectedRows, router]);

  const onNewKind = (v: string | null) => {
    if (!v) return;
    router.push(`/resources/${v}/new`);
  };

  // Span of the body's empty-state cell: checkbox + visible data cols + edit.
  const visibleDataCols = ALL_COLUMN_KEYS.filter((c) => !isHidden(c.key)).length;
  const emptyColSpan = 1 + visibleDataCols + 1;

  const cellPad = density === "compact" ? "py-1" : "py-2.5";

  return (
    <div className="flex flex-col gap-3">
      {/* Filter + action toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search uid…"
            className="pl-8 font-mono text-xs"
            aria-label="search by uid"
          />
        </div>

        <Select value={kindFilter} onValueChange={onKind}>
          <SelectTrigger size="sm" className="font-mono text-xs">
            <SelectValue placeholder="kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>all kinds</SelectItem>
            {kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={onStatus}>
          <SelectTrigger size="sm" className="font-mono text-xs">
            <SelectValue placeholder="status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>all statuses</SelectItem>
            {statuses.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={critFilter} onValueChange={onCrit}>
          <SelectTrigger size="sm" className="font-mono text-xs">
            <SelectValue placeholder="criticality" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>all criticality</SelectItem>
            {criticalities.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {filtersActive ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="font-mono text-xs"
          >
            <X className="size-3" />
            clear
          </Button>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {/* R5: column-visibility menu */}
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button variant="outline" size="sm" className="font-mono text-xs">
                  <Columns3 className="size-3.5" />
                  columns
                </Button>
              }
            />
            <Menu.Portal>
              <Menu.Positioner
                side="bottom"
                align="end"
                sideOffset={4}
                className="isolate z-50"
              >
                <Menu.Popup className={MENU_POPUP_CLASS}>
                  {ALL_COLUMN_KEYS.map((c) => {
                    const visible = !isHidden(c.key);
                    return (
                      <Menu.CheckboxItem
                        key={c.key}
                        checked={visible}
                        // Keep the menu open while toggling several columns.
                        closeOnClick={false}
                        onCheckedChange={(checked) =>
                          setHidden((prev) =>
                            checked
                              ? prev.filter((k) => k !== c.key)
                              : prev.includes(c.key)
                                ? prev
                                : [...prev, c.key],
                          )
                        }
                        className={MENU_ITEM_CLASS}
                      >
                        <span className="flex size-3.5 items-center justify-center">
                          <Menu.CheckboxItemIndicator>
                            <Check className="size-3.5" />
                          </Menu.CheckboxItemIndicator>
                        </span>
                        {c.label}
                      </Menu.CheckboxItem>
                    );
                  })}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>

          {/* R5: density toggle (comfortable ⇄ compact) */}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDensity((d) => (d === "compact" ? "comfortable" : "compact"))
            }
            className="font-mono text-xs"
            aria-pressed={density === "compact"}
            title={
              density === "compact"
                ? "Switch to comfortable rows"
                : "Switch to compact rows"
            }
          >
            {density === "compact" ? (
              <Rows4 className="size-3.5" />
            ) : (
              <Rows3 className="size-3.5" />
            )}
            {density === "compact" ? "compact" : "comfortable"}
          </Button>

          {/* R1: CREATE — kind picker → /resources/<kind>/new. Using a Select as
              a one-shot picker (no committed value; reset placeholder each time). */}
          <Select value={null} onValueChange={onNewKind}>
            <SelectTrigger size="sm" className="font-mono text-xs">
              <Plus className="size-3.5" />
              <SelectValue placeholder="new" />
            </SelectTrigger>
            <SelectContent>
              {CREATABLE_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="w-full text-right font-mono text-[11px] text-muted-foreground sm:w-auto">
          {filtered.length} / {artifacts.length} artifacts
        </span>
      </div>

      {/* R2: bulk-action bar — appears only when rows are selected. */}
      {checkedUids.size > 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <span className="font-mono text-xs text-foreground">
            {checkedUids.size} selected
          </span>
          <span className="text-muted-foreground">·</span>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={deleting}
            className="font-mono text-xs"
          >
            {deleting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            Delete selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCheckedUids(new Set())}
            disabled={deleting}
            className="ml-auto font-mono text-xs"
          >
            <X className="size-3" />
            clear selection
          </Button>
        </div>
      ) : null}

      {/* Catalog table */}
      <div className="overflow-hidden rounded-lg border border-border">
        <Table className="text-xs">
          <TableHeader className="sticky top-0 z-10 bg-muted/40 backdrop-blur">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-px px-2">
                <Checkbox.Root
                  checked={allFilteredSelected}
                  indeterminate={someFilteredSelected}
                  onCheckedChange={() => toggleSelectAll()}
                  disabled={selectableFiltered.length === 0}
                  aria-label="select all filtered"
                  className="flex size-4 items-center justify-center rounded border border-input bg-transparent text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary data-checked:bg-primary data-indeterminate:border-primary data-indeterminate:bg-primary disabled:opacity-40"
                >
                  <Checkbox.Indicator
                    className="flex items-center justify-center"
                    keepMounted
                  >
                    {someFilteredSelected ? (
                      <span className="block h-0.5 w-2 rounded bg-primary-foreground" />
                    ) : (
                      <Check className="size-3" />
                    )}
                  </Checkbox.Indicator>
                </Checkbox.Root>
              </TableHead>
              {COLUMNS.filter((col) => !isHidden(col.key)).map((col) => (
                <SortHeader
                  key={col.key}
                  col={col}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
              ))}
              {!isHidden("modules") ? (
                <TableHead className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                  modules
                </TableHead>
              ) : null}
              {!isHidden("hash") ? (
                <TableHead className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                  hash
                </TableHead>
              ) : null}
              <TableHead className="w-px text-right font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                <span className="sr-only">edit</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={emptyColSpan}
                  className="py-10 text-center font-mono text-xs text-muted-foreground"
                >
                  No artifacts match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((a) => {
                const selectable = isSelectableKind(a.kind);
                const checked = checkedUids.has(a.uid);
                return (
                  <TableRow
                    key={a.uid}
                    onClick={() => openRow(a)}
                    tabIndex={0}
                    role="button"
                    data-state={checked ? "selected" : undefined}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openRow(a);
                      }
                    }}
                    className="cursor-pointer"
                  >
                    <TableCell className={cn("w-px px-2", cellPad)}>
                      {selectable ? (
                        // Wrapper swallows row activation so toggling the
                        // checkbox never also opens the drawer.
                        <span
                          className="inline-flex"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Checkbox.Root
                            checked={checked}
                            onCheckedChange={() => toggleRow(a.uid)}
                            aria-label={`select ${a.uid}`}
                            className="flex size-4 items-center justify-center rounded border border-input bg-transparent text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary data-checked:bg-primary"
                          >
                            <Checkbox.Indicator className="flex items-center justify-center">
                              <Check className="size-3" />
                            </Checkbox.Indicator>
                          </Checkbox.Root>
                        </span>
                      ) : null}
                    </TableCell>
                    {!isHidden("uid") ? (
                      <TableCell
                        className={cn(
                          "font-mono font-medium text-foreground",
                          cellPad,
                        )}
                      >
                        {a.uid}
                      </TableCell>
                    ) : null}
                    {!isHidden("kind") ? (
                      <TableCell className={cellPad}>
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-mono text-[10px]",
                            KIND_ACCENT[a.kind] ?? "",
                          )}
                        >
                          {a.kind}
                        </Badge>
                      </TableCell>
                    ) : null}
                    {!isHidden("version") ? (
                      <TableCell
                        className={cn("font-mono text-muted-foreground", cellPad)}
                      >
                        {a.version}
                      </TableCell>
                    ) : null}
                    {!isHidden("revision") ? (
                      <TableCell
                        className={cn(
                          "text-right font-mono text-muted-foreground",
                          cellPad,
                        )}
                      >
                        {a.revision}
                      </TableCell>
                    ) : null}
                    {!isHidden("status") ? (
                      <TableCell className={cellPad}>
                        <Badge
                          variant={statusBadgeVariant(a.status)}
                          className="font-mono text-[10px]"
                        >
                          {a.status}
                        </Badge>
                      </TableCell>
                    ) : null}
                    {!isHidden("criticality") ? (
                      <TableCell className={cellPad}>
                        <Badge
                          variant={criticalityBadgeVariant(a.criticality)}
                          className="font-mono text-[10px]"
                        >
                          {a.criticality}
                        </Badge>
                      </TableCell>
                    ) : null}
                    {!isHidden("cost") ? (
                      <TableCell
                        className={cn(
                          "text-right font-mono tabular-nums text-muted-foreground",
                          cellPad,
                        )}
                        title={costByUid[a.uid]?.residency ?? undefined}
                      >
                        {formatCost(costByUid[a.uid]?.alwaysOn)}
                      </TableCell>
                    ) : null}
                    {!isHidden("modules") ? (
                      <TableCell className={cn("max-w-[16rem]", cellPad)}>
                        <div className="flex flex-wrap gap-1">
                          {a.modules.length ? (
                            a.modules.map((m) => (
                              <span
                                key={m}
                                className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                              >
                                {m}
                              </span>
                            ))
                          ) : (
                            <span className="font-mono text-[10px] text-muted-foreground/60">
                              —
                            </span>
                          )}
                        </div>
                      </TableCell>
                    ) : null}
                    {!isHidden("hash") ? (
                      <TableCell
                        className={cn(
                          "font-mono text-[10px] text-muted-foreground",
                          cellPad,
                        )}
                        title={a.contentHash}
                      >
                        {shortHash(a.contentHash)}
                      </TableCell>
                    ) : null}
                    <TableCell className={cn("w-px text-right", cellPad)}>
                      {(() => {
                        // Editor links only exist for the editable resource
                        // kinds; other kinds get an empty cell.
                        const editKind = editableKind(a.kind);
                        if (!editKind) return null;
                        return (
                          // Wrapper swallows row activation so opening the editor
                          // never also triggers the drawer (click + Enter/Space).
                          <span
                            className="inline-flex"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <OpenInEditor
                              kind={editKind}
                              id={a.id}
                              iconOnly
                              variant="ghost"
                              className="size-7 text-muted-foreground hover:text-foreground"
                            />
                          </span>
                        );
                      })()}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* R2: bulk-delete confirmation */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete {selectedRows.length} artifact(s)?</DialogTitle>
            <DialogDescription>
              This permanently removes the selected resources from disk. Each
              deletion runs <span className="font-mono">forge validate</span> +{" "}
              <span className="font-mono">forge registry build</span>. This cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-40 overflow-y-auto rounded border border-border bg-muted/30 p-2">
            {selectedRows.map((a) => (
              <li
                key={a.uid}
                className="truncate font-mono text-[11px] text-foreground"
              >
                {a.uid}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" className="font-mono text-xs" />
              }
            >
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              onClick={runBulkDelete}
              className="font-mono text-xs"
            >
              <Trash2 className="size-3.5" />
              Delete {selectedRows.length}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RegistryDetailDrawer
        artifact={selected}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        cost={selected ? costByUid[selected.uid] : undefined}
        dependents={selected ? dependentsByUid[selected.uid] : undefined}
        findings={selected ? findingsByUid[selected.uid] : undefined}
      />
    </div>
  );
}
