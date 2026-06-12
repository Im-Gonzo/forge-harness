/**
 * harness — the ACTIVE-ROOT foundation: which resource root every bridge call
 * scopes to (the library, or a scanned project's `.claude/`).
 *
 * THE MODEL: a "harness" is a resource root.
 *  - LIBRARY  = FORGE_ROOT (top-level agents/skills/rules/… + manifests/).
 *  - PROJECT  = a `<project>/.claude/` directory that holds REAL harness content.
 *    Running forge with cwd = `<project>/.claude` catalogs THAT project's
 *    resources, so scoping the whole app to a project is just making every bridge
 *    call use `<project>/.claude` as its base — which we resolve HERE, from a
 *    cookie, INSIDE the bridge, so pages need NO changes.
 *
 * The active root is read from the `forge-harness` cookie:
 *   - unset / "library"  → FORGE_ROOT (the safe default; the app behaves EXACTLY
 *     as before — no regression with no cookie set).
 *   - a path             → VALIDATED (must be FORGE_ROOT, or an existing dir under
 *     SCAN_ROOT ending in `/.claude`); any invalid value falls back to FORGE_ROOT.
 *
 * This is DISTINCT from the fleet's `listHarnesses` (forge-bridge/fleet.ts): that
 * lists the library + projects REGISTERED in the opt-in fleet INDEX. THIS module
 * SCANS the filesystem for `.claude` dirs with real content — independent of
 * whether the fleet is enabled or a project was ever `add`ed.
 *
 * NOTE: server-only module — it uses node:fs and next/headers `cookies()` (a
 * request-time API). Import from server components and route handlers only,
 * never from a "use client" boundary.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { cookies } from "next/headers";

import { FORGE_ROOT } from "@/lib/config";

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

/** The cookie that stores the active harness root path (or "library"). */
export const HARNESS_COOKIE = "forge-harness";

/** Sentinel cookie value meaning "the library" (resolves to FORGE_ROOT). */
export const LIBRARY_VALUE = "library";

/**
 * Root the scanner crawls for project `.claude/` dirs (the L0 multi-project
 * birds-eye). Defaults to the directory that CONTAINS this monorepo — i.e. your
 * workspace folder — resolved as `../..` from where Next runs (`<repo>/web`).
 * Point FORGE_WEB_SCAN_ROOT at your projects directory for a different layout.
 */
export const SCAN_ROOT =
  process.env.FORGE_WEB_SCAN_ROOT || path.resolve(process.cwd(), "..", "..");

/** The `.claude` directory name — what a project harness root is called. */
const CLAUDE_DIR = ".claude";

/** Max directory depth the scan descends (from SCAN_ROOT). */
const MAX_DEPTH = 6;

/**
 * Dir basenames pruned wherever they appear (mirrors walk.mjs SKIP_DIRS, plus
 * test/fixture dirs). Pruning a name here means the scan never descends INTO it,
 * so any `.claude` dirs living under `tests/`, `fixtures/`, `node_modules/`, or
 * `.next/` (e.g. the `forge/tests/manager/fixtures/fleet-project` test harnesses,
 * F3) are never surfaced as real projects. This is a simple, documented ignore
 * list; SCAN_ROOT itself is unchanged.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "tests",
  "fixtures",
]);

/**
 * The subdirs that mark a `.claude/` as REAL harness content. A `.claude/` that
 * contains ONLY settings*.json (no resource dirs) is NOT a harness root.
 */
const HARNESS_CONTENT_DIRS = [
  "agents",
  "skills",
  "rules",
  "commands",
  "hooks",
  "bundles",
  "workflows",
  "mcp",
];

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** A resource root the app can scope to: the library, or a scanned project. */
export interface Harness {
  kind: "library" | "project";
  /** Stable id ("library", or a short hash of the project path). */
  id: string;
  /** Human label ("Library", or the project dir basename). */
  label: string;
  /** Absolute path used as the bridge base (FORGE_ROOT, or `<project>/.claude`). */
  root: string;
  /** The project dir (the parent of `.claude`); projects only. */
  projectPath?: string;
  /**
   * How a PROJECT harness was discovered (projects only): "scanned" (found under
   * SCAN_ROOT by the crawler) or "added" (explicitly added by the user and held
   * in the persistent allowlist). Lets the UI mark out-of-scan added projects.
   */
  source?: "scanned" | "added";
}

/** The LIBRARY harness — always first in the switcher; the safe default root. */
export const LIBRARY: Harness = {
  kind: "library",
  id: LIBRARY_VALUE,
  label: "Library",
  root: FORGE_ROOT,
};

// ──────────────────────────────────────────────────────────────────────────
// Persistent added-projects store (F10) — the explicit user allowlist
// ──────────────────────────────────────────────────────────────────────────
//
// Manually-added projects may live OUTSIDE SCAN_ROOT (e.g. a sibling repo), so
// the scan will never re-list them and they would not survive a refresh. We
// persist their canonical `.claude` roots in a machine-level JSON under
// FORGE_HOME (`$FORGE_HOME` or `~/.forge`, mirroring the CLI's `forgeHome()` in
// cli/manager/lib/store.mjs). This file IS the explicit user allowlist that
// EXTENDS SCAN_ROOT for validation — it never holds an unvalidated path (every
// entry passed the real-`.claude` + canonical checks before being written).
//
// Reads/writes are fail-soft (a missing/corrupt store ⇒ empty) and atomic
// (temp-write + rename), so a crash mid-write leaves the prior file intact.

/** Schema tag stamped on the persisted store (forge.web.<name>.v1 convention). */
const ADDED_STORE_SCHEMA = "forge.web.added-projects.v1";

/**
 * The GLOBAL config root (mirrors cli/manager/lib/store.mjs#forgeHome): the
 * `$FORGE_HOME` env override resolved to an absolute path, else `<home>/.forge`.
 * Sandbox-friendly home resolution ($HOME/$USERPROFILE, falling back to
 * os.homedir()), exactly as the CLI resolves it.
 */
function forgeHome(): string {
  const env = process.env.FORGE_HOME;
  if (env) return path.resolve(env);
  const home =
    process.env.HOME || process.env.USERPROFILE || os.homedir() || "";
  return path.join(home, ".forge");
}

/** Absolute path to the web-owned persistent added-projects store. */
export function addedStorePath(): string {
  return path.join(forgeHome(), "web-projects.json");
}

/** On-disk shape of the added-projects store. */
interface AddedStore {
  schema: string;
  version: 1;
  /** Canonical absolute `.claude` roots the user explicitly added. */
  projects: string[];
}

/**
 * Read the persisted added-project roots. Fail-soft at every level: a missing /
 * unreadable / malformed file (or a non-array `projects`) yields `[]`, never a
 * throw. Returned roots are de-duplicated and resolved to absolute paths; their
 * existence/realness is RE-CHECKED downstream (the store is an allowlist of
 * paths, not a guarantee the dir still exists).
 */
async function readAddedRoots(): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(addedStorePath(), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const list = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !entry) continue;
    if (entry.includes("\0")) continue;
    const abs = path.resolve(entry);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/**
 * Persist `root` (a canonical, already-validated `.claude` path) into the store.
 * Read-modify-write, de-duped, ATOMIC (temp-write + rename so a crash leaves the
 * prior file intact). Fail-soft: any IO error returns `false` without throwing —
 * the add still succeeds as a selection, it just won't survive a refresh.
 */
async function persistAddedRoot(root: string): Promise<boolean> {
  const abs = path.resolve(root);
  const existing = await readAddedRoots();
  if (!existing.includes(abs)) existing.push(abs);
  const store: AddedStore = {
    schema: ADDED_STORE_SCHEMA,
    version: 1,
    projects: existing,
  };
  const dest = addedStorePath();
  const tmp = path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.${process.pid}.${createHash("sha256")
      .update(`${Date.now()}:${abs}`)
      .digest("hex")
      .slice(0, 12)}.tmp`,
  );
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    await fs.rename(tmp, dest);
    return true;
  } catch {
    try {
      await fs.rm(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Scan — find project `.claude/` dirs with real harness content
// ──────────────────────────────────────────────────────────────────────────

/** Short stable id derived from a path (12 hex chars of its sha256). */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * True when any path segment of `abs` is a pruned dir name (F3). Belt-and-braces
 * over `collectClaudeDirs`'s descent-time pruning: even if a `.claude` slips
 * through (e.g. SCAN_ROOT itself sits under such a segment), a candidate whose
 * path crosses `tests/`, `fixtures/`, `node_modules/`, or `.next/` is excluded.
 */
function hasPrunedSegment(abs: string): boolean {
  return abs.split(path.sep).some((seg) => SKIP_DIRS.has(seg));
}

/**
 * True iff a `.claude/` directory holds REAL harness content — at least one of
 * the HARNESS_CONTENT_DIRS exists as a subdirectory. A `.claude/` that has only
 * settings*.json (no resource dirs) is excluded. Fail-soft: an unreadable dir
 * is treated as "no content".
 */
async function hasHarnessContent(claudeDir: string): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(claudeDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && HARNESS_CONTENT_DIRS.includes(entry.name)) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively collect every directory named `.claude` under `dir` (bounded
 * depth, pruning SKIP_DIRS). Does NOT descend INTO a found `.claude` (a harness
 * root has no nested harness roots worth listing). Fail-open per directory.
 */
async function collectClaudeDirs(
  dir: string,
  depth: number,
  out: string[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable / missing — fail-open
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const full = path.join(dir, name);
    if (name === CLAUDE_DIR) {
      out.push(full);
      continue; // do not descend into a harness root
    }
    if (SKIP_DIRS.has(name)) continue;
    await collectClaudeDirs(full, depth + 1, out);
  }
}

/**
 * Scan `scanRoot` for project harnesses: directories named `.claude` whose
 * contents include real harness content (excluding settings-only `.claude`
 * dirs). Returns one `Harness` per match, sorted by label. Fail-soft: any error
 * yields `[]` (the switcher still shows the library).
 */
export async function scanProjects(scanRoot?: string): Promise<Harness[]> {
  const root = scanRoot || SCAN_ROOT;
  const claudeDirs: string[] = [];
  try {
    await collectClaudeDirs(root, 0, claudeDirs);
  } catch {
    return [];
  }

  const out: Harness[] = [];
  for (const claudeDir of claudeDirs) {
    // Never list FORGE_ROOT/.claude as a "project" — the library is separate.
    if (path.resolve(claudeDir) === path.resolve(FORGE_ROOT)) continue;
    // F3: never surface a candidate that crosses a pruned (test/fixture) segment.
    if (hasPrunedSegment(path.resolve(claudeDir))) continue;
    if (!(await hasHarnessContent(claudeDir))) continue;
    const projectPath = path.dirname(claudeDir);
    out.push({
      kind: "project",
      id: shortHash(path.resolve(claudeDir)),
      label: path.basename(projectPath) || claudeDir,
      root: claudeDir,
      projectPath,
      source: "scanned",
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/**
 * The full switcher list: the LIBRARY (always first) + every scanned project.
 * Fail-soft (the scan never throws past `scanProjects`).
 */
export async function listHarnesses(scanRoot?: string): Promise<Harness[]> {
  return [LIBRARY, ...(await scanProjects(scanRoot))];
}

// ──────────────────────────────────────────────────────────────────────────
// Validation — a stored root is only trusted if it still resolves safely
// ──────────────────────────────────────────────────────────────────────────

/** True when `abs` is an existing directory. */
async function isDir(abs: string): Promise<boolean> {
  try {
    const st = await fs.stat(abs);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve symlinks to the REAL on-disk path, or null if it does not exist. All
 * trust checks run on this — `fs.stat`/`fs.readdir` follow symlinks, so a
 * `.claude` SYMLINK could otherwise smuggle the bridge cwd to an arbitrary
 * target. Validating the realpath (and requiring its basename to still be
 * `.claude`) closes that hole and the related TOCTOU on the persisted allowlist.
 */
async function realpathOrNull(abs: string): Promise<string | null> {
  try {
    return await fs.realpath(abs);
  } catch {
    return null;
  }
}

/** True when `abs` is an existing dir under SCAN_ROOT (the auto-scan space). */
function isUnderScanRoot(abs: string): boolean {
  const scanAbs = path.resolve(SCAN_ROOT);
  const scanWithSep = scanAbs.endsWith(path.sep) ? scanAbs : scanAbs + path.sep;
  return abs.startsWith(scanWithSep);
}

/**
 * VALIDATE a candidate root value and return the absolute root it resolves to,
 * or null if it is not a trustworthy harness root.
 *
 * Accepts:
 *   - "" / "library" / FORGE_ROOT → FORGE_ROOT (the library).
 *   - an existing `/.claude` dir that is EITHER under SCAN_ROOT (the auto-scan
 *     space) OR in the persisted added-projects allowlist (the explicit user
 *     allowlist that EXTENDS SCAN_ROOT for out-of-scan adds, F10), AND holds
 *     real harness content.
 *
 * Everything else (traversal/null byte, a non-`.claude` dir, a missing dir, a
 * settings-only `.claude`, or a path neither under SCAN_ROOT nor in the
 * allowlist) → null. The containment-OR-allowlist check is the load-bearing
 * guard against pointing the bridge at an arbitrary filesystem location — the
 * persisted store is the user's explicit allowlist, NOT a blanket bypass.
 */
async function validateRoot(rootValue: string): Promise<string | null> {
  if (
    !rootValue ||
    rootValue === LIBRARY_VALUE ||
    path.resolve(rootValue) === path.resolve(FORGE_ROOT)
  ) {
    return FORGE_ROOT;
  }
  if (rootValue.includes("\0")) return null;

  const abs = path.resolve(rootValue);

  // Must end in /.claude (a harness root is a project's .claude dir). This also
  // rejects `..` traversal that would resolve to a non-`.claude` basename.
  if (path.basename(abs) !== CLAUDE_DIR) return null;

  // Resolve SYMLINKS: every trust check below runs on the REAL on-disk path so a
  // `.claude` symlink can't smuggle the bridge cwd to an arbitrary target. A
  // non-existent path → reject.
  const real = await realpathOrNull(abs);
  if (real === null) return null;
  // The real target must ITSELF be a `.claude` dir (a `.claude → /arbitrary`
  // symlink resolves to a non-`.claude` basename → rejected).
  if (path.basename(real) !== CLAUDE_DIR) return null;

  // The REAL path must be EITHER under SCAN_ROOT, OR an explicitly-added
  // (persisted, realpath'd) root. (Defence: no arbitrary fs location — only the
  // scan space + the user's explicit allowlist.)
  if (!isUnderScanRoot(real)) {
    const allowlist = await readAddedRoots();
    if (!allowlist.includes(real)) return null;
  }

  // Must be a real `.claude` harness (not settings-only).
  if (!(await isDir(real))) return null;
  if (!(await hasHarnessContent(real))) return null;

  return real;
}

/**
 * VALIDATE + NORMALIZE a posted root value into the Harness it addresses, or
 * null if invalid. Used by the /api/harness POST handler to guard the cookie it
 * is about to set. A library value resolves to LIBRARY; a valid project
 * `.claude` path resolves to a fresh Harness (label = parent dir basename).
 */
export async function resolveHarness(
  rootValue: string,
): Promise<Harness | null> {
  const abs = await validateRoot(rootValue);
  if (abs === null) return null;
  if (abs === FORGE_ROOT) return LIBRARY;
  const projectPath = path.dirname(abs);
  return {
    kind: "project",
    id: shortHash(abs),
    label: path.basename(projectPath) || abs,
    root: abs,
    projectPath,
    // Mark its source for the UI: "scanned" when under SCAN_ROOT, else "added"
    // (it only validated because it is in the persisted allowlist).
    source: isUnderScanRoot(abs) ? "scanned" : "added",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Active root — read from the cookie, default to the library
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve the ACTIVE harness root the bridge should scope to, from the
 * `forge-harness` cookie. With NO cookie set (or "library", or any invalid /
 * unresolvable value), returns FORGE_ROOT — so the app behaves EXACTLY as the
 * library by default (no regression). A valid stored project `.claude` path is
 * returned verbatim.
 *
 * `cookies()` is a request-time API (next/headers) and is async in Next 16 — it
 * is only callable within a request scope (server components / route handlers),
 * which is exactly where the bridge runs.
 */
export async function getActiveRoot(): Promise<string> {
  let value: string | undefined;
  try {
    const store = await cookies();
    value = store.get(HARNESS_COOKIE)?.value;
  } catch {
    return FORGE_ROOT; // no request scope / cookie store ⇒ safe default
  }
  if (!value) return FORGE_ROOT;
  const abs = await validateRoot(value);
  return abs ?? FORGE_ROOT; // invalid stored value ⇒ safe default
}

/**
 * Resolve the ACTIVE harness as a full `Harness` (for display in the switcher /
 * headers). Mirrors getActiveRoot's resolution: invalid/missing ⇒ LIBRARY.
 */
export async function getActiveHarness(): Promise<Harness> {
  const root = await getActiveRoot();
  if (path.resolve(root) === path.resolve(FORGE_ROOT)) return LIBRARY;
  const projectPath = path.dirname(root);
  return {
    kind: "project",
    id: shortHash(root),
    label: path.basename(projectPath) || root,
    root,
    projectPath,
    source: isUnderScanRoot(path.resolve(root)) ? "scanned" : "added",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Projects — the project-plane view over scanProjects + the active selection
// ──────────────────────────────────────────────────────────────────────────

/**
 * The project-plane data shape: the scanned project harnesses (NEVER the
 * library — projects only) plus which one is currently SELECTED. `selectedRoot`
 * is the active root only when a PROJECT is active; it is null when the library
 * is the active scope (no project selected). The project selector renders this.
 */
export interface ProjectsData {
  /** Every scanned project harness (kind === "project"), sorted by label. */
  projects: Harness[];
  /**
   * The active project's root (`<project>/.claude`), or null when the active
   * scope is the library (i.e. no project is selected). Mirrors getActiveRoot.
   */
  selectedRoot: string | null;
  /** The active project's stable id (shortHash of its root), or null. */
  selectedId: string | null;
  /** Absolute root the scan crawls (FORGE_WEB_SCAN_ROOT or its default). */
  scanRoot: string;
}

/**
 * Resolve the project-plane view in one call: `scanProjects` for the option
 * list, joined with the active selection (getActiveHarness). When the active
 * scope is the library, `selectedRoot`/`selectedId` are null (no project
 * selected). Pure read — sets no cookie. Wraps the existing helpers verbatim
 * (no behaviour change to scanProjects/getActiveRoot).
 */
export async function getProjects(scanRoot?: string): Promise<ProjectsData> {
  const scanned = await scanProjects(scanRoot);

  // Union with the persisted allowlist (F10): out-of-scan added projects must
  // be listed + selectable + survive a refresh. Each persisted root is
  // RE-VALIDATED (real `.claude`, still on disk) so a deleted/stale entry is
  // silently dropped rather than shown as a dead row. Dedup by canonical root —
  // a scanned project that was also added keeps its "scanned" source.
  const byRoot = new Map<string, Harness>();
  for (const h of scanned) byRoot.set(path.resolve(h.root), h);

  for (const root of await readAddedRoots()) {
    if (byRoot.has(root)) continue; // already covered by the scan
    const harness = await resolveHarness(root);
    if (!harness || harness.kind !== "project") continue; // stale/invalid ⇒ drop
    byRoot.set(path.resolve(harness.root), harness);
  }

  const projects = [...byRoot.values()].sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  const active = await getActiveHarness();
  const selected = active.kind === "project" ? active : null;
  return {
    projects,
    selectedRoot: selected?.root ?? null,
    selectedId: selected?.id ?? null,
    scanRoot: path.resolve(scanRoot || SCAN_ROOT),
  };
}

/**
 * MANUALLY add a project by path, then PERSIST it (F10).
 *
 * A user adding a project by hand may type EITHER the project dir (`<project>`)
 * OR its `.claude` dir (`<project>/.claude`); we normalize to the `.claude` root.
 *
 * Unlike `select`, a manual add is an EXPLICIT user action, so it ACCEPTS a real
 * `.claude` harness OUTSIDE SCAN_ROOT (e.g. a sibling repo). It DROPS only the
 * SCAN_ROOT-containment requirement; it KEEPS every other security check:
 *   - no null byte / no traversal escape (path resolved canonically; basename
 *     must be `.claude`, so `..` cannot escape to an arbitrary dir),
 *   - the dir EXISTS on disk,
 *   - it is a GENUINE `.claude` harness (has real HARNESS_CONTENT_DIRS content,
 *     not a settings-only `.claude`).
 *
 * On success the canonical root is written to the persistent allowlist (so it is
 * listed by getProjects and accepted by validateRoot/getActiveRoot on future
 * requests) and the resolved Harness is returned (the caller then selects it).
 * Persisting is fail-soft: a write failure does NOT fail the add (it just won't
 * survive a refresh). The library sentinel / empty input ⇒ null (meaningless on
 * the project plane).
 */
export async function addProject(rootValue: string): Promise<Harness | null> {
  if (!rootValue || rootValue === LIBRARY_VALUE) {
    // "add the library" is meaningless on the project plane.
    return null;
  }
  if (rootValue.includes("\0")) return null;

  const trimmed = rootValue.replace(/[/\\]+$/, "");
  const candidate =
    path.basename(trimmed) === CLAUDE_DIR
      ? trimmed
      : path.join(trimmed, CLAUDE_DIR);

  const abs = path.resolve(candidate);

  // Security checks KEPT (only SCAN_ROOT-containment is dropped for explicit adds):
  // canonical `.claude` basename (no traversal escape), exists, real harness.
  if (path.basename(abs) !== CLAUDE_DIR) return null;
  // Resolve symlinks and validate the REAL target, so the persisted allowlist
  // entry is the canonical path that validateRoot will re-derive — a `.claude`
  // symlink to an arbitrary dir is rejected here and never persisted.
  const real = await realpathOrNull(abs);
  if (real === null) return null;
  if (path.basename(real) !== CLAUDE_DIR) return null;
  if (!(await isDir(real))) return null;
  if (!(await hasHarnessContent(real))) return null;

  // Persist the REAL canonical root into the explicit allowlist (fail-soft —
  // never blocks the add) so future validateRoot/getActiveRoot/getProjects calls
  // trust this out-of-scan root.
  await persistAddedRoot(real);

  const projectPath = path.dirname(real);
  return {
    kind: "project",
    id: shortHash(real),
    label: path.basename(projectPath) || real,
    root: real,
    projectPath,
    source: isUnderScanRoot(real) ? "scanned" : "added",
  };
}
