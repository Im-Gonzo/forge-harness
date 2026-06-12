"use client";

/**
 * ProjectsView — the GLOBAL-PLANE cross-project overview AND selector.
 *
 * V2-A merges the old /fleet birds-eye into here: this is now the SINGLE
 * cross-project surface — every detected project shown with its health + drift
 * from the library, plus select-to-manage and manual-add.
 *
 * Read side: a server-loaded `getProjects()` snapshot (lib/harness is
 * server-only, so it is never imported here) — the scanned ∪ added project
 * harnesses plus which one is currently selected (selectedRoot/selectedId null
 * when the library is the active scope, i.e. no project picked) — JOINED with a
 * `health` array (the birds-eye `scanFleet` roll-up, reduced to a root-keyed
 * metrics subset). The two are matched by canonical `.claude` root.
 *
 * Action side: every selection rides POST /api/projects (client → API route →
 * cookie), then router.refresh() to re-render every server component against the
 * new cookie-scoped root. The URL never changes — picking a project is a SCOPE
 * change, not a navigation:
 *
 *   - Select : { action:"select", root } — scope to a detected project (or
 *              "library" to clear back to the library / no-project state).
 *   - Add    : { action:"add", root }    — manually add a project by path
 *              (the project dir OR its `.claude` dir). On success the added
 *              project becomes the selection; the next scan rediscovers it.
 *
 * Fail-soft: a bad path is a 400 with `{ ok:false, error }` surfaced as a toast;
 * the cookie is never set to an unguarded root.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Boxes,
  Check,
  CircleCheck,
  CircleHelp,
  CircleX,
  FolderGit2,
  FolderPlus,
  Gauge,
  Loader2,
  Package,
  Plus,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusPill, TrustTag } from "@/components/forge";
import { cn } from "@/lib/utils";
// Shared birds-eye health primitives — the SAME cells the legacy /fleet grid
// renders (single source of truth for severity bands + badges + breakdown).
import {
  KindBreakdown,
  ValidateBadge,
  metric,
  severityOf,
  type ProjectHealthMetrics,
} from "@/components/fleet/project-health-cells";

/** Client-safe mirror of the Harness shape (lib/harness is server-only). */
type ProjectLite = {
  id: string;
  label: string;
  root: string;
  projectPath?: string;
  /** "scanned" (under the scan root) or "added" (explicit out-of-scan add). */
  source?: "scanned" | "added";
};

/**
 * Client-safe, root-keyed subset of a birds-eye `ProjectHealth` row — just the
 * metrics a project row renders (the harness identity already lives in
 * `ProjectsData.projects`). The server page reduces `scanFleet`'s heavy
 * server-only rows to this before handing them across the client boundary.
 */
export type ProjectHealthLite = ProjectHealthMetrics & {
  /** The project's `.claude` root — the join key against ProjectsData.projects. */
  root: string;
};

/** Client-safe mirror of getProjects()'s ProjectsData. */
export type ProjectsData = {
  projects: ProjectLite[];
  selectedRoot: string | null;
  selectedId: string | null;
  scanRoot: string;
};

/** The "library" sentinel — clears the project selection back to no-project. */
const LIBRARY_VALUE = "library";

/** Shape of the /api/projects POST result. */
type PostResult =
  | { ok: true; harness: ProjectLite }
  | { ok: false; error: string };

export function ProjectsView({
  data,
  health,
}: {
  data: ProjectsData;
  /** Birds-eye health rows (root-keyed), joined to projects by `.claude` root. */
  health: ProjectHealthLite[];
}) {
  const router = useRouter();

  const { projects, selectedRoot, scanRoot } = data;
  const hasSelection = selectedRoot !== null;

  // Join the birds-eye health to the project list by canonical `.claude` root.
  // A project with no matching health row (e.g. an out-of-scan added project the
  // fleet scan didn't reach) simply renders without health metrics — fail-soft.
  const healthByRoot = React.useMemo(() => {
    const map = new Map<string, ProjectHealthLite>();
    for (const h of health) map.set(h.root, h);
    return map;
  }, [health]);

  // Fleet-style health tally across the projects that DO have a health row.
  const tally = React.useMemo(() => {
    let fail = 0;
    let unknown = 0;
    let ok = 0;
    for (const h of health) {
      const s = severityOf(h);
      if (s === "fail") fail += 1;
      else if (s === "unknown") unknown += 1;
      else ok += 1;
    }
    return { fail, unknown, ok };
  }, [health]);

  // Which project root is mid-select (so only that row spins), and the add path
  // (so the add button spins independently).
  const [selecting, setSelecting] = React.useState<string | null>(null);
  const [addPath, setAddPath] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const busy = selecting !== null || adding;

  // ── POST helper — both actions ride /api/projects (sets the cookie) ────────
  const post = React.useCallback(
    async (body: { action: "select" | "add"; root: string }) => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as PostResult;
      if (!res.ok || !json.ok) {
        toast.error(
          !json.ok ? json.error : "Project action failed.",
        );
        return null;
      }
      return json.harness;
    },
    [],
  );

  // ── Select — scope to a detected project, then re-render every server view ──
  const onSelect = React.useCallback(
    async (root: string, label: string) => {
      if (root === selectedRoot) return; // already the active scope
      setSelecting(root);
      try {
        const harness = await post({ action: "select", root });
        if (!harness) return;
        toast.success(
          root === LIBRARY_VALUE
            ? "Cleared project selection — back to the library."
            : `Scoped to "${label}".`,
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSelecting(null);
      }
    },
    [post, router, selectedRoot],
  );

  // ── Add — manually add a project by path; on success it becomes the scope ──
  const onAdd = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = addPath.trim();
      if (trimmed === "" || adding) return;
      setAdding(true);
      try {
        const harness = await post({ action: "add", root: trimmed });
        if (!harness) return;
        toast.success(`Added + scoped to "${harness.label}".`);
        setAddPath("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setAdding(false);
      }
    },
    [addPath, adding, post, router],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* ── Header summary — counts, scope, + birds-eye health tally ───────── */}
      <div className="flex flex-wrap items-center gap-2">
        <TrustTag
          label={`${projects.length} project${projects.length === 1 ? "" : "s"} detected`}
          icon={<FolderGit2 />}
        />
        <StatusPill tone={hasSelection ? "ok" : "neutral"}>
          {hasSelection ? "project scoped" : "library scope"}
        </StatusPill>

        {/* Cross-project health tally (the merged fleet birds-eye signal). */}
        {tally.ok > 0 ? (
          <Badge
            variant="outline"
            className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] text-emerald-500"
          >
            <CircleCheck className="size-3" />
            {tally.ok} pass
          </Badge>
        ) : null}
        {tally.fail > 0 ? (
          <Badge
            variant="outline"
            className="border-rose-500/30 bg-rose-500/10 font-mono text-[10px] text-rose-500"
          >
            <CircleX className="size-3" />
            {tally.fail} fail
          </Badge>
        ) : null}
        {tally.unknown > 0 ? (
          <Badge
            variant="outline"
            className="font-mono text-[10px] text-muted-foreground/70"
          >
            <CircleHelp className="size-3" />
            {tally.unknown} degraded
          </Badge>
        ) : null}

        <span
          className="ml-auto truncate font-mono text-[length:var(--text-2xs)] text-muted-foreground/60"
          title={`scan root: ${scanRoot}`}
        >
          {scanRoot}
        </span>
      </div>

      {/* ── Add-project form ───────────────────────────────────────────────── */}
      <form
        onSubmit={onAdd}
        className="flex flex-col overflow-hidden rounded-xl bg-card ring-1 ring-border"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <FolderPlus className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[length:var(--text-2xs)] font-semibold uppercase tracking-wide text-foreground">
              Add project
            </p>
            <p className="font-mono text-[length:var(--text-2xs)] text-muted-foreground/70">
              point at a project dir or its .claude dir · may live OUTSIDE the
              scan root · it is remembered + becomes the active scope
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-mono text-[length:var(--text-2xs)] uppercase tracking-wide text-muted-foreground">
              path
            </span>
            <Input
              value={addPath}
              onChange={(e) => setAddPath(e.target.value)}
              placeholder="/path/to/project  or  /path/to/project/.claude"
              disabled={busy}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <Button type="submit" size="sm" disabled={addPath.trim() === "" || busy}>
            {adding ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Add
          </Button>
        </div>
      </form>

      {/* ── Library / clear-selection row ──────────────────────────────────── */}
      <ProjectRow
        icon={Boxes}
        label="Library"
        sub="the top-level harness — no project scope"
        selected={!hasSelection}
        busy={selecting === LIBRARY_VALUE}
        disabled={busy}
        onSelect={() => onSelect(LIBRARY_VALUE, "Library")}
      />

      {/* ── Detected projects / empty state ────────────────────────────────── */}
      {projects.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-2">
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              icon={FolderGit2}
              label={p.label}
              sub={p.projectPath ?? p.root}
              added={p.source === "added"}
              selected={p.root === selectedRoot}
              busy={selecting === p.root}
              disabled={busy}
              health={healthByRoot.get(p.root)}
              onSelect={() => onSelect(p.root, p.label)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ProjectRow — one selectable scope (the library, or a detected project). The
// SELECTED row reads "active" with an ok-toned pill; the rest expose a Select
// action. A PROJECT row also carries the merged fleet birds-eye: a validate
// badge on the identity line + a metrics strip (artifacts, always-on token
// floor, per-kind breakdown). The library row has no `health` and renders the
// identity line only. Mirrors the prototype `.src-row` hairline card.
// ──────────────────────────────────────────────────────────────────────────

function ProjectRow({
  icon: Icon,
  label,
  sub,
  added = false,
  selected,
  busy,
  disabled,
  health,
  onSelect,
}: {
  icon: typeof FolderGit2;
  label: string;
  sub: string;
  /** True for an explicitly-added (persisted, possibly out-of-scan) project. */
  added?: boolean;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  /** Birds-eye health for this project (absent for the library + unmatched rows). */
  health?: ProjectHealthLite;
  onSelect: () => void;
}) {
  // A FAILing project (validate errors) reads in rose — the drift-vs-library
  // signal that should stand out, mirroring the /fleet card accent.
  const severity = health ? severityOf(health) : null;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 transition-colors",
        selected
          ? "ring-primary/50"
          : severity === "fail"
            ? "ring-rose-500/30"
            : "ring-border",
      )}
    >
      {/* Identity line: icon · label (+ added tag) · validate badge · action */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md border",
            selected
              ? "border-primary/40 text-primary"
              : "border-border text-muted-foreground/70",
          )}
        >
          <Icon className="size-4" />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 truncate font-mono text-sm font-semibold text-foreground">
            <span className="truncate">{label}</span>
            {added ? (
              <span
                className="shrink-0 rounded-pill border border-border px-1.5 py-px font-mono text-[length:var(--text-2xs)] font-normal uppercase tracking-wide text-muted-foreground/70"
                title="explicitly added (persisted) — may be outside the scan root"
              >
                added
              </span>
            ) : null}
          </span>
          <span
            className="truncate font-mono text-xs text-muted-foreground"
            title={sub}
          >
            {sub}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {health ? <ValidateBadge p={health} /> : null}
          {selected ? (
            <StatusPill tone="ok" icon={<Check />}>
              active scope
            </StatusPill>
          ) : (
            <Button
              variant="outline"
              size="xs"
              disabled={disabled}
              onClick={onSelect}
              title={`Scope every dashboard to "${label}"`}
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              Select
            </Button>
          )}
        </div>
      </div>

      {/* Birds-eye metrics strip — registry size, always-on token floor, and the
          per-kind breakdown (the merged /fleet signal). Project rows only. */}
      {health ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <span className="flex items-center gap-1.5 rounded-lg bg-muted/30 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            <Package className="size-3" />
            artifacts
            <span className="tabular-nums text-sm font-semibold normal-case tracking-normal text-foreground">
              {metric(health.artifactCount)}
            </span>
          </span>
          <span className="flex items-center gap-1.5 rounded-lg bg-muted/30 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            <Gauge className="size-3" />
            always-on
            <span className="tabular-nums text-sm font-semibold normal-case tracking-normal text-foreground">
              {metric(health.alwaysOnTokens)}
              {health.alwaysOnTokens != null ? (
                <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                  tok
                </span>
              ) : null}
            </span>
          </span>
          <div className="min-w-0">
            <KindBreakdown byKind={health.byKind} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Empty state — no project harnesses found under the scan root. */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-md border border-border text-muted-foreground/60">
        <FolderGit2 className="size-5" />
      </span>
      <p className="font-mono text-sm text-foreground">No projects detected</p>
      <p className="max-w-sm font-mono text-[length:var(--text-2xs)] leading-snug text-muted-foreground">
        No <span className="text-foreground">.claude</span> harness with real
        content was found under the scan root. Add one above by path, or point{" "}
        <span className="text-foreground">FORGE_WEB_SCAN_ROOT</span> at your
        projects directory.
      </p>
    </div>
  );
}
