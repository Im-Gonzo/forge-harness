/**
 * Registry route — shared presentational helpers and the detail-envelope shape.
 *
 * Route-scoped (owned by /registry). Mirrors the live `forge registry show` data
 * payload, which FLATTENS the registry record fields into `data` and appends a
 * `changelog[]` array (manager/registry.mjs#doShow). This is NOT in src/lib/types.ts
 * because the show-detail shape is specific to this route's drawer.
 */
import type { Finding, RegistryArtifact } from "@/lib/types";

/** One changelog line (registry.log.jsonl, filtered to the uid). */
export interface ChangelogEntry {
  ts: string;
  uid: string;
  from: { hash: string; rev: number; ver: string } | null;
  to: { hash: string; rev: number; ver: string } | null;
  reason: string;
  evalStatus?: string;
}

/**
 * `forge registry show <uid>` data payload: the full record flattened into the
 * object, plus the filtered changelog. (No nested `record` key in practice.)
 */
export type RegistryShowData = RegistryArtifact & {
  changelog?: ChangelogEntry[];
};

/** Short, copy-friendly content hash for the dense table column. */
export function shortHash(hash: string, len = 8): string {
  return typeof hash === "string" ? hash.slice(0, len) : "";
}

export type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "ghost";

/** Stable, low-noise color per artifact kind (outline keeps the table calm). */
export function kindBadgeVariant(): BadgeVariant {
  return "outline";
}

/** Distinct accent classes per kind — applied on top of the outline badge. */
export const KIND_ACCENT: Record<string, string> = {
  agent: "text-sky-500",
  skill: "text-violet-500",
  command: "text-amber-500",
  rule: "text-emerald-500",
  hook: "text-rose-500",
  bundle: "text-fuchsia-500",
  workflow: "text-pink-500",
  mcp: "text-cyan-500",
  validator: "text-teal-500",
  "meta-test": "text-orange-500",
  engine: "text-indigo-500",
};

export function statusBadgeVariant(status: string): BadgeVariant {
  switch (status) {
    case "active":
      return "default";
    case "experimental":
      return "secondary";
    case "deprecated":
      return "destructive";
    case "planned":
      return "outline";
    default:
      return "outline";
  }
}

export function criticalityBadgeVariant(criticality: string): BadgeVariant {
  switch (criticality) {
    case "safety":
      return "destructive";
    case "compliance":
      return "secondary";
    case "normal":
    default:
      return "outline";
  }
}

/** Distinct sentinel value for the "all" option in single-select filters. */
export const ALL = "__all__";

// ──────────────────────────────────────────────────────────────────────────
// Registry enrichment — the data-join the server page computes and threads
// through the table into the drawer. Each map is keyed by artifact `uid`.
// These are the SHARED contract the cost-column and drawer-detail feature
// agents consume; they are intentionally minimal and serializable.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Per-artifact context-cost slice joined from `forge analyze`. `null` fields
 * mean the analyzer had no entry for the uid (registry/analyze can drift).
 */
export interface ArtifactCost {
  /** Always-on estimated token cost; null when the artifact isn't always-on or absent from analyze. */
  alwaysOn: number | null;
  /** How the artifact loads into context (always-on/conditional/on-demand); null when absent. */
  residency: string | null;
}

/** uid → joined cost slice (absent uids simply have no entry). */
export type CostByUid = Record<string, ArtifactCost>;

/** uid → uids that declare it in their `dependsOn` (reverse dependency index). */
export type DependentsByUid = Record<string, string[]>;

/** uid → `forge validate` findings whose path matches the artifact's file. */
export type FindingsByUid = Record<string, Finding[]>;

// ──────────────────────────────────────────────────────────────────────────
// Table-feature helpers (pure) — CREATE picker kinds, cost formatting, and the
// saved/shareable-view URL codec. Kept here (not in the component) so they stay
// side-effect-free and unit-friendly.
// ──────────────────────────────────────────────────────────────────────────

/**
 * The resource kinds a user can CREATE from the registry toolbar. Mirrors the
 * /resources/[kind]/new route's WRITABLE_KINDS (NOTE: `hook` is omitted there —
 * hooks have no `new` page — so it is omitted here too).
 */
export const CREATABLE_KINDS = [
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "memory",
] as const;
export type CreatableKind = (typeof CREATABLE_KINDS)[number];

/**
 * Resource kinds the per-resource DELETE endpoint accepts. A registry artifact
 * is bulk-selectable only when its kind is in this set — validator/meta-test/
 * engine have no on-disk resource and are excluded from selection.
 */
export const DELETABLE_KINDS: ReadonlySet<string> = new Set([
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "memory",
  "hook",
]);

/** A row is selectable for bulk ops only when its kind has a DELETE endpoint. */
export function isSelectableKind(kind: string): boolean {
  return DELETABLE_KINDS.has(kind);
}

/** Compact integer formatter for the always-on token-cost column. */
const COST_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

/** Render an always-on token cost; em-dash when null/absent. */
export function formatCost(value: number | null | undefined): string {
  return value == null ? "—" : COST_FORMAT.format(value);
}

/** Comfortable (default) vs. compact row height for the density toggle. */
export type Density = "comfortable" | "compact";

/**
 * The view state we persist to the URL so a sort/filter/columns/density setup is
 * shareable and survives reload. Kept flat and string-serializable.
 */
export interface TableViewState {
  query: string;
  kind: string;
  status: string;
  crit: string;
  sortKey: string;
  sortDir: "asc" | "desc";
  density: Density;
  /** Hidden column keys (visible = all-known minus these). */
  hidden: string[];
}

/**
 * Encode the view state into URLSearchParams, OMITTING defaults so a pristine
 * view leaves the URL clean. `defaults` is the baseline to diff against.
 */
export function encodeViewState(
  view: TableViewState,
  defaults: TableViewState,
): URLSearchParams {
  const p = new URLSearchParams();
  if (view.query.trim()) p.set("q", view.query.trim());
  if (view.kind !== defaults.kind) p.set("kind", view.kind);
  if (view.status !== defaults.status) p.set("status", view.status);
  if (view.crit !== defaults.crit) p.set("crit", view.crit);
  if (view.sortKey !== defaults.sortKey) p.set("sort", view.sortKey);
  if (view.sortDir !== defaults.sortDir) p.set("dir", view.sortDir);
  if (view.density !== defaults.density) p.set("density", view.density);
  if (view.hidden.length) p.set("hide", view.hidden.join(","));
  return p;
}

/** Read a single view field out of a URLSearchParams (falls back to default). */
export function decodeViewState(
  params: URLSearchParams,
  defaults: TableViewState,
): TableViewState {
  const dir = params.get("dir");
  const density = params.get("density");
  const hide = params.get("hide");
  return {
    query: params.get("q") ?? defaults.query,
    kind: params.get("kind") ?? defaults.kind,
    status: params.get("status") ?? defaults.status,
    crit: params.get("crit") ?? defaults.crit,
    sortKey: params.get("sort") ?? defaults.sortKey,
    sortDir: dir === "asc" || dir === "desc" ? dir : defaults.sortDir,
    density:
      density === "comfortable" || density === "compact"
        ? density
        : defaults.density,
    hidden: hide ? hide.split(",").filter(Boolean) : defaults.hidden,
  };
}
