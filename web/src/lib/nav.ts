import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Boxes,
  GitFork,
  Gauge,
  LineChart,
  FlaskConical,
  ShieldCheck,
  Network,
  SlidersHorizontal,
  Settings2,
  Library,
  PackageSearch,
  Layers,
  Scale,
  FileLock,
  FolderGit2,
  Plug,
} from "lucide-react";

/** A single left-nav route. */
export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/**
 * A nav section: a labelled cluster of routes within one plane (e.g. the
 * project plane's "dashboards" group). Sections render as a small uppercase
 * caption above their items.
 */
export type NavSection = {
  /** Short caption shown above the group (lowercased mono label). */
  label: string;
  items: NavItem[];
};

/** The two navigation PLANES the sidebar switches between. */
export type Plane = "global" | "project";

/**
 * A plane: its switcher label/icon + the grouped sections it shows.
 *  - GLOBAL  = machine/library-scoped resources that are NOT tied to a selected
 *    project: the federated source registry, the unified catalog, the core
 *    library's artifact REGISTRY (a global concern), the cross-project Projects
 *    overview/selector, and the machine-level MCP + Settings.
 *  - PROJECT = everything scoped to the SELECTED project's `.claude` root: its
 *    compose flow (browse/adopt, composition, conflicts, tailoring, lockfile),
 *    the full project dashboard set, and the project-level MCP + Settings.
 *
 * MCP + Settings appear in BOTH planes' "config" group on the SAME `/mcp` and
 * `/settings` routes — the dual-scope page rendering (machine vs project
 * instance) is a later slice; the nav simply lists them in both planes.
 */
export type PlaneNav = {
  id: Plane;
  label: string;
  icon: LucideIcon;
  sections: NavSection[];
};

// ──────────────────────────────────────────────────────────────────────────
// GLOBAL plane — machine/library-scoped: sources, catalog, the core registry,
// the cross-project Projects overview/selector, and machine MCP + settings.
// Independent of any project selection.
// ──────────────────────────────────────────────────────────────────────────

const GLOBAL_NAV: PlaneNav = {
  id: "global",
  label: "Global",
  icon: Library,
  sections: [
    {
      label: "library",
      items: [
        { href: "/sources", label: "Sources", icon: Library },
        { href: "/catalog", label: "Catalog", icon: PackageSearch },
        // The core library's artifact registry is a GLOBAL concern — it lives in
        // the library scope, not under any single project (moved here from the
        // old project-plane dashboards group).
        { href: "/registry", label: "Registry", icon: Boxes },
      ],
    },
    {
      label: "overview",
      items: [
        // Projects is the single cross-project surface: the fleet birds-eye
        // (health + drift-vs-library per project) AND the select-to-manage /
        // manual-add selector. Picking one scopes the whole Project plane.
        { href: "/projects", label: "Projects", icon: FolderGit2 },
      ],
    },
    {
      label: "config",
      items: [
        // Machine-level MCP + Settings (the Global instance of each). Same
        // routes as the Project plane; dual-scope rendering is a later slice.
        { href: "/mcp", label: "MCP", icon: Plug },
        { href: "/settings", label: "Settings", icon: Settings2 },
      ],
    },
  ],
};

// ──────────────────────────────────────────────────────────────────────────
// PROJECT plane — everything scoped to the SELECTED project's `.claude` root
// ──────────────────────────────────────────────────────────────────────────

const PROJECT_NAV: PlaneNav = {
  id: "project",
  label: "Project",
  icon: FolderGit2,
  sections: [
    {
      label: "compose",
      items: [
        { href: "/browse", label: "Browse & Adopt", icon: PackageSearch },
        // The project's resources ARE its composition — the old standalone
        // "Resources" nav item is dropped (its /resources route file stays).
        { href: "/composition", label: "Composition", icon: Layers },
        { href: "/conflicts", label: "Conflicts", icon: Scale },
        { href: "/tailoring", label: "Tailoring", icon: SlidersHorizontal },
        { href: "/lockfile", label: "Lockfile", icon: FileLock },
      ],
    },
    {
      label: "dashboards",
      items: [
        { href: "/", label: "Status", icon: Activity },
        { href: "/budget", label: "Budget", icon: Gauge },
        { href: "/eval", label: "Eval", icon: FlaskConical },
        { href: "/validation", label: "Validation", icon: ShieldCheck },
        { href: "/graph", label: "Dependency Graph", icon: GitFork },
        { href: "/telemetry", label: "Telemetry", icon: LineChart },
        { href: "/memory", label: "Memory", icon: Network },
      ],
    },
    {
      label: "config",
      items: [
        // Project-level MCP + Settings (the Project instance of each). Same
        // routes as the Global plane; dual-scope rendering is a later slice.
        { href: "/mcp", label: "MCP", icon: Plug },
        { href: "/settings", label: "Settings", icon: Settings2 },
      ],
    },
  ],
};

/**
 * The plane registry — the sidebar's plane switcher iterates this in order
 * (Global, then Project) and renders the active plane's sections. Every legacy
 * href from the old flat NAV_ITEMS is preserved across the two planes, so every
 * route stays reachable.
 */
export const PLANES: PlaneNav[] = [GLOBAL_NAV, PROJECT_NAV];

/** Look up a plane by id (defaults to the project plane — the app's primary view). */
export function getPlane(id: Plane): PlaneNav {
  return PLANES.find((p) => p.id === id) ?? PROJECT_NAV;
}

/**
 * Flat list of every nav route across all planes, deduped by href. `/mcp` and
 * `/settings` are intentionally listed in BOTH planes' "config" group (the
 * machine vs project instance), so the dedup collapses them to one entry each.
 */
export const ALL_NAV_ITEMS: NavItem[] = (() => {
  const seen = new Set<string>();
  const out: NavItem[] = [];
  for (const item of PLANES.flatMap((p) => p.sections.flatMap((s) => s.items))) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    out.push(item);
  }
  return out;
})();

/**
 * Which plane a given pathname belongs to. Routes listed in the GLOBAL plane
 * resolve to "global"; everything else (incl. the project dashboards and any
 * route not explicitly registered, e.g. `/`) resolves to "project". Used to
 * pick the initially-shown plane from the current URL.
 *
 * `/mcp` and `/settings` live in BOTH planes; they appear in GLOBAL_NAV, so a
 * deep-link to either OPENS on the Global plane (the machine instance) — the
 * user can switch to the Project plane to see that project's instance. The
 * plane switch never changes the URL, so this default is purely cosmetic.
 */
export function planeForPath(pathname: string): Plane {
  for (const item of GLOBAL_NAV.sections.flatMap((s) => s.items)) {
    if (
      item.href !== "/" &&
      (pathname === item.href || pathname.startsWith(item.href + "/"))
    ) {
      return "global";
    }
  }
  return "project";
}
