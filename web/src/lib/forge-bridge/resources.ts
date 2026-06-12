/**
 * forge-bridge/resources — on-disk resource read / list / write.
 *
 * Resource files live under the ACTIVE harness root (`getActiveRoot()` —
 * FORGE_ROOT for the library, or a project's `<project>/.claude`) in
 * kind-specific layouts:
 *   agent    agents/<id>.md
 *   skill    skills/<id>/SKILL.md
 *   command  commands/<id>.md
 *   rule     rules/**​/<id>.md            (nested; id may contain "/")
 *   bundle   bundles/<id>.md
 *   memory   memory/<id>.md
 *   hook     hooks/hooks.json#<id>        (a matcher-group inside hooks.json)
 *
 * Markdown resources are parsed with gray-matter into {frontmatter, body}.
 * The hook "kind" is special-cased: it is a JSON file, so a hook resource is a
 * matcher-group keyed by its `id`, returned with the event surfaced as
 * frontmatter and the JSON pretty-printed as the body.
 *
 * writeResource() is the ADDITIVE WRITE PATH: serialize → write file →
 * `forge validate` → `forge registry build --write`. Advisory WARNs are
 * returned in the result, never thrown.
 *
 * NOTE: server-only module (node:fs). Import from server contexts only.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import matter from "gray-matter";
import { applyEdits, modify } from "jsonc-parser";

import { getActiveRoot } from "@/lib/harness";
import type {
  HookEvent,
  HookEventMap,
  HookMatcherGroup,
  HooksFile,
  ResourceFile,
  ResourceKind,
  ResourceListEntry,
  WriteResult,
} from "@/lib/types";

import { runForge } from "./run";

const HOOKS_REL = "hooks/hooks.json";

/** Resolve the directory that holds a kind's resource files (markdown kinds). */
function kindDir(kind: ResourceKind): string {
  switch (kind) {
    case "agent":
      return "agents";
    case "skill":
      return "skills";
    case "command":
      return "commands";
    case "rule":
      return "rules";
    case "bundle":
      return "bundles";
    case "memory":
      return "memory";
    case "hook":
      return "hooks";
    case "workflow":
      return "workflows";
    case "mcp":
      return "mcp";
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown resource kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Repo-relative path of a markdown resource file for (kind, id).
 * Exported so the CRUD layer (crud.ts) resolves paths identically — the bridge
 * has a SINGLE source of truth for kind→path mapping.
 */
export function relPathFor(kind: ResourceKind, id: string): string {
  if (kind === "skill") return path.join("skills", id, "SKILL.md");
  // mcp resources are raw JSON config files, not markdown.
  if (kind === "mcp") return path.join("mcp", `${id}.json`);
  return path.join(kindDir(kind), `${id}.md`);
}

/** Recursively list `*.md` files under a directory, returning repo-relative paths. */
async function walkMarkdown(absDir: string, relBase: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const childRel = path.join(relBase, entry.name);
    const childAbs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(childAbs, childRel)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(childRel);
    }
  }
  return out;
}

/** List `*.json` files directly under a directory, returning repo-relative paths. */
async function walkJson(absDir: string, relBase: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(path.join(relBase, entry.name));
    }
  }
  return out;
}

/** Derive the kind-local id from a repo-relative resource path. */
function idFromRelPath(kind: ResourceKind, relPath: string): string {
  if (kind === "skill") {
    // skills/<id>/SKILL.md → <id>
    return path.dirname(relPath).split(path.sep).slice(1).join("/");
  }
  // mcp/<id>.json → <id>
  const ext = kind === "mcp" ? /\.json$/ : /\.md$/;
  const withoutExt = relPath.replace(ext, "");
  return withoutExt.split(path.sep).slice(1).join("/");
}

// ──────────────────────────────────────────────────────────────────────────
// Hooks (JSON) helpers
// ──────────────────────────────────────────────────────────────────────────

async function readHooksFile(): Promise<HooksFile> {
  const abs = path.join(await getActiveRoot(), HOOKS_REL);
  const raw = await fs.readFile(abs, "utf8");
  return JSON.parse(raw) as HooksFile;
}

function hookEventMap(file: HooksFile): HookEventMap {
  // The event map may be nested under "hooks" or be the top level itself.
  return file.hooks ?? (file as unknown as HookEventMap);
}

/** Flatten hooks.json into a list of (event, group) pairs keyed by group id. */
function flattenHooks(
  file: HooksFile,
): { event: HookEvent; index: number; group: HookMatcherGroup }[] {
  const map = hookEventMap(file);
  const out: { event: HookEvent; index: number; group: HookMatcherGroup }[] = [];
  for (const [event, groups] of Object.entries(map)) {
    if (event === "$schema" || !Array.isArray(groups)) continue;
    groups.forEach((group, index) => {
      out.push({ event: event as HookEvent, index, group });
    });
  }
  return out;
}

/** Stable addressable id for a hook group (its declared id, or event#index). */
function hookId(event: HookEvent, index: number, group: HookMatcherGroup): string {
  return group.id ?? `${event}#${index}`;
}

/**
 * Locate a hook group by its addressable id and return BOTH the match (event /
 * index / group) AND the jsonc-parser JSON path to that group object — the path
 * is `nested`-aware (prefixed with "hooks" when the event map is under a
 * top-level "hooks" key, REUSING the same `hookEventMap` shape detection the read
 * path uses). Returns null when no group carries that id.
 */
function findHookGroupPath(
  file: HooksFile,
  id: string,
): {
  event: HookEvent;
  index: number;
  group: HookMatcherGroup;
  groupPath: (string | number)[];
} | null {
  // `nested` is true iff the event map lives under a top-level "hooks" key (the
  // same shape `hookEventMap` collapses); the jsonc path must include that key.
  const nested = Boolean(file.hooks);
  const match = flattenHooks(file).find(
    ({ event, index, group }) => hookId(event, index, group) === id,
  );
  if (!match) return null;
  const groupPath = nested
    ? ["hooks", match.event, match.index]
    : [match.event, match.index];
  return { ...match, groupPath };
}

/**
 * Absolute + repo-relative path of the shared hooks file, plus the editor-facing
 * relPath that surfaces the addressed group (`hooks/hooks.json#<id>`). The
 * SINGLE place the hook write path resolves these — mirrors `relPathFor` for
 * markdown kinds so the CRUD layer treats hooks uniformly. Async because the abs
 * path is anchored at the ACTIVE harness root (`getActiveRoot()`).
 */
export async function hookPaths(id: string): Promise<{
  abs: string;
  relPath: string;
  groupRelPath: string;
}> {
  return {
    abs: path.join(await getActiveRoot(), HOOKS_REL),
    relPath: HOOKS_REL,
    groupRelPath: `${HOOKS_REL}#${id}`,
  };
}

/**
 * ADDITIVE hook UPDATE — REPLACE the matcher-group addressed by `id` IN PLACE
 * inside hooks/hooks.json with `group`, preserving the surrounding structure and
 * sibling key order as much as practical (jsonc-parser `modify` + `applyEdits`
 * splices only the target group's bytes; every other event/group line stays
 * byte-identical). REFUSES (throws) when no group carries that id. Writes the
 * file (pretty-printed, 2-space) and returns the abs path; the caller runs the
 * shared write cycle (validate → registry build).
 *
 * NOTE: server-only (node:fs). The CRUD layer (crud.ts) is the sole caller.
 */
export async function replaceHookGroup(
  id: string,
  group: HookMatcherGroup,
): Promise<{ abs: string; relPath: string; groupRelPath: string }> {
  const { abs, relPath, groupRelPath } = await hookPaths(id);
  const before = await fs.readFile(abs, "utf8");
  const file = JSON.parse(before) as HooksFile;

  const loc = findHookGroupPath(file, id);
  if (!loc) {
    throw new Error(`Hook group not found: ${id}`);
  }

  const edits = modify(before, loc.groupPath, group, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  const after = applyEdits(before, edits);
  if (after !== before) {
    await fs.writeFile(abs, after, "utf8");
  }
  return { abs, relPath, groupRelPath };
}

/**
 * ADDITIVE-but-GUARDED hook DELETE — remove the matcher-group addressed by `id`
 * from its event array. The emptied array is left as `[]` (never the whole event
 * key removed) so the surrounding structure stays stable. Uses jsonc-parser
 * `modify(value=undefined)` so only that group's bytes (and its trailing comma)
 * are dropped. REFUSES (throws) when no group carries that id. Writes the file;
 * the caller runs the shared write cycle.
 */
export async function removeHookGroup(
  id: string,
): Promise<{ abs: string; relPath: string; groupRelPath: string }> {
  const { abs, relPath, groupRelPath } = await hookPaths(id);
  const before = await fs.readFile(abs, "utf8");
  const file = JSON.parse(before) as HooksFile;

  const loc = findHookGroupPath(file, id);
  if (!loc) {
    throw new Error(`Hook group not found: ${id}`);
  }

  // modify(undefined) on an array index removes that element in place, leaving
  // the (possibly now-empty) array `[]` and every sibling line untouched.
  const edits = modify(before, loc.groupPath, undefined, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  const after = applyEdits(before, edits);
  if (after !== before) {
    await fs.writeFile(abs, after, "utf8");
  }
  return { abs, relPath, groupRelPath };
}

/**
 * ADDITIVE hook CREATE — APPEND a new matcher-group to `event`'s array inside
 * hooks/hooks.json (creating the array when the event is absent). Uses
 * jsonc-parser `modify` with `isArrayInsertion` so the new group's bytes are
 * spliced at the end of the array and every existing group stays byte-identical.
 * Writes the file; the caller runs the shared write cycle.
 */
export async function appendHookGroup(
  event: HookEvent,
  group: HookMatcherGroup,
): Promise<{ abs: string; relPath: string; groupRelPath: string }> {
  const id = group.id ?? event;
  const { abs, relPath, groupRelPath } = await hookPaths(id);
  const before = await fs.readFile(abs, "utf8");
  const file = JSON.parse(before) as HooksFile;

  // Mirror the read path's shape detection: write under "hooks" when nested.
  const nested = Boolean(file.hooks);
  const map = hookEventMap(file);
  const existing = map[event];
  const length = Array.isArray(existing) ? existing.length : 0;
  // Path to the (length)-th slot of the event array; isArrayInsertion appends.
  const insertPath = nested
    ? ["hooks", event, length]
    : [event, length];

  const edits = modify(before, insertPath, group, {
    isArrayInsertion: true,
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  const after = applyEdits(before, edits);
  await fs.writeFile(abs, after, "utf8");
  return { abs, relPath, groupRelPath };
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

/** Read one resource from disk → {frontmatter, body, path}. */
export async function readResource<TFrontmatter = Record<string, unknown>>(
  kind: ResourceKind,
  id: string,
): Promise<ResourceFile<TFrontmatter>> {
  const root = await getActiveRoot();

  if (kind === "hook") {
    const file = await readHooksFile();
    const match = flattenHooks(file).find(
      ({ event, index, group }) => hookId(event, index, group) === id,
    );
    if (!match) {
      throw new Error(`Hook group not found: ${id}`);
    }
    return {
      frontmatter: {
        id,
        event: match.event,
        matcher: match.group.matcher,
        description: match.group.description,
      } as TFrontmatter,
      body: JSON.stringify(match.group, null, 2),
      path: path.join(root, HOOKS_REL),
      relPath: `${HOOKS_REL}#${id}`,
      id,
      kind,
    };
  }

  if (kind === "mcp") {
    // mcp resources are RAW JSON config files (mcp/<id>.json): do NOT run
    // gray-matter. The whole file text IS the body; frontmatter is always empty.
    const relPath = relPathFor(kind, id);
    const absPath = path.join(root, relPath);
    const raw = await fs.readFile(absPath, "utf8");
    return {
      frontmatter: {} as TFrontmatter,
      body: raw,
      path: absPath,
      relPath,
      id,
      kind,
    };
  }

  const relPath = relPathFor(kind, id);
  const absPath = path.join(root, relPath);
  const raw = await fs.readFile(absPath, "utf8");
  const parsed = matter(raw);
  return {
    frontmatter: parsed.data as TFrontmatter,
    body: parsed.content,
    path: absPath,
    relPath,
    id,
    kind,
  };
}

/** List every resource of a kind → lightweight entries (no body). */
export async function listResources<TFrontmatter = Record<string, unknown>>(
  kind: ResourceKind,
): Promise<ResourceListEntry<TFrontmatter>[]> {
  const root = await getActiveRoot();

  if (kind === "hook") {
    const file = await readHooksFile();
    return flattenHooks(file).map(({ event, index, group }) => {
      const id = hookId(event, index, group);
      return {
        id,
        kind,
        path: path.join(root, HOOKS_REL),
        relPath: `${HOOKS_REL}#${id}`,
        frontmatter: {
          id,
          event,
          matcher: group.matcher,
          description: group.description,
        } as TFrontmatter,
      };
    });
  }

  const dir = kindDir(kind);
  const absDir = path.join(root, dir);

  if (kind === "mcp") {
    // mcp resources are RAW JSON config files (mcp/*.json): no gray-matter,
    // frontmatter is always empty. The body is read lazily by readResource.
    const relPaths = await walkJson(absDir, dir);
    const out: ResourceListEntry<TFrontmatter>[] = relPaths.map((relPath) => ({
      id: idFromRelPath(kind, relPath),
      kind,
      path: path.join(root, relPath),
      relPath,
      frontmatter: {} as TFrontmatter,
    }));
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  let relPaths: string[];
  if (kind === "skill") {
    // One SKILL.md per skill subdirectory.
    let subdirs: import("node:fs").Dirent[];
    try {
      subdirs = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      subdirs = [];
    }
    relPaths = subdirs
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name, "SKILL.md"));
  } else {
    relPaths = await walkMarkdown(absDir, dir);
  }

  const out: ResourceListEntry<TFrontmatter>[] = [];
  for (const relPath of relPaths) {
    const absPath = path.join(root, relPath);
    let raw: string;
    try {
      raw = await fs.readFile(absPath, "utf8");
    } catch {
      continue;
    }
    const parsed = matter(raw);
    out.push({
      id: idFromRelPath(kind, relPath),
      kind,
      path: absPath,
      relPath,
      frontmatter: parsed.data as TFrontmatter,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * ADDITIVE WRITE PATH — serialize {frontmatter, body} → write file →
 * `forge validate` → `forge registry build --write`.
 *
 * Returns {ok, path, findings, validateResult, registryResult}. Advisory WARNs
 * are returned in `findings`, never thrown. `ok` reflects validate having zero
 * ERROR-level findings (ADR-0007: WARNs are non-blocking).
 *
 * Hooks are not writable through this path in Phase 0 (they are groups inside a
 * shared JSON file); attempting it throws.
 */
export async function writeResource(
  kind: ResourceKind,
  id: string,
  payload: { frontmatter: Record<string, unknown>; body: string },
): Promise<WriteResult> {
  if (kind === "hook") {
    throw new Error(
      "writeResource does not support the 'hook' kind in Phase 0 (hooks are groups inside hooks/hooks.json).",
    );
  }

  const relPath = relPathFor(kind, id);
  const absPath = path.join(await getActiveRoot(), relPath);

  // mcp resources are RAW JSON: persist the body bytes verbatim (no
  // gray-matter). Everything else serializes frontmatter + body.
  const serialized =
    kind === "mcp"
      ? payload.body
      : matter.stringify(payload.body, payload.frontmatter);

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, serialized, "utf8");

  // Validate, then rebuild the registry (write-through).
  const validateResult = await runForge("validate");
  const registryResult = await runForge("registry", ["build", "--write"]);

  const findings = validateResult.findings;
  const ok = (validateResult.summary?.errors ?? 0) === 0;

  return { ok, path: absPath, findings, validateResult, registryResult };
}
