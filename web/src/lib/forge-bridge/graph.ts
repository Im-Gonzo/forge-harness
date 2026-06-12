/**
 * forge-bridge/graph — graph-scoped read + write helpers for the /graph route.
 *
 * ADDITIVE to the bridge: this module adds the dependency-graph and
 * composition-graph surfaces without changing any existing export. It is the
 * SOLE place the graph route touches forge, and it reuses runForge / the
 * write→validate→registry-build cycle (the same contract writeResource uses).
 *
 * Reads:
 *   getDangling()  → DERIVED LIVE from `forge registry build` (data.dangling)
 *   getOrphans()   → DERIVED LIVE from `forge registry build` (data.orphans)
 *   readManifest() → parse manifests/<name>.json from disk
 *
 * SCOPE-CORRECTNESS: getDangling/getOrphans derive the dependency graph from the
 * LIVE `registry build` artifact set (computed in-memory from the active root),
 * NOT from `registry dangling`/`orphans` — those read the cached
 * `.forge/registry.json`, which a freshly-scoped PROJECT has none of, so they
 * would always report 0. Deriving from `build` makes both surfaces correct for
 * ANY scope (library or a project's `.claude/`).
 *
 * Writes (both go through the additive cycle write → validate → registry build):
 *   writeManifest(name, json)      — rewrite a composition manifest, then rebuild
 *   resolveDanglingRef(plan)       — edit a source file in place to remove/redirect
 *                                    a dangling reference, then rebuild
 *
 * NOTE: server-only module (node:fs / runForge → child_process). Import from
 * server components and route handlers only — never a "use client" boundary.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { getActiveRoot } from "@/lib/harness";
import type {
  BridgeEnvelope,
  Finding,
  RegistryArtifact,
  RegistryLsData,
} from "@/lib/types";

// PURE, framework-free editing primitives (shared with the verification scripts
// so the round-trip test exercises the exact code the route runs).
import {
  editScalarArray,
  deleteProperty,
  rewriteRef,
  type JsonPath,
} from "./graph-edit-core.mjs";
import { runForge } from "./run";

export { editScalarArray };
export type { JsonPath };

// ──────────────────────────────────────────────────────────────────────────
// Graph-scoped types (kept local to the graph surface — src/lib/types.ts is
// owned by Phase 0 and not edited here).
// ──────────────────────────────────────────────────────────────────────────

/** One referencing site for a dangling ref (deps.mjs Site). */
export interface DanglingSite {
  /** Repo-relative path of the referencing file. */
  path: string;
  /** 1-based line, or null when not line-locatable. */
  line: number | null;
}

/** A consolidated dangling reference (deps.mjs DanglingRef / BR-DEP-003/004). */
export interface DanglingRef {
  /** Lexicographically-smallest referrer uid (canonical `from`). */
  from: string;
  /** The raw reference text (bare name / path / module name). */
  rawRef: string;
  /** Inferred kind of the missing target (agent|skill|rule|…|link). */
  refKind: string;
  /** Every site that references this rawRef. */
  sites: DanglingSite[];
  /** Human-readable reason the ref does not resolve. */
  reason: string;
}

/** The two editable composition manifests. */
export type CompositionManifestName = "profiles" | "modules";

/** manifests/profiles.json shape (the parts the composition graph reads/writes). */
export interface ProfilesManifest {
  version?: number;
  defaultProfile?: string;
  profiles: Record<string, { description?: string; modules: string[] }>;
  moduleSelectionRules?: unknown;
  [key: string]: unknown;
}

/** manifests/modules.json shape (the parts the composition graph reads/writes). */
export interface ModuleDef {
  description?: string;
  always?: boolean;
  components?: Record<string, string[]>;
}
export interface ModulesManifest {
  version?: number;
  componentKinds: string[];
  modules: Record<string, ModuleDef>;
  [key: string]: unknown;
}

/** A plan to resolve a dangling reference by editing its source file(s). */
export interface ResolveDanglingPlan {
  rawRef: string;
  sites: DanglingSite[];
  action: "remove" | "redirect";
  /** Required when action === "redirect": the existing artifact id to point at. */
  toId?: string;
}

/** Result of an additive manifest / resolve write cycle. */
export interface ManifestWriteResult {
  ok: boolean;
  path: string;
  findings: Finding[];
  validateResult: BridgeEnvelope;
  registryResult: BridgeEnvelope;
}

// ──────────────────────────────────────────────────────────────────────────
// Reads
// ──────────────────────────────────────────────────────────────────────────

/**
 * True for a `module:*` dependency token — composition wiring (a module the
 * artifact belongs to), NOT an artifact-to-artifact edge. Excluded from both the
 * dangling check (a module is not expected to resolve to an artifact uid) and the
 * orphan check (module membership is not an inbound artifact dependency).
 */
function isModuleRef(dep: string): boolean {
  return dep.startsWith("module:");
}

/** Infer a dangling ref's kind from its token (`<kind>:<id>` → kind, else "link"). */
function inferRefKind(dep: string): string {
  return dep.includes(":") ? dep.split(":")[0] : "link";
}

/**
 * DERIVE the consolidated dangling refs LIVE from `registry build`.
 *
 * For every artifact, each of its `dependsOn` tokens that is NOT a `module:*` ref
 * and does NOT resolve to a known artifact uid is emitted as a DanglingRef
 * { from: artifact.uid, rawRef: dep, refKind }. The return envelope shape
 * ({ data: { dangling } }) is unchanged, so the /graph page is unaffected — only
 * the SOURCE of the data moved from the cache to the live build (scope-correct).
 */
export async function getDangling(): Promise<
  BridgeEnvelope<{ dangling: DanglingRef[] }>
> {
  const build = await runForge<RegistryLsData>("registry", ["build"]);
  const artifacts: RegistryArtifact[] = build.data?.artifacts ?? [];
  const known = new Set(artifacts.map((a) => a.uid));

  const dangling: DanglingRef[] = [];
  for (const artifact of artifacts) {
    for (const dep of artifact.dependsOn ?? []) {
      if (isModuleRef(dep)) continue;
      if (known.has(dep)) continue;
      dangling.push({
        from: artifact.uid,
        rawRef: dep,
        refKind: inferRefKind(dep),
        sites: [],
        reason: `'${dep}' does not resolve to a known artifact uid.`,
      });
    }
  }

  return { ...build, data: { dangling } };
}

/**
 * DERIVE the orphan uids LIVE from `registry build`.
 *
 * An orphan is an artifact uid that appears in NO other artifact's `dependsOn`
 * (module:* refs excluded — module membership is composition, not an inbound
 * artifact edge). The return envelope shape ({ data: { orphans } }) is unchanged.
 */
export async function getOrphans(): Promise<
  BridgeEnvelope<{ orphans: string[] }>
> {
  const build = await runForge<RegistryLsData>("registry", ["build"]);
  const artifacts: RegistryArtifact[] = build.data?.artifacts ?? [];

  // Every uid that some artifact depends on (excluding module:* tokens).
  const referenced = new Set<string>();
  for (const artifact of artifacts) {
    for (const dep of artifact.dependsOn ?? []) {
      if (isModuleRef(dep)) continue;
      referenced.add(dep);
    }
  }

  const orphans = artifacts
    .map((a) => a.uid)
    .filter((uid) => !referenced.has(uid));

  return { ...build, data: { orphans } };
}

/** Map a composition-manifest name to its repo-relative path. */
function manifestRelPath(name: CompositionManifestName): string {
  return path.join("manifests", `${name}.json`);
}

/** Read + parse one composition manifest from disk (under the active root). */
export async function readManifest<T = unknown>(
  name: CompositionManifestName,
): Promise<T> {
  const abs = path.join(await getActiveRoot(), manifestRelPath(name));
  const raw = await fs.readFile(abs, "utf8");
  return JSON.parse(raw) as T;
}

/** An empty composition — the fail-soft shape for roots that have no manifests/. */
function emptyComposition(): {
  profiles: ProfilesManifest;
  modules: ModulesManifest;
} {
  return {
    profiles: { profiles: {} },
    modules: { componentKinds: [], modules: {} },
  };
}

/**
 * Read both composition manifests in parallel.
 *
 * FAIL-SOFT: a PROJECT harness root (`<project>/.claude`) has NO `manifests/`
 * dir (composition is a library-only concept — a project is a thin install of a
 * resolved profile, not the composition source). So a missing/unreadable
 * manifest yields an EMPTY composition rather than throwing, which keeps the
 * /graph route working when scoped to a project (it simply shows no profiles or
 * modules to compose).
 */
export async function readComposition(): Promise<{
  profiles: ProfilesManifest;
  modules: ModulesManifest;
}> {
  try {
    const [profiles, modules] = await Promise.all([
      readManifest<ProfilesManifest>("profiles"),
      readManifest<ModulesManifest>("modules"),
    ]);
    return { profiles, modules };
  } catch {
    return emptyComposition();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// The additive write cycle (shared)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Run the additive write-through cycle that every editable graph action shares:
 *   `forge validate` → `forge registry build --write`.
 * Returns {ok, findings, validateResult, registryResult}. `ok` is true when
 * validate reports zero ERROR-level findings (ADR-0007: WARNs are advisory,
 * never blocking). The caller has already written the file(s) on disk.
 */
async function runWriteCycle(
  absPath: string,
): Promise<ManifestWriteResult> {
  const validateResult = await runForge("validate");
  const registryResult = await runForge("registry", ["build", "--write"]);
  const findings = validateResult.findings;
  const ok = (validateResult.summary?.errors ?? 0) === 0;
  return { ok, path: absPath, findings, validateResult, registryResult };
}

// ──────────────────────────────────────────────────────────────────────────
// writeManifest — composition-graph edit (assign module/component)
// ──────────────────────────────────────────────────────────────────────────

/** True for a value that is a scalar (string/number/boolean/null). */
function isScalar(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

/** An object/array all of whose (own) values are scalars can render inline. */
function isFlat(v: unknown): boolean {
  if (Array.isArray(v)) return v.every(isScalar);
  if (v !== null && typeof v === "object") {
    return Object.values(v as Record<string, unknown>).every(isScalar);
  }
  return false;
}

/** Render a flat (all-scalar) object/array on a single line. */
function inline(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map((v) => JSON.stringify(v)).join(", ") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    "{ " +
    entries.map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") +
    " }"
  );
}

/**
 * Serialize a manifest object to match the repo's hand-authored JSON style:
 * 2-space indent, with FLAT containers (arrays of scalars, and small objects
 * whose values are all scalars — e.g. moduleSelectionRules' `{ "when": …,
 * "module": … }`) kept INLINE on one line. Nested non-flat structures expand
 * one entry per line. This keeps an assign/remove edit a minimal one-line diff
 * rather than re-wrapping the whole file. Deterministic (key order preserved).
 */
export function serializeManifest(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const padIn = "  ".repeat(indent + 1);

  if (isScalar(value)) return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isScalar)) return inline(value);
    // Array of objects/arrays: each element on its own line, inlined if flat.
    const items = value.map(
      (v) => padIn + (isFlat(v) ? inline(v) : serializeManifest(v, indent + 1)),
    );
    return "[\n" + items.join(",\n") + "\n" + pad + "]";
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const lines = entries.map(
    ([k, v]) =>
      padIn +
      JSON.stringify(k) +
      ": " +
      (isFlat(v) ? inline(v) : serializeManifest(v, indent + 1)),
  );
  return "{\n" + lines.join(",\n") + "\n" + pad + "}";
}

/**
 * WHOLE-FILE WRITE PATH (new manifests only).
 *
 * Serializes `json` with `serializeManifest` and writes the entire file. This
 * REFLOWS the document to the canonical style, so it must NOT be used for an
 * in-place edit of a hand-authored manifest — use `modifyManifestArray` for
 * that (it is byte-minimal and preserves every other line verbatim). Retained
 * for creating a brand-new manifest from scratch, where there is no existing
 * formatting to preserve.
 */
export async function writeManifest(
  name: CompositionManifestName,
  json: unknown,
): Promise<ManifestWriteResult> {
  const relPath = manifestRelPath(name);
  const absPath = path.join(await getActiveRoot(), relPath);
  const serialized = serializeManifest(json) + "\n";
  await fs.writeFile(absPath, serialized, "utf8");
  return runWriteCycle(absPath);
}

// ──────────────────────────────────────────────────────────────────────────
// modifyManifestArray — MINIMAL-DIFF in-place edit (the real write path)
// ──────────────────────────────────────────────────────────────────────────
//
// The byte-minimal text edit itself lives in ./graph-edit-core.mjs
// (`editScalarArray`, `deleteProperty`) — a pure, framework-free module shared
// with the verification scripts. These wrappers add the active-root IO + the
// validate→registry-build cycle.

/**
 * MINIMAL-DIFF in-place WRITE PATH for a composition manifest.
 *
 * Reads the raw on-disk text, applies a byte-minimal `editScalarArray` edit at
 * `jsonPath`, writes it back (unchanged bytes everywhere else), then runs the
 * shared validate → registry-build cycle. This is what the composition graph's
 * add/remove actions use — adding `database` to one profile's `modules` touches
 * only that array, never reflowing another profile's hand-wrapped array.
 *
 * The caller (the graph-edit route) has already validated existence/uniqueness
 * against the parsed object; this re-checks idempotently (add of a present value
 * / remove of an absent one is a no-op, surfaced as a clear error before the
 * cycle runs so the UI does not report a misleading success).
 */
export async function modifyManifestArray(
  name: CompositionManifestName,
  jsonPath: JsonPath,
  op: "add" | "remove",
  value: string,
): Promise<ManifestWriteResult> {
  const relPath = manifestRelPath(name);
  const absPath = path.join(await getActiveRoot(), relPath);
  const before = await fs.readFile(absPath, "utf8");
  const after = editScalarArray(before, jsonPath, op, value);
  if (after === before) {
    throw new Error(
      `modifyManifestArray: ${op} of '${value}' at ${JSON.stringify(
        jsonPath,
      )} was a no-op (already ${op === "add" ? "present" : "absent"}).`,
    );
  }
  await fs.writeFile(absPath, after, "utf8");
  return runWriteCycle(absPath);
}

/**
 * MINIMAL-DIFF property DELETE for a composition manifest.
 *
 * Removes the whole object property at `jsonPath` (e.g. dropping a now-empty
 * `components.skills` key when its last component was removed, matching the
 * prior whole-object behaviour that deleted the key rather than leaving `[]`).
 * Uses jsonc-parser `modify(value=undefined)` + `applyEdits`, which deletes only
 * that property's bytes and its trailing comma — every other line is preserved.
 */
export async function deleteManifestProperty(
  name: CompositionManifestName,
  jsonPath: JsonPath,
): Promise<ManifestWriteResult> {
  const relPath = manifestRelPath(name);
  const absPath = path.join(await getActiveRoot(), relPath);
  const before = await fs.readFile(absPath, "utf8");
  const after = deleteProperty(before, jsonPath);
  if (after === before) {
    throw new Error(
      `deleteManifestProperty: no property at ${JSON.stringify(jsonPath)}.`,
    );
  }
  await fs.writeFile(absPath, after, "utf8");
  return runWriteCycle(absPath);
}

// ──────────────────────────────────────────────────────────────────────────
// resolveDanglingRef — dependency-graph edit (fix a dangling ref in place)
// ──────────────────────────────────────────────────────────────────────────

/**
 * ADDITIVE WRITE PATH for resolving a dangling reference.
 *
 * A dangling ref is a raw token in a source file that does not resolve to a
 * known artifact (deps.mjs consolidates every site of the same rawRef into one
 * entry). Resolving it means editing the referencing FILE(S) in place:
 *
 *   action "remove"   — delete the backticked raw token at each site. A
 *                       frontmatter pointer line (e.g. `reviewer: foo`) is
 *                       removed whole; an inline backticked `name` is unticked
 *                       to plain text so the prose reads naturally but no longer
 *                       resolves to an edge.
 *   action "redirect" — replace the raw token with an existing artifact's id at
 *                       each site (backtick-preserving), so the edge now
 *                       resolves to `toId`.
 *
 * Only the EXACT rawRef token is touched, and only inside backticks or as a
 * frontmatter scalar value — never arbitrary substrings — so the edit is
 * surgical. After writing every affected file, the validate → registry-build
 * cycle runs; the rebuilt registry no longer carries the dangling entry (or now
 * carries a resolved edge), which the UI reflects on refetch.
 *
 * Returns the cycle result plus the list of edited repo-relative paths.
 */
export async function resolveDanglingRef(
  plan: ResolveDanglingPlan,
): Promise<ManifestWriteResult & { edited: string[] }> {
  const { rawRef, sites, action, toId } = plan;
  if (action === "redirect" && (!toId || toId.length === 0)) {
    throw new Error("resolveDanglingRef: redirect requires a non-empty toId.");
  }
  if (!rawRef || rawRef.length === 0) {
    throw new Error("resolveDanglingRef: rawRef is required.");
  }

  // Distinct files to touch (a rawRef may appear at multiple sites in a file).
  const relPaths = Array.from(
    new Set(sites.map((s) => s.path).filter((p): p is string => Boolean(p))),
  );
  if (relPaths.length === 0) {
    throw new Error("resolveDanglingRef: no editable sites for this rawRef.");
  }

  const root = await getActiveRoot();
  const edited: string[] = [];
  for (const relPath of relPaths) {
    const absPath = path.join(root, relPath);
    let text: string;
    try {
      text = await fs.readFile(absPath, "utf8");
    } catch {
      continue; // fail-open per file (a stale site is not fatal)
    }
    const next = rewriteRef(text, rawRef, action, toId);
    if (next !== text) {
      await fs.writeFile(absPath, next, "utf8");
      edited.push(relPath);
    }
  }

  if (edited.length === 0) {
    throw new Error(
      `resolveDanglingRef: rawRef \`${rawRef}\` was not found at any of its sites (already resolved?).`,
    );
  }

  // Use the first edited file as the representative path for the result.
  const cycle = await runWriteCycle(path.join(root, edited[0]));
  return { ...cycle, edited };
}
