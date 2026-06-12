"use client";

/**
 * Sidebar — the two-PLANE navigation rail.
 *
 * The nav is split into a GLOBAL plane (Sources, Catalog, the core Registry, the
 * cross-project Projects overview/selector, and machine MCP + Settings — all
 * library/machine-scoped, independent of any project selection) and a PROJECT
 * plane (the selected project's compose flow — browse/adopt, composition,
 * conflicts, tailoring, lockfile — its full dashboard set, and that project's
 * MCP + Settings). MCP + Settings appear in BOTH planes (same routes, different
 * scope). A compact segmented switcher toggles the shown plane; the URL never
 * changes when you switch planes — it just reveals the other plane's routes.
 *
 * The active plane defaults to whichever plane the current route belongs to
 * (planeForPath), so deep-linking to /sources or /projects opens on the Global
 * plane and the project dashboards open on the Project plane. Switching is local
 * UI state.
 *
 * The Project plane shows the SELECTED PROJECT as a compact indicator (it
 * REPLACES the old harness-switcher dropdown — the Global-plane /projects page
 * is now the selector). The selection lives in the `forge-harness` cookie; we
 * read it client-side via GET /api/projects (the same contract the projects page
 * uses), so the server layout needs no change. Fail-soft: a fetch error just
 * shows the "no project selected" state.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Hexagon, FolderGit2 } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  PLANES,
  getPlane,
  planeForPath,
  type Plane,
} from "@/lib/nav";

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

/** Client-safe shape of the GET /api/projects selection payload. */
type ProjectsResponse = {
  selectedRoot: string | null;
  selectedId: string | null;
  projects: Array<{ id: string; label: string; root: string }>;
};

export function Sidebar() {
  const pathname = usePathname();

  // The shown plane: the route's natural plane is the baseline; an explicit
  // switcher pick OVERRIDES it until the route changes to one belonging to the
  // OTHER plane. We track (override, routeAtPick) and recompute during render —
  // the React-recommended "adjust state from props during render" pattern — so
  // an in-plane navigation never yanks the switcher back, and crossing planes
  // re-syncs without a setState-in-effect cascade.
  const routePlane = planeForPath(pathname);
  const [override, setOverride] = useState<{ plane: Plane; at: Plane } | null>(
    null,
  );
  // Drop a stale override the moment the route's own plane no longer matches
  // the plane the route had when the user picked (i.e. they navigated across).
  const activeOverride = override && override.at === routePlane ? override : null;
  if (override && override.at !== routePlane) {
    setOverride(null);
  }
  const plane: Plane = activeOverride?.plane ?? routePlane;
  const pickPlane = (next: Plane) =>
    setOverride({ plane: next, at: routePlane });

  // The currently-selected project's label (Project-plane indicator). Read from
  // GET /api/projects on mount + whenever the route changes (a selection made on
  // /projects calls router.refresh(), which re-mounts server content but not this
  // client island, so we also key the refetch on pathname to stay in sync).
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<ProjectsResponse>) : null))
      .then((data) => {
        if (cancelled || !data) return;
        const match = data.projects.find((p) => p.root === data.selectedRoot);
        setSelectedLabel(match?.label ?? null);
      })
      .catch(() => {
        /* fail-soft: leave the indicator in its "no project" state */
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const activePlane = getPlane(plane);

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Brand — 48px mono wordmark with the Lucide hexagon mark */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border px-4">
        <Hexagon className="size-[1.0625rem] text-primary" strokeWidth={2} />
        <span className="font-mono text-sm font-semibold tracking-[var(--tracking-tight)]">
          forge<span className="font-normal text-muted-foreground">-web</span>
        </span>
      </div>

      {/* Plane switcher — a segmented Global | Project control */}
      <div className="border-b border-sidebar-border p-2">
        <div
          role="tablist"
          aria-label="navigation plane"
          className="grid grid-cols-2 gap-1 rounded-lg bg-sidebar-accent/40 p-1"
        >
          {PLANES.map((p) => {
            const Icon = p.icon;
            const selected = plane === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => pickPlane(p.id)}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-md px-2 py-[5px] font-mono text-xs",
                  "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                  selected
                    ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                    : "text-muted-foreground hover:text-sidebar-foreground",
                )}
              >
                <Icon className="size-3.5 shrink-0 opacity-85" />
                <span className="truncate">{p.label}</span>
              </button>
            );
          })}
        </div>

        {/* Project-plane indicator: the selected project (replaces the old
            switcher dropdown — /projects is the selector). */}
        {plane === "project" ? (
          <Link
            href="/projects"
            className={cn(
              "mt-2 flex items-center gap-1.5 rounded-md border border-sidebar-border px-2 py-[7px]",
              "font-mono text-xs transition-colors duration-[var(--duration-fast)]",
              "hover:bg-sidebar-accent/50",
            )}
            title={
              selectedLabel
                ? `selected project: ${selectedLabel} · change on the Projects page`
                : "no project selected · pick one on the Projects page"
            }
          >
            <FolderGit2
              className={cn(
                "size-3.5 shrink-0",
                selectedLabel ? "text-primary" : "text-muted-foreground/60",
              )}
            />
            {selectedLabel ? (
              <span className="truncate text-foreground">{selectedLabel}</span>
            ) : (
              <span className="truncate text-muted-foreground/70">
                no project selected
              </span>
            )}
          </Link>
        ) : null}
      </div>

      {/* Nav — the active plane's grouped sections */}
      <nav className="flex flex-1 flex-col gap-px overflow-y-auto px-3 pb-4 pt-2">
        {activePlane.sections.map((section) => (
          <div key={section.label} className="flex flex-col">
            <div className="px-2 pb-2 pt-2 font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-neutral-600">
              {section.label}
            </div>
            <ul className="flex flex-col gap-px">
              {section.items.map((item) => {
                const active = isActive(pathname, item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-[9px] rounded-md px-2 py-[7px] font-mono text-sm",
                        "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                      )}
                    >
                      <Icon className="size-[15px] shrink-0 opacity-85" />
                      <span className="min-w-0 flex-1 truncate">
                        {item.label}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Foot — a quiet scope indicator, like the prototype rail-foot */}
      <div className="shrink-0 border-t border-sidebar-border px-4 py-3 font-mono text-[length:var(--text-2xs)] leading-[var(--leading-snug)] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-state-ok"
          />
          harness resource manager
        </span>
      </div>
    </aside>
  );
}
