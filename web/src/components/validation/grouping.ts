/**
 * Pure grouping + path-resolution helpers for the Validation inbox.
 *
 * No React, no I/O — just data transforms over the C2 finding list so the
 * presentational view (validation-view.tsx) and the orchestrator
 * (validation-workspace.tsx) can share one ordering/grouping contract and one
 * "which managed resource does this path address?" resolver.
 *
 * Ordering invariant (ADR-0007 triage): ERROR before WARN before INFO,
 * everywhere — both WITHIN a group (the rows of one validator/file) and OVER
 * groups (when grouping by severity the group order is itself errors-first).
 */
import type { Finding, FindingLevel, ResourceKind } from "@/lib/types";

/** The three axes a finding list can be grouped along in the inbox. */
export type GroupBy = "validator" | "file" | "severity";

/** Severity rank — lower sorts first (errors-first triage order). */
const LEVEL_RANK: Record<FindingLevel, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
};

/** Ordered severity list, errors-first. Re-exported for callers that iterate. */
export const LEVEL_ORDER: FindingLevel[] = ["ERROR", "WARN", "INFO"];

/** One rendered group: a stable key, a human label, and its ordered findings. */
export interface FindingGroup {
  /** Stable, unique key for this group (validator filename / path / level). */
  key: string;
  /** Display label (same as key today; kept distinct for future formatting). */
  label: string;
  /**
   * The grouping axis the key belongs to — lets the view pick an icon/affordance
   * (a file path links to its editor; a severity renders a level badge; a
   * validator renders a source chip).
   */
  kind: GroupBy;
  /** The findings in this group, already sorted errors-first. */
  items: Finding[];
  /** The most-severe level present in the group — drives group-level styling. */
  topLevel: FindingLevel;
}

/** Stable errors-first comparator for findings within a single group. */
function byLevel(a: Finding, b: Finding): number {
  return LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
}

/** The grouping key for one finding under a given axis. */
function keyFor(finding: Finding, groupBy: GroupBy): string {
  switch (groupBy) {
    case "validator":
      return finding.source;
    case "file":
      return finding.path;
    case "severity":
      return finding.level;
  }
}

/**
 * Group a flat finding list into ordered {@link FindingGroup}s.
 *
 * - Findings keep their input order within equal severity (stable sort), but are
 *   ordered errors-first inside each group.
 * - Groups are ordered errors-first by their most-severe member (`topLevel`),
 *   ties broken alphabetically by key for determinism. For `severity` grouping
 *   this collapses to the canonical ERROR → WARN → INFO order.
 *
 * Pure: never mutates the input array.
 */
export function groupFindings(
  findings: Finding[],
  groupBy: GroupBy,
): FindingGroup[] {
  const buckets = new Map<string, Finding[]>();
  // Preserve first-seen order of keys; severity ordering is applied at the end.
  for (const f of findings) {
    const key = keyFor(f, groupBy);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(f);
    else buckets.set(key, [f]);
  }

  const groups: FindingGroup[] = [];
  for (const [key, items] of buckets) {
    const sorted = [...items].sort(byLevel);
    // `sorted[0]` is the most-severe member after the errors-first sort.
    groups.push({
      key,
      label: key,
      kind: groupBy,
      items: sorted,
      topLevel: sorted[0]?.level ?? "INFO",
    });
  }

  groups.sort((a, b) => {
    const rank = LEVEL_RANK[a.topLevel] - LEVEL_RANK[b.topLevel];
    if (rank !== 0) return rank;
    return a.key.localeCompare(b.key);
  });

  return groups;
}

// ── path → managed-resource resolution ──────────────────────────────────────

/**
 * Map a managed-resource top-level directory to its {@link ResourceKind}. Only
 * the markdown-file kinds are linkable: `hook` lives inside hooks/hooks.json
 * (path is ambiguous, never a clean per-resource file) and is intentionally
 * omitted so those findings fall back to a plain vscode:// link.
 */
const DIR_TO_KIND: Record<string, Exclude<ResourceKind, "hook">> = {
  agents: "agent",
  skills: "skill",
  commands: "command",
  rules: "rule",
  bundles: "bundle",
  memory: "memory",
};

/** The (kind, kind-local id) a finding path addresses, when it is managed. */
export interface EditorTarget {
  kind: ResourceKind;
  id: string;
}

/**
 * Invert the on-disk layout (mirror of resources.ts `relPathFor`) to recover the
 * (kind, kind-local id) a finding's repo-relative path addresses — but only when
 * we are CONFIDENT it is a managed resource file. Returns null otherwise
 * (unknown dir, hook JSON, ambiguous/absolute path, wrong shape) so the caller
 * can leave such findings as a plain vscode:// link.
 *
 * Layouts inverted:
 *   agents/<id>.md · commands/<id>.md · bundles/<id>.md · memory/<id>.md
 *   rules/**​/<id>.md (id may contain "/")
 *   skills/<id>/SKILL.md
 */
export function pathToEditorTarget(rawPath: string): EditorTarget | null {
  // Findings carry repo-relative POSIX paths; bail on anything that isn't a
  // clean relative path (absolute, drive-letter, or ".." traversal).
  if (!rawPath || rawPath.startsWith("/") || rawPath.includes("\\")) return null;
  const segments = rawPath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;

  const [dir, ...rest] = segments;
  const kind = DIR_TO_KIND[dir];
  if (!kind || rest.length === 0) return null;

  if (kind === "skill") {
    // skills/<id>/SKILL.md → <id> (id is the joined subdir path)
    if (rest.length < 2 || rest[rest.length - 1] !== "SKILL.md") return null;
    const id = rest.slice(0, -1).join("/");
    return id ? { kind, id } : null;
  }

  // <dir>/<...>/<name>.md → <...>/<name> (rules nest; others are flat)
  const last = rest[rest.length - 1];
  if (!last.endsWith(".md")) return null;
  const id = rest.join("/").replace(/\.md$/, "");
  return id ? { kind, id } : null;
}
