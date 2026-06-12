/**
 * forge-bridge/crud — additive CREATE / UPDATE / DELETE for markdown resources.
 *
 * ADDITIVE to the bridge: this module adds the per-resource CRUD surface the
 * dual-mode editors drive, without changing any existing export. It is the SOLE
 * write path for resource files (resources.ts owns the read/list side and the
 * Phase-0 `writeResource`; this owns create/update/delete) and it reuses the
 * SAME kind→path resolution (`relPathFor`) and the SAME additive write cycle
 * (write → `forge validate` → `forge registry build --write`).
 *
 * The three guarantees (AGENTS.md):
 *   1. ADDITIVE, NEVER DESTRUCTIVE on create — `createResource` REFUSES if the
 *      target file already exists (no silent overwrite).
 *   2. MINIMAL DIFF on update — `updateResource` rewrites ONLY the frontmatter
 *      lines whose values changed and preserves the BODY verbatim, via the pure
 *      `frontmatter-edit-core` module (no gray-matter reflow). Frontmatter KEY
 *      ORDER is preserved.
 *   3. GUARDED delete — `deleteResource` takes an explicit `{ confirm: true }`
 *      contract and refuses without it; it also refuses a non-existent target.
 *
 * Every op runs the write cycle and returns a `CrudResult` ({ ok, findings, … }).
 * Advisory WARNs are returned, never thrown (ADR-0007). A spawn/parse failure of
 * the CLI surfaces as a fail-soft envelope with `ok: false` (run.ts), so callers
 * handle it like any other result.
 *
 * NOTE: server-only module (node:fs / runForge → child_process). Import from
 * server components and route handlers only — never a "use client" boundary.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import matter from "gray-matter";

import { getActiveRoot } from "@/lib/harness";
import type {
  BridgeEnvelope,
  Finding,
  HookEvent,
  HookMatcherGroup,
  ResourceKind,
} from "@/lib/types";

import {
  serializeDocument,
  updateDocument,
  frontmatterMinimalEditable,
  splitDocument,
} from "./frontmatter-edit-core.mjs";
import {
  relPathFor,
  replaceHookGroup,
  removeHookGroup,
  appendHookGroup,
} from "./resources";
import { runForge } from "./run";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** The frontmatter + body payload an editor submits for a write. */
export interface ResourcePayload {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Uniform result of a CRUD op — mirrors WriteResult (resources.ts). */
export interface CrudResult {
  /** True when the file was written/removed AND validate found zero ERRORs. */
  ok: boolean;
  /** Absolute path that was created / updated / deleted. */
  path: string;
  /** Repo-relative path. */
  relPath: string;
  /** Findings from `forge validate` (advisory WARNs included, never thrown). */
  findings: Finding[];
  /** The full `forge validate --json` envelope. */
  validateResult: BridgeEnvelope;
  /** The `forge registry build --write` envelope. */
  registryResult: BridgeEnvelope;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Validate a kind-local id is safe to turn into a path. Rejects traversal
 * (`..`), absolute paths, leading/trailing slashes, and empties. `rule` ids may
 * contain `/` (they nest under rules/**); everything else must be a single
 * segment. This is a guard, not the schema — `forge validate` is the authority.
 */
function assertSafeId(kind: ResourceKind, id: string): void {
  if (!id || typeof id !== "string") {
    throw new Error("Resource id is required.");
  }
  if (id.includes("..") || id.includes("\0")) {
    throw new Error(`Unsafe resource id: ${JSON.stringify(id)}`);
  }
  if (path.isAbsolute(id) || id.startsWith("/") || id.endsWith("/")) {
    throw new Error(`Resource id must be repo-relative: ${JSON.stringify(id)}`);
  }
  const allowsSlash = kind === "rule";
  if (!allowsSlash && (id.includes("/") || id.includes("\\"))) {
    throw new Error(
      `Resource id for kind '${kind}' must be a single segment: ${JSON.stringify(id)}`,
    );
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(id)) {
    throw new Error(
      `Resource id contains unsupported characters: ${JSON.stringify(id)}`,
    );
  }
}

/** True when a path exists on disk. */
async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the shared additive write cycle: `forge validate` → `forge registry build
 * --write`. The caller has already written/removed the file on disk. Returns the
 * uniform CrudResult; `ok` is true iff validate reports zero ERROR-level
 * findings (ADR-0007: WARNs are advisory, never blocking).
 */
async function runWriteCycle(
  absPath: string,
  relPath: string,
): Promise<CrudResult> {
  const validateResult = await runForge("validate");
  const registryResult = await runForge("registry", ["build", "--write"]);
  const findings = validateResult.findings;
  const ok = (validateResult.summary?.errors ?? 0) === 0;
  return {
    ok,
    path: absPath,
    relPath,
    findings,
    validateResult,
    registryResult,
  };
}

/**
 * Serialize a payload to file text.
 *  - create: always a clean serialize (no existing formatting to preserve).
 *  - update: MINIMAL-DIFF against the current bytes when every value is a
 *    scalar/scalar-array; otherwise (bundle-style nested frontmatter) fall back
 *    to gray-matter's `matter.stringify` for that whole-frontmatter rewrite —
 *    the body is still preserved by gray-matter, and the caller is editing a
 *    structure this module can't surgically splice anyway.
 */
function serializeForUpdate(
  current: string,
  payload: ResourcePayload,
): string {
  if (frontmatterMinimalEditable(payload.frontmatter)) {
    return updateDocument(current, payload.frontmatter, payload.body);
  }
  // Nested frontmatter (e.g. bundles): preserve body, rewrite frontmatter whole.
  // gray-matter keeps the body verbatim; only the YAML block is reflowed, which
  // is unavoidable for arrays-of-maps and is what the user is editing anyway.
  return matter.stringify(payload.body, payload.frontmatter);
}

// ──────────────────────────────────────────────────────────────────────────
// Hook helpers — a hook payload is special: `body` is the JSON text of the
// matcher-group, and `frontmatter` surfaces { id, event, matcher, description }.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse the editor's hook `payload.body` (the JSON text of one matcher-group)
 * into a HookMatcherGroup, validating the minimal shape the writer needs (a
 * `hooks` array). Throws a CLEAR client-facing error on malformed JSON or shape
 * so the route returns a 4xx rather than corrupting hooks.json.
 */
function parseHookGroup(body: string): HookMatcherGroup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `Hook group body is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hook group body must be a JSON object.");
  }
  const group = parsed as Record<string, unknown>;
  if (!Array.isArray(group.hooks)) {
    throw new Error("Hook group must have a 'hooks' array.");
  }
  return group as unknown as HookMatcherGroup;
}

// ──────────────────────────────────────────────────────────────────────────
// CREATE — additive, never destructive
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create a NEW resource file. REFUSES (throws) if the target already exists —
 * create is additive and must never silently overwrite. Writes a freshly
 * serialized document, then runs the write cycle.
 */
export async function createResource(
  kind: ResourceKind,
  id: string,
  payload: ResourcePayload,
): Promise<CrudResult> {
  if (kind === "hook") {
    // APPEND a new matcher-group to its lifecycle event's array. The target event
    // comes from the submitted frontmatter (the body is the group JSON); both the
    // event and the group's `hooks` array are required.
    const event = payload.frontmatter.event;
    if (typeof event !== "string" || event.length === 0) {
      throw new Error(
        "Creating a hook requires a lifecycle 'event' in the frontmatter.",
      );
    }
    const group = parseHookGroup(payload.body);
    const { abs, groupRelPath } = await appendHookGroup(
      event as HookEvent,
      group,
    );
    return runWriteCycle(abs, groupRelPath);
  }
  assertSafeId(kind, id);

  const relPath = relPathFor(kind, id);
  const absPath = path.join(await getActiveRoot(), relPath);

  if (await exists(absPath)) {
    throw new Error(
      `Refusing to create '${kind}:${id}' — ${relPath} already exists (create is additive, never destructive). Use update to modify it.`,
    );
  }

  // mcp resources are RAW JSON config files: persist the body bytes verbatim
  // (no frontmatter serialization). Everything else serializes a document.
  const serialized =
    kind === "mcp"
      ? payload.body
      : serializeDocument(payload.frontmatter, payload.body);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, serialized, "utf8");

  return runWriteCycle(absPath, relPath);
}

// ──────────────────────────────────────────────────────────────────────────
// UPDATE — minimal diff (body verbatim, frontmatter key order preserved)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Update an EXISTING resource file with a MINIMAL DIFF: only the frontmatter
 * lines whose values changed are rewritten; the body is preserved exactly as
 * submitted (Monaco edits it verbatim); frontmatter key order is preserved.
 * REFUSES (throws) if the target does not exist. Then runs the write cycle.
 *
 * If the new text is byte-identical to the current file, the cycle still runs
 * (a deliberate re-validate is cheap and harmless); the file is left untouched.
 */
export async function updateResource(
  kind: ResourceKind,
  id: string,
  payload: ResourcePayload,
): Promise<CrudResult> {
  if (kind === "hook") {
    // Hooks live as matcher-groups inside the shared hooks/hooks.json. The editor
    // submits the group's JSON text as `body`; locate the addressed group and
    // REPLACE it in place (minimal-diff, jsonc-parser), then run the SAME cycle.
    const group = parseHookGroup(payload.body);
    const { abs, groupRelPath } = await replaceHookGroup(id, group);
    return runWriteCycle(abs, groupRelPath);
  }
  assertSafeId(kind, id);

  const relPath = relPathFor(kind, id);
  const absPath = path.join(await getActiveRoot(), relPath);

  let current: string;
  try {
    current = await fs.readFile(absPath, "utf8");
  } catch {
    throw new Error(
      `Refusing to update '${kind}:${id}' — ${relPath} does not exist. Use create to add it.`,
    );
  }

  let next: string;
  if (kind === "mcp") {
    // mcp resources are RAW JSON: persist the body bytes verbatim (no
    // frontmatter, so no minimal-diff splice — the JSON IS the file).
    next = payload.body;
  } else {
    // Guard: if the source has no frontmatter delimiter we cannot minimal-diff
    // it; serialize a clean document instead (rare — every real resource has one).
    const hasFm = splitDocument(current).hasFrontmatter;
    next = hasFm
      ? serializeForUpdate(current, payload)
      : serializeDocument(payload.frontmatter, payload.body);
  }

  if (next !== current) {
    await fs.writeFile(absPath, next, "utf8");
  }

  return runWriteCycle(absPath, relPath);
}

// ──────────────────────────────────────────────────────────────────────────
// DELETE — guarded
// ──────────────────────────────────────────────────────────────────────────

/**
 * Delete a resource file. GUARDED: the caller MUST pass `{ confirm: true }` —
 * otherwise this throws without touching disk (the confirm contract). Also
 * refuses a non-existent target. For a skill, the whole `skills/<id>/` directory
 * is removed (its SKILL.md is the resource, and an empty dir would be an orphan).
 * Then runs the write cycle so the registry drops the artifact.
 */
export async function deleteResource(
  kind: ResourceKind,
  id: string,
  options: { confirm: boolean },
): Promise<CrudResult> {
  // The confirm contract applies to EVERY kind, hooks included.
  if (!options || options.confirm !== true) {
    throw new Error(
      `Refusing to delete '${kind}:${id}' without explicit confirmation ({ confirm: true }).`,
    );
  }

  if (kind === "hook") {
    // Remove the addressed matcher-group from its event array (the emptied array
    // is left as []), then run the SAME write cycle. removeHookGroup throws if no
    // group carries that id (surfaced as a 404 by the route).
    const { abs, groupRelPath } = await removeHookGroup(id);
    return runWriteCycle(abs, groupRelPath);
  }
  assertSafeId(kind, id);

  const relPath = relPathFor(kind, id);
  const absPath = path.join(await getActiveRoot(), relPath);

  if (!(await exists(absPath))) {
    throw new Error(
      `Refusing to delete '${kind}:${id}' — ${relPath} does not exist.`,
    );
  }

  if (kind === "skill") {
    // The skill's resource is skills/<id>/SKILL.md; remove the whole skill dir.
    const skillDir = path.dirname(absPath);
    await fs.rm(skillDir, { recursive: true, force: true });
  } else {
    await fs.rm(absPath, { force: true });
  }

  return runWriteCycle(absPath, relPath);
}
