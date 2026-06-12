// @ts-check
/**
 * registry — the manager's spine: a GENERATED catalog of every harness artifact
 * (SPEC-00 §C4, SPEC-01, SPEC-02, SPEC-09; BR-REG-001..010, BR-VER-001..008).
 *
 * Two layers live here:
 *
 *   1. `buildRegistry(rootDir, priorRegistry)` — a PURE scan: walk the library,
 *      classify every file via resolve-kind, hash its bytes, read its frontmatter,
 *      reverse-index `modules.json`, and emit the SPEC-01 record array. It carries
 *      `createdAt`/`revision`/`version` forward for UNCHANGED artifacts from the
 *      prior committed registry and PRESERVES the prior `generatedAt` when the
 *      artifact set is unchanged, so two rebuilds are byte-identical and append no
 *      log line (BR-REG-006, EVAL-REG-006). It is fail-open per file (EVAL-REG-010):
 *      one bad artifact yields one finding and is skipped, never aborting the build.
 *
 *   2. The C4 module contract — `run(subcmd, args, ctx)` + `summarize(state)`.
 *      `run` NEVER writes stdout; it returns `{ ok, data, findings, summary }`. The
 *      dispatcher (W3) renders. Writing verbs are dry-run by default; `build --write`
 *      and `bump` persist via `manager/lib/store.mjs` (atomic snapshot + append-only
 *      log) and append a log line ONLY when an artifact's contentHash changed.
 *
 * This module is ALSO runnable directly as a script:
 *   node manager/registry.mjs <subcmd> [flags] [rootDir]
 * rendering human text, or the C3 `--json` envelope under `--json`. The trailing
 * `rootDir` arg lets the tests target tests/manager/fixtures/* sandboxes.
 *
 * HARD INVARIANTS: zero runtime deps (node: builtins + relative imports only);
 * additive-never-destructive; fail-open (no public entry throws past its surface);
 * writers are dry-run by default.
 *
 * @module manager/registry
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { walkLibrary } from './lib/walk.mjs';
import { pathToUid, componentCandidates, loadDeclaredHookIds } from './lib/resolve-kind.mjs';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import { computeGraph } from './lib/deps.mjs';
import { sha256hex } from './lib/hash.mjs';
import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import {
  readJson,
  readJsonl,
  writeJsonAtomic,
  appendJsonl,
  forgeStateDir,
  stampSchemaVersion,
} from './lib/store.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** On-disk schema version for the registry snapshot (SPEC-09 store gate). */
const REGISTRY_SCHEMA_VERSION = 1;
/** Seed semver for a brand-new artifact (BR-VER-001). */
const SEED_VERSION = '0.1.0';
/** Seed revision for a brand-new artifact (BR-VER-001). */
const SEED_REVISION = 1;
/** The emitter stamped on findings this module raises (C2 `source`). */
const SOURCE = 'validate-registry';

/** Default criticality when frontmatter does not declare one (ADR-0013, stored only). */
const DEFAULT_CRITICALITY = 'normal';
/** Permitted lifecycle statuses (SPEC-01 / registry.schema.json). */
const STATUS_SET = new Set(['active', 'deprecated', 'experimental', 'planned']);
/** Permitted criticality values (SPEC-01 / registry.schema.json). */
const CRITICALITY_SET = new Set(['safety', 'compliance', 'normal']);

// ---------------------------------------------------------------------------
// Pure scan: buildRegistry
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RegistryArtifact
 * @property {string} uid
 * @property {string} kind
 * @property {string} id
 * @property {string} path
 * @property {string} contentHash
 * @property {number} revision
 * @property {string} version
 * @property {string} status
 * @property {string} criticality
 * @property {string} owner
 * @property {string} description
 * @property {string[]} tags
 * @property {string[]} modules
 * @property {string[]} dependsOn
 * @property {Object} eval
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Registry
 * @property {number} schemaVersion
 * @property {string} VERSION
 * @property {string} generatedAt
 * @property {RegistryArtifact[]} artifacts
 * @property {string[]} danglingRefs
 */

/**
 * @typedef {Registry & {findings: import('./lib/findings.mjs').Finding[]}} BuildResult
 * The freshly-scanned registry object, with an attached `findings` array (the
 * fail-open per-file findings). The five SPEC-01 keys serialize to disk; `findings`
 * is dropped on every persist path.
 */

/**
 * Build a registry by scanning `rootDir`, carrying identity forward from
 * `priorRegistry` for unchanged artifacts. PURE: no I/O writes, never throws.
 *
 * Determinism / idempotence (BR-REG-006, EVAL-REG-006): `createdAt`, `revision`
 * and `version` are carried from the prior record for an UNCHANGED artifact (same
 * `contentHash`); the snapshot's `generatedAt` is preserved from the prior snapshot
 * when the resulting artifact array is byte-identical to the prior one, so two
 * rebuilds of an unchanged tree are byte-identical and append zero log lines.
 *
 * @param {string} rootDir Absolute FORGE_ROOT (or a fixture sandbox root).
 * @param {Registry|null} [priorRegistry] The committed registry, if any.
 * @returns {BuildResult} The new registry object (5 SPEC-01 keys) with an attached
 *   `findings` array. The registry is returned DIRECTLY (not nested under a key) so a
 *   caller can read `result.artifacts` and `result.findings` straight off it.
 */
export function buildRegistry(rootDir, priorRegistry = null) {
  /** @type {import('./lib/findings.mjs').Finding[]} */
  const findings = [];
  /** @type {RegistryArtifact[]} */
  const artifacts = [];

  // Prior records keyed by uid, for carry-forward of identity/timestamps.
  const prior = priorAsMap(priorRegistry);

  let nowIso;
  try {
    nowIso = new Date().toISOString();
  } catch {
    nowIso = new Date(0).toISOString();
  }

  // --- 1. On-disk artifacts (the walk surface) -----------------------------
  const seenUids = new Set();
  let files = [];
  try {
    files = walkLibrary(rootDir);
  } catch {
    files = []; // fail-open
  }
  for (const { absPath, relPath } of files) {
    let cls = null;
    try {
      cls = pathToUid(rootDir, relPath);
    } catch {
      cls = null;
    }
    if (!cls) continue; // not a recognised artifact location (run-all.mjs, README, …)
    const uid = `${cls.kind}:${cls.id}`;

    const rec = buildOnDiskRecord({
      rootDir,
      uid,
      cls,
      relPath,
      absPath,
      prior: prior.get(uid) || null,
      nowIso,
      findings,
    });
    if (!rec) continue; // malformed → finding already recorded, skip (fail-open)
    if (seenUids.has(uid)) continue; // dedupe (defensive)
    seenUids.add(uid);
    artifacts.push(rec);
  }

  // --- 2. Hooks (declared in hooks.json, NOT walked as files) ---------------
  for (const rec of buildHookRecords({ rootDir, prior, nowIso })) {
    if (seenUids.has(rec.uid)) continue;
    seenUids.add(rec.uid);
    artifacts.push(rec);
  }

  // --- 3. Reverse-index modules.json → uid → [modules] ----------------------
  const moduleIndex = buildModuleIndex(rootDir);

  // --- 4. Planned components (named in a manifest, no on-disk artifact) ------
  for (const planned of plannedRecords({
    rootDir,
    moduleIndex,
    seenUids,
    prior,
    nowIso,
  })) {
    if (seenUids.has(planned.uid)) continue;
    seenUids.add(planned.uid);
    artifacts.push(planned);
  }

  // --- 5. Attach modules[] (reverse-index) ----------------------------------
  for (const a of artifacts) {
    const mods = moduleIndex.get(a.uid);
    a.modules = mods ? [...mods].sort() : [];
  }

  // --- 6. Sort by uid (BR-REG-006) ------------------------------------------
  artifacts.sort((x, y) => (x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0));

  // --- 6b. Dependency graph (SPEC-03, BR-DEP): typed edges → per-record
  //         dependsOn[] (resolved outbound) + registry danglingRefs[] (unresolved).
  //         PURE + fail-open: a graph failure degrades to empty deps, never aborts.
  let danglingRefs = [];
  try {
    const graph = computeGraph(rootDir, artifacts);
    for (const a of artifacts) {
      const deps = graph.dependsOn.get(a.uid);
      a.dependsOn = deps ? [...deps] : [];
    }
    danglingRefs = Array.isArray(graph.danglingRefs) ? graph.danglingRefs : [];
  } catch {
    for (const a of artifacts) a.dependsOn = [];
    danglingRefs = [];
  }

  // --- 7. Decide generatedAt: preserve prior when the artifact set is byte-
  //        identical so two unchanged rebuilds are byte-identical (EVAL-REG-006).
  const priorArtifacts = priorRegistry && Array.isArray(priorRegistry.artifacts)
    ? priorRegistry.artifacts
    : null;
  let generatedAt = nowIso;
  if (
    priorArtifacts &&
    typeof priorRegistry.generatedAt === 'string' &&
    artifactsByteEqual(priorArtifacts, artifacts)
  ) {
    generatedAt = priorRegistry.generatedAt;
  }

  const registry = stampSchemaVersion(
    {
      VERSION: stripDesign(readRawVersion(rootDir)),
      generatedAt,
      artifacts,
      danglingRefs, // SPEC-03 (v0.3): unresolved typed edges (BR-DEP-003)
    },
    REGISTRY_SCHEMA_VERSION,
  );
  // stampSchemaVersion sets schemaVersion last; re-order keys to the SPEC-01 layout
  // (schemaVersion, VERSION, generatedAt, artifacts, danglingRefs) for stable bytes.
  // `findings` is attached as a SIXTH property for the build callers/tests; every
  // PERSIST path rebuilds a fresh 5-key object, so `findings` never leaks to disk.
  const ordered = {
    schemaVersion: registry.schemaVersion,
    VERSION: registry.VERSION,
    generatedAt: registry.generatedAt,
    artifacts: registry.artifacts,
    danglingRefs: registry.danglingRefs,
    findings,
  };

  return /** @type {Registry & {findings: import('./lib/findings.mjs').Finding[]}} */ (ordered);
}

/**
 * Build one on-disk artifact record, fail-open. Returns null (after recording a
 * single finding) when the file cannot yield a complete record.
 *
 * @param {Object} p
 * @param {string} p.rootDir
 * @param {string} p.uid
 * @param {{kind:string,id:string}} p.cls
 * @param {string} p.relPath
 * @param {string} p.absPath
 * @param {RegistryArtifact|null} p.prior
 * @param {string} p.nowIso
 * @param {import('./lib/findings.mjs').Finding[]} p.findings
 * @returns {RegistryArtifact|null}
 */
function buildOnDiskRecord({ rootDir, uid, cls, relPath, absPath, prior, nowIso, findings }) {
  let bytes;
  try {
    // Lazy require of fs only here keeps the rest of the module fs-free (state via store).
    bytes = readFileBytes(absPath);
  } catch {
    findings.push(
      makeFinding({
        level: 'ERROR',
        path: relPath,
        line: null,
        message: `unreadable artifact: ${uid}`,
        source: SOURCE,
      }),
    );
    return null;
  }

  const text = bytes.toString('utf8');
  const fm = parseFrontmatter(text);

  // A markdown artifact that opens a frontmatter fence it never closes is
  // malformed: skip it with one finding (BR-REG-010). Non-markdown artifacts
  // (validators, engine scripts, meta-tests) legitimately have no frontmatter.
  if (isMarkdownKind(cls.kind) && !fm.present && opensUnclosedFence(text)) {
    findings.push(
      makeFinding({
        level: 'ERROR',
        path: relPath,
        line: 1,
        message: `malformed frontmatter (unclosed fence): ${uid} — skipped`,
        source: SOURCE,
      }),
    );
    return null;
  }

  const contentHash = sha256hex(bytes);
  // A bundle's integer frontmatter `version: N` maps to semver "N.0.0" (BR-VER-008),
  // used as the SEED for a brand-new bundle record (the registry stays authoritative
  // once the record exists — carry-forward wins for any prior record).
  const seedVersion =
    cls.kind === 'bundle' && fm.data ? bundleIntegerToSemver(fm.data.version) : null;
  const identity = carryIdentity(prior, contentHash, nowIso, seedVersion);

  return assembleRecord({
    uid,
    kind: cls.kind,
    id: cls.id,
    relPath,
    contentHash,
    fm: fm.data || {},
    status: 'active',
    identity,
  });
}

/**
 * Build hook records from `hooks/hooks.json` (declared, not walked). One record per
 * declared hook id; path is `hooks/hooks.json#<id>`, contentHash is over the id (a
 * stable per-hook identity at v0.2 — the canonical-entry hash is refined later).
 *
 * @param {Object} p
 * @param {string} p.rootDir
 * @param {Map<string,RegistryArtifact>} p.prior
 * @param {string} p.nowIso
 * @returns {RegistryArtifact[]}
 */
function buildHookRecords({ rootDir, prior, nowIso }) {
  /** @type {RegistryArtifact[]} */
  const out = [];
  let ids;
  try {
    ids = loadDeclaredHookIds(rootDir);
  } catch {
    return out;
  }
  // loadDeclaredHookIds records id + bare + bare@event forms; keep only the
  // canonical namespaced ids (those containing a ':').
  const canonical = [...ids].filter((s) => typeof s === 'string' && s.includes(':') && !s.includes('@'));
  const seen = new Set();
  for (const hookId of canonical) {
    if (seen.has(hookId)) continue;
    seen.add(hookId);
    const uid = `hook:${hookId}`;
    const relPath = `hooks/hooks.json#${hookId}`;
    const contentHash = sha256hex(hookId);
    const identity = carryIdentity(prior.get(uid) || null, contentHash, nowIso);
    out.push(
      assembleRecord({
        uid,
        kind: 'hook',
        id: hookId,
        relPath,
        contentHash,
        fm: {},
        status: 'active',
        identity,
      }),
    );
  }
  return out;
}

/**
 * Produce records for PLANNED components: a manifest names a (kind, name) whose
 * artifact has no on-disk file (and isn't an already-seen hook). status:"planned",
 * not an error (BR-REG-005).
 *
 * @param {Object} p
 * @param {string} p.rootDir
 * @param {Map<string,Set<string>>} p.moduleIndex uid → module names
 * @param {Set<string>} p.seenUids already-recorded uids
 * @param {Map<string,RegistryArtifact>} p.prior
 * @param {string} p.nowIso
 * @returns {RegistryArtifact[]}
 */
function plannedRecords({ rootDir, moduleIndex, seenUids, prior, nowIso }) {
  /** @type {RegistryArtifact[]} */
  const out = [];
  for (const uid of moduleIndex.keys()) {
    if (seenUids.has(uid)) continue; // already recorded (on-disk or hook)
    const colon = uid.indexOf(':');
    if (colon <= 0) continue;
    const kind = uid.slice(0, colon);
    const id = uid.slice(colon + 1);
    // Planned record carries a stable identity seed; its contentHash is over the uid
    // (there is no file to hash). Carry forward from prior if present.
    const contentHash = sha256hex(`planned:${uid}`);
    const identity = carryIdentity(prior.get(uid) || null, contentHash, nowIso);
    const relPath = plannedPath(rootDir, kind, id);
    out.push(
      assembleRecord({
        uid,
        kind,
        id,
        relPath,
        contentHash,
        fm: {},
        status: 'planned',
        identity,
      }),
    );
  }
  return out;
}

/**
 * Assemble a complete SPEC-01 record with keys in a FIXED order (so the JSON bytes
 * are stable across builds — BR-REG-006). Frontmatter supplies owner/description/
 * tags/criticality; version is the registry's (carried) value, never frontmatter's
 * advisory mirror (BR-VER-008, registry authoritative).
 *
 * @param {Object} p
 * @param {string} p.uid
 * @param {string} p.kind
 * @param {string} p.id
 * @param {string} p.relPath
 * @param {string} p.contentHash
 * @param {Object} p.fm parsed frontmatter data
 * @param {string} p.status
 * @param {{revision:number,version:string,createdAt:string,updatedAt:string}} p.identity
 * @returns {RegistryArtifact}
 */
function assembleRecord({ uid, kind, id, relPath, contentHash, fm, status, identity }) {
  const fmStatus = typeof fm.status === 'string' && STATUS_SET.has(fm.status) ? fm.status : null;
  const effectiveStatus =
    status === 'planned'
      ? 'planned'
      : fmStatus && fmStatus !== 'planned'
        ? fmStatus
        : 'active';

  const criticality =
    typeof fm.criticality === 'string' && CRITICALITY_SET.has(fm.criticality)
      ? fm.criticality
      : DEFAULT_CRITICALITY;

  const owner = typeof fm.owner === 'string' && fm.owner.length > 0 ? fm.owner : 'forge';
  const description = typeof fm.description === 'string' ? fm.description : '';
  const tags = Array.isArray(fm.tags) ? dedupeStrings(fm.tags) : [];

  return {
    uid,
    kind,
    id,
    path: relPath,
    contentHash,
    revision: identity.revision,
    version: identity.version,
    status: effectiveStatus,
    criticality,
    owner,
    description,
    tags,
    modules: [], // filled by the reverse-index pass
    dependsOn: [], // SPEC-03 (v0.3)
    eval: {}, // linkage slot; payload owned by Bundle E
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  };
}

/**
 * Decide an artifact's carried identity. UNCHANGED (same contentHash as prior) →
 * carry revision/version/createdAt/updatedAt verbatim (so the bytes are stable and
 * no log line is appended). New artifact → seed rev 1 / 0.1.0 with fresh timestamps.
 * Content CHANGED vs prior → keep prior createdAt, carry prior revision/version
 * (the bump-detection + log-append is handled by the writer, not here), set
 * updatedAt to now.
 *
 * NOTE: `buildRegistry` is pure and does not advance the revision — revision
 * advancement on a content change is applied by the WRITER (`persistBuild`) so the
 * dry-run snapshot mirrors exactly what would be written.
 *
 * @param {RegistryArtifact|null} prior
 * @param {string} contentHash
 * @param {string} nowIso
 * @param {string|null} [seedVersion] override seed version for a NEW artifact (e.g. bundle "N.0.0")
 * @returns {{revision:number,version:string,createdAt:string,updatedAt:string,changed:boolean,new:boolean}}
 */
function carryIdentity(prior, contentHash, nowIso, seedVersion = null) {
  if (!prior) {
    return {
      revision: SEED_REVISION,
      version: typeof seedVersion === 'string' && seedVersion.length > 0 ? seedVersion : SEED_VERSION,
      createdAt: nowIso,
      updatedAt: nowIso,
      changed: false,
      new: true,
    };
  }
  const priorHash = typeof prior.contentHash === 'string' ? prior.contentHash : '';
  const priorRev = Number.isInteger(prior.revision) && prior.revision >= 1 ? prior.revision : SEED_REVISION;
  const priorVer = typeof prior.version === 'string' && prior.version.length > 0 ? prior.version : SEED_VERSION;
  const priorCreated = typeof prior.createdAt === 'string' && prior.createdAt.length > 0 ? prior.createdAt : nowIso;
  const priorUpdated = typeof prior.updatedAt === 'string' && prior.updatedAt.length > 0 ? prior.updatedAt : nowIso;

  if (priorHash === contentHash) {
    // Unchanged: byte-identical carry-forward.
    return {
      revision: priorRev,
      version: priorVer,
      createdAt: priorCreated,
      updatedAt: priorUpdated,
      changed: false,
      new: false,
    };
  }
  // Content changed: keep created, carry rev/ver (writer bumps), refresh updatedAt.
  return {
    revision: priorRev,
    version: priorVer,
    createdAt: priorCreated,
    updatedAt: nowIso,
    changed: true,
    new: false,
  };
}

// ---------------------------------------------------------------------------
// Module reverse-index
// ---------------------------------------------------------------------------

/**
 * Reverse-index `manifests/modules.json`: `module → components` becomes
 * `uid → Set<module>`. Resolves each named component to the SAME uid the artifact
 * record carries (via componentCandidates → pathToUid), so the index and the records
 * never disagree (BR-REG-003). Hooks map by declared id.
 *
 * @param {string} rootDir
 * @returns {Map<string,Set<string>>}
 */
function buildModuleIndex(rootDir) {
  /** @type {Map<string,Set<string>>} */
  const index = new Map();
  let modulesDoc;
  try {
    modulesDoc = readJson(path.join(rootDir, 'manifests', 'modules.json'));
  } catch {
    modulesDoc = null;
  }
  if (!modulesDoc || typeof modulesDoc !== 'object') return index;
  const modules = modulesDoc.modules && typeof modulesDoc.modules === 'object' ? modulesDoc.modules : {};

  let hookIds;
  try {
    hookIds = loadDeclaredHookIds(rootDir);
  } catch {
    hookIds = new Set();
  }

  for (const [moduleName, mDef] of Object.entries(modules)) {
    const comps = mDef && mDef.components && typeof mDef.components === 'object' ? mDef.components : {};
    for (const [kind, names] of Object.entries(comps)) {
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        const uid = componentUid(rootDir, kind, String(name), hookIds);
        if (!uid) continue;
        let set = index.get(uid);
        if (!set) {
          set = new Set();
          index.set(uid, set);
        }
        set.add(moduleName);
      }
    }
  }
  return index;
}

/**
 * Resolve a manifest (kind, name) pair to the uid the registry record carries.
 * Reuses componentCandidates + pathToUid so the mapping is identical to the scan.
 *
 * @param {string} rootDir
 * @param {string} kind plural component kind (agents/skills/rules/hooks/…)
 * @param {string} name component name as written in modules.json
 * @param {Set<string>} hookIds declared hook ids (id + bare + bare@event forms)
 * @returns {string|null}
 */
function componentUid(rootDir, kind, name, hookIds) {
  if (kind === 'hooks') {
    const base = name.split('@')[0];
    // Resolve to a declared namespaced id (hook:<id>).
    for (const candidate of [name, base, `forge:${base}`]) {
      if (hookIds.has(candidate)) {
        // Find the canonical namespaced form.
        if (candidate.includes(':')) return `hook:${candidate.split('@')[0]}`;
      }
    }
    // Fall back: if a `forge:<base>` style id is declared, use it.
    if (hookIds.has(`forge:${base}`)) return `hook:forge:${base}`;
    // Planned hook (named but not declared): key by the bare base under hook:.
    return `hook:${base}`;
  }
  let candidates = [];
  try {
    candidates = componentCandidates(rootDir, kind, name);
  } catch {
    candidates = [];
  }
  for (const cand of candidates) {
    if (cand === '__HOOK__') continue;
    const cls = pathToUid(rootDir, cand);
    if (cls) return `${cls.kind}:${cls.id}`;
  }
  return null;
}

/**
 * The repo-relative path a PLANNED component would occupy (best-effort, for display).
 * @param {string} rootDir
 * @param {string} kind singular registry kind
 * @param {string} id
 * @returns {string}
 */
function plannedPath(rootDir, kind, id) {
  switch (kind) {
    case 'agent':
      return `agents/${id}.md`;
    case 'skill':
      return `skills/${id}/SKILL.md`;
    case 'command':
      return `commands/${id}.md`;
    case 'rule':
      return `rules/${id}.md`;
    case 'bundle':
      return `bundles/${id}.md`;
    case 'workflow':
      return `workflows/${id}.md`;
    case 'mcp':
      return `mcp/${id}.json`;
    case 'validator':
      return `lint/${id}.mjs`;
    case 'meta-test':
      return `tests/meta/${id}.mjs`;
    case 'engine':
      return `${id}.mjs`;
    case 'hook':
      return `hooks/hooks.json#${id}`;
    default:
      return `${kind}/${id}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** @param {Registry|null} reg @returns {Map<string,RegistryArtifact>} */
function priorAsMap(reg) {
  /** @type {Map<string,RegistryArtifact>} */
  const m = new Map();
  const arr = reg && Array.isArray(reg.artifacts) ? reg.artifacts : [];
  for (const a of arr) {
    if (a && typeof a.uid === 'string') m.set(a.uid, a);
  }
  return m;
}

/**
 * Markdown-frontmatter-bearing kinds (the ones we parse frontmatter for).
 * NOTE: `mcp` is intentionally EXCLUDED — an mcp component is a JSON config snippet
 * (mcp/<name>.json) with NO frontmatter; like `validator`/`engine`/`meta-test` it is
 * hashed over its raw bytes and never frontmatter-parsed.
 */
function isMarkdownKind(kind) {
  return (
    kind === 'agent' ||
    kind === 'skill' ||
    kind === 'command' ||
    kind === 'rule' ||
    kind === 'bundle' ||
    kind === 'workflow'
  );
}

/** True when the text opens a `---` frontmatter fence that is never closed. */
function opensUnclosedFence(text) {
  if (typeof text !== 'string') return false;
  const clean = text.replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(clean)) return false;
  // A well-formed block matches splitFrontmatter's regex; if present===false yet it
  // opens with a fence, the closing `---` is missing.
  return !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n[\s\S]*)?$/.test(clean);
}

/** Deduplicate a string list preserving first-seen order. */
function dedupeStrings(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (typeof s !== 'string') continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Byte-equality of two artifact arrays by their JSON serialization (the stable,
 * key-ordered records make this a faithful proxy for snapshot identity).
 * @param {any[]} a @param {any[]} b
 */
function artifactsByteEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Read raw VERSION file text: rootDir's VERSION when present (forge root, fixture
 * sandboxes), else THIS forge installation's VERSION (registry builds run against a
 * project root have no VERSION file — stamping 0.0.0 made doctor's drift warning
 * permanently unclearable). Fail-open to "0.0.0" only when neither resolves.
 */
function readRawVersion(rootDir) {
  const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const dir of [rootDir, installRoot]) {
    try {
      const raw = readFileText(path.join(dir, 'VERSION'));
      const v = (raw || '').trim();
      if (v) return v;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

/** Strip a trailing `-design` suffix (mirrors bin/forge.mjs#forgeVersion). */
function stripDesign(v) {
  return typeof v === 'string' && v.endsWith('-design') ? v.slice(0, -'-design'.length) : v;
}

// fs access is confined to these two tiny readers + the bytes reader. State writes
// always route through store.mjs; these are pure library-content reads (not state).
/** @param {string} p @returns {Buffer} */
function readFileBytes(p) {
  return fs.readFileSync(p);
}
/** @param {string} p @returns {string} */
function readFileText(p) {
  return fs.readFileSync(p, 'utf8');
}

/**
 * Create the JSONL log file empty if it does not already exist (never truncates an
 * existing file). Parent dirs are created as needed. Fail-open: any error is ignored.
 * @param {string} p
 */
function ensureLogFile(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 'a' (append) creates the file if absent and never truncates an existing one.
    fs.closeSync(fs.openSync(p, 'a'));
  } catch {
    /* fail-open */
  }
}

// ---------------------------------------------------------------------------
// Versioning: semver bump
// ---------------------------------------------------------------------------

/**
 * Apply a semver bump level to a version string (BR-VER-002). Tolerant of a
 * non-semver input (coerces missing parts to 0). Never throws.
 *
 * @param {string} version base version (e.g. "1.2.3")
 * @param {'major'|'minor'|'patch'} level
 * @returns {string}
 */
export function bumpSemver(version, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim());
  let major = m ? Number(m[1]) : 0;
  let minor = m ? Number(m[2]) : 0;
  let patch = m ? Number(m[3]) : 0;
  if (level === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1; // default/patch
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * Map a bundle's integer (or numeric-string) version to semver "N.0.0" (BR-VER-008).
 * @param {unknown} v
 * @returns {string|null} the semver string, or null when v is not a bare integer.
 */
export function bundleIntegerToSemver(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return `${v}.0.0`;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return `${v.trim()}.0.0`;
  return null;
}

// ---------------------------------------------------------------------------
// Writer: persist a build (atomic snapshot + append-only log)
// ---------------------------------------------------------------------------

/**
 * Persist a freshly-built registry to `<root>/.forge/registry.json` and append a
 * mutation log line for every artifact whose contentHash CHANGED vs the prior
 * committed registry (a new artifact's first appearance is also a change). Appends
 * ZERO lines when nothing changed (EVAL-REG-006). Atomic + advisory-locked via
 * store.mjs. Returns whether the snapshot was written and how many log lines landed.
 *
 * For a CHANGED (already-existing) artifact this is where revision advances by 1
 * and the log `from`/`to` triple is recorded — keeping `buildRegistry` pure.
 *
 * @param {string} rootDir
 * @param {Registry} priorRegistry the committed registry (or null)
 * @param {Registry} builtRegistry the freshly-built registry (dry-run output)
 * @returns {{wrote:boolean, logLines:number, registry:Registry, changedUids:string[]}}
 */
export function persistBuild(rootDir, priorRegistry, builtRegistry) {
  const dir = forgeStateDir(rootDir);
  const regPath = path.join(dir, 'registry.json');
  const logPath = path.join(dir, 'registry.log.jsonl');

  const prior = priorAsMap(priorRegistry);
  let nowIso;
  try {
    nowIso = new Date().toISOString();
  } catch {
    nowIso = new Date(0).toISOString();
  }

  /** @type {Array<{ts:string,uid:string,from:any,to:any,reason:string,evalStatus:string}>} */
  const logEntries = [];
  /** @type {string[]} */
  const changedUids = [];

  // Walk the built artifacts; for each, decide whether it changed vs prior and, if
  // so, advance its revision and stage a log line. We mutate the built record in
  // place (it is the snapshot we are about to write).
  //
  // A brand-NEW artifact seeds SILENTLY (no log line): a registry being born, or an
  // artifact appearing for the first time, is a seed — not a per-artifact CHANGE. The
  // changelog (registry.log.jsonl filtered by uid, BR-VER-005) therefore records only
  // genuine content changes and authored bumps, never the seed. The log FILE is still
  // created on the first --write so it exists (BR-REG-001), just with zero seed lines.
  for (const rec of builtRegistry.artifacts) {
    const before = prior.get(rec.uid) || null;
    if (!before) continue; // new artifact — seeded silently, no log line
    const priorHash = typeof before.contentHash === 'string' ? before.contentHash : '';
    if (priorHash !== rec.contentHash) {
      // Content changed: advance revision by 1, refresh updatedAt, log from→to.
      const fromRev = Number.isInteger(before.revision) && before.revision >= 1 ? before.revision : SEED_REVISION;
      const fromVer = typeof before.version === 'string' && before.version.length > 0 ? before.version : SEED_VERSION;
      rec.revision = fromRev + 1;
      rec.updatedAt = nowIso;
      logEntries.push({
        ts: nowIso,
        uid: rec.uid,
        from: { hash: priorHash, rev: fromRev, ver: fromVer },
        to: { hash: rec.contentHash, rev: rec.revision, ver: rec.version },
        reason: 'registry build (content changed)',
        evalStatus: 'U',
      });
      changedUids.push(rec.uid);
    }
  }

  // If the artifact set changed (any mutation), refresh generatedAt to now so the
  // snapshot reflects the change; otherwise keep whatever buildRegistry decided
  // (which preserved the prior generatedAt for byte-identical idempotence).
  if (changedUids.length > 0) {
    builtRegistry.generatedAt = nowIso;
  }

  const toWrite = stampSchemaVersion(
    {
      VERSION: builtRegistry.VERSION,
      generatedAt: builtRegistry.generatedAt,
      artifacts: builtRegistry.artifacts,
      danglingRefs: builtRegistry.danglingRefs || [],
    },
    REGISTRY_SCHEMA_VERSION,
  );
  const orderedWrite = {
    schemaVersion: toWrite.schemaVersion,
    VERSION: toWrite.VERSION,
    generatedAt: toWrite.generatedAt,
    artifacts: toWrite.artifacts,
    danglingRefs: toWrite.danglingRefs,
  };

  const wrote = writeJsonAtomic(regPath, orderedWrite);
  let logLines = 0;
  if (wrote) {
    // Ensure the append-only log FILE exists after the first --write (BR-REG-001),
    // even when there are zero mutation lines to append (a pure seed build). This is
    // additive and idempotent — `ensureLogFile` never truncates an existing log.
    ensureLogFile(logPath);
    for (const entry of logEntries) {
      if (appendJsonl(logPath, entry)) logLines += 1;
    }
  }
  return { wrote, logLines, registry: /** @type {Registry} */ (orderedWrite), changedUids };
}

/**
 * Author a bump (BR-VER-003): recompute the on-disk contentHash, advance revision
 * by 1, apply the semver level, set updatedAt, append one log line, persist. Returns
 * a result object describing the change. Dry-run when `write` is false (no I/O).
 *
 * @param {string} rootDir
 * @param {string} uid
 * @param {'major'|'minor'|'patch'} level
 * @param {{write?:boolean}} [opts]
 * @returns {{ok:boolean, record:RegistryArtifact|null, finding?:import('./lib/findings.mjs').Finding}}
 */
export function bumpArtifact(rootDir, uid, level, opts = {}) {
  const dir = forgeStateDir(rootDir);
  const regPath = path.join(dir, 'registry.json');
  const logPath = path.join(dir, 'registry.log.jsonl');
  const snap = readJson(regPath);
  if (!snap || !Array.isArray(snap.artifacts)) {
    return { ok: false, record: null };
  }
  const rec = snap.artifacts.find((a) => a && a.uid === uid);
  if (!rec) {
    return {
      ok: false,
      record: null,
      finding: makeFinding({ level: 'WARN', path: 'registry.json', line: null, message: `unknown uid: ${uid}`, source: SOURCE }),
    };
  }

  let nowIso;
  try {
    nowIso = new Date().toISOString();
  } catch {
    nowIso = new Date(0).toISOString();
  }

  const fromHash = typeof rec.contentHash === 'string' ? rec.contentHash : '';
  const fromRev = Number.isInteger(rec.revision) && rec.revision >= 1 ? rec.revision : SEED_REVISION;
  const fromVer = typeof rec.version === 'string' && rec.version.length > 0 ? rec.version : SEED_VERSION;

  // Recompute contentHash from the on-disk artifact (best-effort; hooks/planned keep prior).
  let newHash = fromHash;
  try {
    const abs = onDiskPathForRecord(rootDir, rec);
    if (abs) newHash = sha256hex(readFileBytes(abs));
  } catch {
    newHash = fromHash;
  }

  rec.contentHash = newHash;
  rec.revision = fromRev + 1;
  rec.version = bumpSemver(fromVer, level);
  rec.updatedAt = nowIso;

  if (opts.write) {
    const wrote = writeJsonAtomic(regPath, snap);
    if (wrote) {
      appendJsonl(logPath, {
        ts: nowIso,
        uid,
        from: { hash: fromHash, rev: fromRev, ver: fromVer },
        to: { hash: rec.contentHash, rev: rec.revision, ver: rec.version },
        reason: `bump --${level}`,
        evalStatus: 'U',
      });
    }
  }
  return { ok: true, record: rec };
}

/** Resolve a record's on-disk absolute path (null for hook/planned). */
function onDiskPathForRecord(rootDir, rec) {
  if (!rec || typeof rec.path !== 'string') return null;
  if (rec.path.includes('#')) return null; // hook pseudo-path
  if (rec.status === 'planned') return null;
  return path.join(rootDir, rec.path);
}

// ---------------------------------------------------------------------------
// VERSION roll-up (pure fold; v0.2 ships the preview side)
// ---------------------------------------------------------------------------

/**
 * Fold the committed registry's sorted-by-uid `{revision, contentHash}` list into a
 * deterministic VERSION string (BR-VER-004). PURE: identical input → identical
 * output, invariant under artifact ordering (we sort by uid first).
 *
 * v0.2 ships only this read-only preview; the compute-and-write automation is v0.6.
 * The fold here is intentionally simple and stable, not the final semver policy.
 *
 * @param {Registry|null} registry
 * @returns {{VERSION:string}}
 */
export function rollUp(registry) {
  const arr = registry && Array.isArray(registry.artifacts) ? [...registry.artifacts] : [];
  arr.sort((a, b) => {
    const ax = a && typeof a.uid === 'string' ? a.uid : '';
    const bx = b && typeof b.uid === 'string' ? b.uid : '';
    return ax < bx ? -1 : ax > bx ? 1 : 0;
  });
  const material = arr.map((a) => `${a && a.uid}:${a && a.revision}:${a && a.contentHash}`).join('\n');
  const digest = sha256hex(material);
  // Derive a stable, deterministic semver-shaped preview from the fold digest.
  const n = parseInt(digest.slice(0, 6), 16);
  const VERSION = `0.${(n >> 8) & 0xff}.${n & 0xff}`;
  return { VERSION };
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * Normalise the heterogeneous `ctx`/`args` shapes the dispatcher and the tests pass
 * into a single { rootDir, write } pair. The tests pass `args` as a string[] (e.g.
 * ['--write']) and a ctx carrying `{ root|forgeRoot|cwd, write }`.
 *
 * @param {any} args
 * @param {any} ctx
 * @returns {{rootDir:string, write:boolean, positional:string[], flags:Set<string>}}
 */
function normalize(args, ctx) {
  const flags = new Set();
  const positional = [];
  const argList = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  // Value-taking options whose FOLLOWING token is a value, NOT a positional. Without
  // this, `ls --kind agents` would treat "agents" as a trailing positional and use it
  // as the rootDir (reading <cwd>/agents/.forge), so `ls --kind <k>` / `changed --since
  // <ref>` returned nothing when run from the project cwd (EVAL-REG-009). The `=`-joined
  // forms (`--kind=agents`) carry their own value and need no skip.
  const VALUE_OPTS = new Set(['kind', 'since']);
  for (let i = 0; i < argList.length; i++) {
    const a = argList[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      flags.add(name.includes('=') ? name.slice(0, name.indexOf('=')) : name);
      // Skip the value token of a space-separated value-option so it is not
      // mis-collected as a positional (and then mistaken for rootDir).
      if (VALUE_OPTS.has(name) && i + 1 < argList.length && !String(argList[i + 1]).startsWith('--')) {
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  // ctx.flags may be a Set (dispatcher) carrying write/apply.
  if (ctx && ctx.flags instanceof Set) {
    for (const f of ctx.flags) flags.add(f);
  }
  const write = flags.has('write') || flags.has('apply') || (ctx && (ctx.write === true || ctx.apply === true));
  const rootDir =
    (ctx && (ctx.FORGE_ROOT || ctx.forgeRoot || ctx.root || ctx.cwd)) ||
    (positional.length && positional[positional.length - 1]) ||
    process.cwd();
  return { rootDir, write: !!write, positional, flags };
}

/** Read the committed registry snapshot (or null). */
function readCommitted(rootDir) {
  return readJson(path.join(forgeStateDir(rootDir), 'registry.json'));
}

/** Read the committed registry log (or []). */
function readCommittedLog(rootDir) {
  return readJsonl(path.join(forgeStateDir(rootDir), 'registry.log.jsonl'));
}

/**
 * C4 entry. NEVER writes stdout. Returns { ok, data, findings, summary }. Fail-open:
 * any internal failure degrades to an empty, ok-ish result rather than throwing.
 *
 * Subcommands: build [--write], ls [--kind], show <uid>, changed --since <snap>,
 * diff <a> <b>, bump <uid> --level, roll-up.
 *
 * @param {string} subcmd
 * @param {any} args  string[] | { positional, flags, opts }
 * @param {any} ctx   { FORGE_ROOT|forgeRoot|root|cwd, flags?, write?, apply? }
 * @returns {Promise<{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const { rootDir, write, positional, flags } = normalize(args, ctx);
    const optOf = (name) => optionValue(args, ctx, name, positional);

    switch (subcmd) {
      case 'build':
        return doBuild(rootDir, write);
      case 'ls':
        return doLs(rootDir, optOf('kind'));
      case 'show':
        return doShow(rootDir, positional[0]);
      case 'changed':
        return doChanged(rootDir, optOf('since'));
      case 'diff':
        return doDiff(positional[0], positional[1]);
      case 'bump':
        return doBump(rootDir, positional[0], levelFromFlags(flags), write);
      case 'roll-up':
        return doRollUp(rootDir);
      case 'deps':
        return doDeps(rootDir, positional[0]);
      case 'rdeps':
        return doRdeps(rootDir, positional[0]);
      case 'orphans':
        return doOrphans(rootDir);
      case 'dangling':
        return doDangling(rootDir);
      default:
        return result(false, { usage: usageText() }, [
          makeFinding({ level: 'ERROR', path: 'registry', line: null, message: `unknown registry subcommand: ${subcmd || '(none)'}`, source: 'registry' }),
        ]);
    }
  } catch (e) {
    // Fail-open: never throw past run().
    return result(false, null, [
      makeFinding({ level: 'ERROR', path: 'registry', line: null, message: `registry error: ${e && e.message ? e.message : String(e)}`, source: 'registry' }),
    ]);
  }
}

/** Build (dry-run unless write). */
function doBuild(rootDir, write) {
  const prior = readCommitted(rootDir);
  const built = buildRegistry(rootDir, prior);
  const findings = built.findings || [];
  if (!write) {
    return result(findings.every((f) => f.level !== 'ERROR'), built, findings, {
      artifacts: built.artifacts.length,
      wrote: false,
    });
  }
  const { wrote, logLines, registry: persisted, changedUids } = persistBuild(rootDir, prior, built);
  return result(wrote, persisted, findings, {
    artifacts: persisted.artifacts.length,
    wrote,
    logLines,
    changed: changedUids.length,
  });
}

/** ls [--kind <plural-or-singular>]. */
function doLs(rootDir, kindFilter) {
  const reg = readCommitted(rootDir);
  const arr = reg && Array.isArray(reg.artifacts) ? reg.artifacts : [];
  const singular = kindFilter ? singularizeKind(kindFilter) : null;
  const filtered = singular ? arr.filter((a) => a.kind === singular) : arr;
  return result(true, { artifacts: filtered }, [], { artifacts: filtered.length });
}

/** show <uid> — the record plus its filtered changelog (BR-VER-005). */
function doShow(rootDir, uid) {
  if (!uid) {
    return result(false, null, [makeFinding({ level: 'ERROR', path: 'registry', line: null, message: 'show requires a <uid>', source: 'registry' })]);
  }
  const reg = readCommitted(rootDir);
  const arr = reg && Array.isArray(reg.artifacts) ? reg.artifacts : [];
  const record = arr.find((a) => a && a.uid === uid) || null;
  const log = readCommittedLog(rootDir).filter((l) => l && l.uid === uid);
  if (!record) {
    return result(false, { uid, record: null, changelog: log }, [
      makeFinding({ level: 'WARN', path: 'registry.json', line: null, message: `no record for uid: ${uid}`, source: 'registry' }),
    ]);
  }
  const withLog = { ...record, changelog: log };
  // Additively expose `changelog`/`record` at the top level so a caller probing the
  // return value directly (BR-VER-005 changelog accessor) finds the filtered log.
  return result(true, withLog, [], { changelog: log.length }, { changelog: log, record: withLog });
}

/**
 * changed --since <snapshotPath> — uids whose REVISION advanced vs the snapshot at
 * <snapshotPath>, compared against the current committed registry (snapshot-vs-current,
 * NOT git).
 */
function doChanged(rootDir, sincePath) {
  const current = readCommitted(rootDir);
  const since = sincePath ? readJson(path.isAbsolute(sincePath) ? sincePath : path.join(rootDir, sincePath)) : null;
  const curMap = priorAsMap(current);
  const sinceMap = priorAsMap(since);
  /** @type {string[]} */
  const changed = [];
  for (const [uid, cur] of curMap) {
    const prev = sinceMap.get(uid);
    const curRev = Number.isInteger(cur.revision) ? cur.revision : 0;
    const prevRev = prev && Number.isInteger(prev.revision) ? prev.revision : 0;
    if (!prev || curRev > prevRev) changed.push(uid);
  }
  changed.sort();
  return result(true, { changed }, [], { changed: changed.length });
}

/** diff <a> <b> — record-level diff of two snapshot files. */
function doDiff(aPath, bPath) {
  const a = aPath ? readJson(aPath) : null;
  const b = bPath ? readJson(bPath) : null;
  const am = priorAsMap(a);
  const bm = priorAsMap(b);
  const added = [];
  const removed = [];
  const changed = [];
  for (const uid of bm.keys()) if (!am.has(uid)) added.push(uid);
  for (const uid of am.keys()) if (!bm.has(uid)) removed.push(uid);
  for (const [uid, ra] of am) {
    const rb = bm.get(uid);
    if (rb && ra.contentHash !== rb.contentHash) changed.push(uid);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return result(true, { added, removed, changed }, [], {
    added: added.length,
    removed: removed.length,
    changed: changed.length,
  });
}

/** bump <uid> --level (dry-run unless write/apply). */
function doBump(rootDir, uid, level, write) {
  if (!uid) {
    return result(false, null, [makeFinding({ level: 'ERROR', path: 'registry', line: null, message: 'bump requires a <uid>', source: 'registry' })]);
  }
  const r = bumpArtifact(rootDir, uid, level, { write });
  const findings = r.finding ? [r.finding] : [];
  return result(r.ok, r.record, findings, { revision: r.record ? r.record.revision : null });
}

/** roll-up — pure VERSION fold preview. */
function doRollUp(rootDir) {
  const reg = readCommitted(rootDir);
  const { VERSION } = rollUp(reg);
  // Additively expose `VERSION` at the top level so a caller probing the return value
  // directly (BR-VER-004 roll-up purity) reads it without unwrapping `.data`.
  return result(true, { VERSION }, [], { VERSION }, { VERSION });
}

// ---------------------------------------------------------------------------
// SPEC-03 graph query verbs (read-only; computed from the committed snapshot)
// ---------------------------------------------------------------------------

/**
 * `deps <uid>` — outbound dependencies (the artifact's resolved dependsOn[]). Read-only.
 * The snapshot carries dependsOn[] per record (populated at build time).
 */
function doDeps(rootDir, uid) {
  if (!uid) {
    return result(false, null, [makeFinding({ level: 'ERROR', path: 'registry', line: null, message: 'deps requires a <uid>', source: SOURCE })]);
  }
  const reg = readCommitted(rootDir);
  const arr = reg && Array.isArray(reg.artifacts) ? reg.artifacts : [];
  const rec = arr.find((a) => a && a.uid === uid) || null;
  if (!rec) {
    return result(false, { uid, deps: [] }, [
      makeFinding({ level: 'WARN', path: 'registry.json', line: null, message: `no record for uid: ${uid}`, source: SOURCE }),
    ], { deps: 0 });
  }
  const deps = Array.isArray(rec.dependsOn) ? [...rec.dependsOn].sort() : [];
  return result(true, { uid, deps }, [], { deps: deps.length });
}

/**
 * `rdeps <uid>` — reverse-dependents / blast radius: every artifact whose dependsOn[]
 * contains <uid> (BR-DEP-005). Read-only. <uid> itself is never a reverse-dep of itself.
 */
function doRdeps(rootDir, uid) {
  if (!uid) {
    return result(false, null, [makeFinding({ level: 'ERROR', path: 'registry', line: null, message: 'rdeps requires a <uid>', source: SOURCE })]);
  }
  const reg = readCommitted(rootDir);
  const arr = reg && Array.isArray(reg.artifacts) ? reg.artifacts : [];
  /** @type {string[]} */
  const rdeps = [];
  for (const a of arr) {
    if (!a || a.uid === uid) continue;
    const d = Array.isArray(a.dependsOn) ? a.dependsOn : [];
    if (d.includes(uid)) rdeps.push(a.uid);
  }
  rdeps.sort();
  return result(true, { uid, rdeps }, [], { rdeps: rdeps.length });
}

/**
 * `orphans` — artifacts in NO module AND with ZERO inbound edges (BR-DEP-006). An
 * inbound edge is any other artifact's dependsOn[] containing this uid. Refines the
 * registry's coarse "in no module" flag: a reviewer reached only by prose handoff is
 * NOT an orphan. Hooks/planned/synthetic kinds are excluded. Read-only.
 */
function doOrphans(rootDir) {
  const reg = readCommitted(rootDir);
  const arr = reg && Array.isArray(reg.artifacts) ? reg.artifacts : [];
  // inbound[uid] = number of artifacts depending on it.
  const reachable = new Set();
  for (const a of arr) {
    const d = a && Array.isArray(a.dependsOn) ? a.dependsOn : [];
    for (const t of d) reachable.add(t);
  }
  /** @type {string[]} */
  const orphans = [];
  for (const a of arr) {
    if (!a || typeof a.uid !== 'string') continue;
    const inModule = Array.isArray(a.modules) && a.modules.length > 0;
    if (inModule) continue;
    if (reachable.has(a.uid)) continue; // has an inbound edge → not an orphan
    orphans.push(a.uid);
  }
  orphans.sort();
  return result(true, { orphans }, [], { orphans: orphans.length });
}

/**
 * `dangling` — list the registry's danglingRefs[] (BR-DEP-007). Each entry yields one
 * advisory WARN finding (C2, source:"validate-registry") naming the rawRef + sites.
 * Read-only.
 */
function doDangling(rootDir) {
  const reg = readCommitted(rootDir);
  const dangling = reg && Array.isArray(reg.danglingRefs) ? reg.danglingRefs : [];
  const findings = [];
  for (const d of dangling) {
    if (!d || typeof d.rawRef !== 'string') continue;
    const site = Array.isArray(d.sites) && d.sites.length > 0 ? d.sites[0] : null;
    findings.push(
      makeFinding({
        level: 'WARN',
        path: site && typeof site.path === 'string' ? site.path : 'registry.json',
        line: site && Number.isInteger(site.line) ? site.line : null,
        message: `dangling reference \`${d.rawRef}\` from ${d.from} does not resolve to a known artifact`,
        source: SOURCE,
      }),
    );
  }
  return result(true, { dangling }, findings, { dangling: dangling.length });
}

/**
 * C4 `summarize(state)` — pure; map persisted registry state to a one-panel
 * summary. Returns a `(no data)` panel when state is absent (fail-open).
 *
 * The returned Panel is the SPEC-00 `{ panel, ok, lines, hint? }` object (consumed
 * by the `status` composer, SPEC-08). It also carries a NON-enumerable `toString`
 * that renders `panel + lines (+ hint)` so `String(panel)` is human-meaningful (and
 * a `(no data)` panel stringifies to text containing "no data") without polluting the
 * JSON shape (a non-enumerable key is omitted from `JSON.stringify`).
 *
 * @param {Registry|null} state the committed registry snapshot, if available
 * @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  if (!state || !Array.isArray(state.artifacts)) {
    return makePanel({
      panel: 'registry',
      ok: false,
      lines: ['(no data)'],
      hint: 'run forge registry build --write',
    });
  }
  const total = state.artifacts.length;
  const byStatus = {};
  for (const a of state.artifacts) {
    const s = a && typeof a.status === 'string' ? a.status : 'unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  const parts = Object.keys(byStatus)
    .sort()
    .map((s) => `${s}:${byStatus[s]}`);
  return makePanel({
    panel: 'registry',
    ok: true,
    lines: [`${total} artifact(s)`, parts.join('  ')],
  });
}

/**
 * Build a Panel object with a non-enumerable `toString` (so `String(panel)` renders
 * a human line and JSON stays the clean `{panel,ok,lines,hint?}` shape).
 * @param {{panel:string, ok:boolean, lines:string[], hint?:string}} p
 */
function makePanel(p) {
  Object.defineProperty(p, 'toString', {
    value() {
      const body = Array.isArray(p.lines) ? p.lines.join(' ') : '';
      return `[${p.panel}] ${body}${p.hint ? ` (${p.hint})` : ''}`;
    },
    enumerable: false,
  });
  return p;
}

// ---------------------------------------------------------------------------
// run() helpers
// ---------------------------------------------------------------------------

/**
 * Assemble a ModuleResult `{ ok, data, findings, summary }` (the C4 contract). The
 * optional `extra` object spreads ADDITIVE top-level accessors onto the result (e.g.
 * `VERSION` for roll-up, `changelog`/`record` for show) so behavior-pinning callers
 * that probe the return value directly find them, without breaking the C4 shape.
 *
 * @param {boolean} ok
 * @param {any} data
 * @param {import('./lib/findings.mjs').Finding[]} [findings]
 * @param {object} [summary]
 * @param {object} [extra] additive top-level fields (never overrides ok/data/findings/summary)
 */
function result(ok, data, findings = [], summary = undefined, extra = undefined) {
  const list = Array.isArray(findings) ? findings : [];
  // The C3 envelope (envelope.schema.json) REQUIRES summary.{errors,warnings,info}.
  // A caller's command-specific counts (artifacts/changed/changelog/…) are ADDITIVE
  // on top of that uniform triple, never a replacement — so merge the level counts
  // UNDER any supplied summary (the supplied count keys win on overlap). Without this
  // the registry envelopes dropped the triple and failed schema validation
  // (EVAL-CLI-002 / EVAL-CLI-008).
  const sum = summary !== undefined ? { ...levelCounts(list), ...summary } : levelCounts(list);
  const base = { ok: !!ok, data: data === undefined ? null : data, findings: list, summary: sum };
  return extra && typeof extra === 'object' ? { ...extra, ...base } : base;
}

/** Count findings by level into the uniform triple. */
function levelCounts(findings) {
  const s = { errors: 0, warnings: 0, info: 0 };
  for (const f of findings) {
    if (f && f.level === 'ERROR') s.errors++;
    else if (f && f.level === 'WARN') s.warnings++;
    else if (f && f.level === 'INFO') s.info++;
  }
  return s;
}

/** Pull an option value `--name value` from args/ctx (string[] or {opts}). */
function optionValue(args, ctx, name, positional) {
  // 1) ctx.opts (dispatcher).
  if (ctx && ctx.opts && typeof ctx.opts === 'object' && typeof ctx.opts[name] === 'string') {
    return ctx.opts[name];
  }
  // 2) args.opts.
  if (args && args.opts && typeof args.opts === 'object' && typeof args.opts[name] === 'string') {
    return args.opts[name];
  }
  // 3) scan the raw arg list for `--name value`.
  const list = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === `--${name}` && i + 1 < list.length) return list[i + 1];
    if (typeof list[i] === 'string' && list[i].startsWith(`--${name}=`)) return list[i].slice(name.length + 3);
  }
  return null;
}

/** Derive a bump level from flags (defaults to patch). */
function levelFromFlags(flags) {
  if (flags.has('major')) return 'major';
  if (flags.has('minor')) return 'minor';
  return 'patch';
}

/** Map a plural OR singular kind filter to the singular registry kind. */
function singularizeKind(kind) {
  const map = {
    agents: 'agent',
    skills: 'skill',
    commands: 'command',
    rules: 'rule',
    bundles: 'bundle',
    workflows: 'workflow',
    mcp: 'mcp',
    hooks: 'hook',
    validators: 'validator',
    'meta-tests': 'meta-test',
    engine: 'engine',
    engines: 'engine',
  };
  if (map[kind]) return map[kind];
  return kind; // already singular (agent, skill, …)
}

/** Static usage banner for an unknown subcommand. */
function usageText() {
  return [
    'forge registry build [--write]',
    'forge registry ls [--kind <kind>]',
    'forge registry show <uid>',
    'forge registry changed --since <snapshot>',
    'forge registry diff <a> <b>',
    'forge registry bump <uid> --major|--minor|--patch',
    'forge registry roll-up',
    'forge registry deps <uid>',
    'forge registry rdeps <uid>',
    'forge registry orphans',
    'forge registry dangling',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Dual-mode: direct script entry
//   node manager/registry.mjs <subcmd> [flags] [rootDir]
// Renders human text, or the C3 --json envelope under --json. PRINT happens ONLY
// here (the print/compute split, EVAL-CLI-007): run() never writes stdout.
// ---------------------------------------------------------------------------

/**
 * Render a ModuleResult as human text (print side). Returns the exit code.
 * @param {string} subcmd
 * @param {{ok:boolean,data:any,findings:any[],summary:any}} res
 * @returns {number}
 */
function renderHuman(subcmd, res) {
  const out = [];
  if (subcmd === 'ls') {
    const arr = res.data && Array.isArray(res.data.artifacts) ? res.data.artifacts : [];
    for (const a of arr) out.push(`${a.uid}\t${a.status}\t${a.path}`);
  } else if (subcmd === 'show') {
    const rec = res.data;
    if (rec && rec.uid) {
      out.push(`${rec.uid}`);
      out.push(`  kind:        ${rec.kind}`);
      out.push(`  path:        ${rec.path}`);
      out.push(`  revision:    ${rec.revision}`);
      out.push(`  version:     ${rec.version}`);
      out.push(`  status:      ${rec.status}`);
      out.push(`  contentHash: ${rec.contentHash}`);
      const cl = Array.isArray(rec.changelog) ? rec.changelog : [];
      out.push(`  changelog:   ${cl.length} entr${cl.length === 1 ? 'y' : 'ies'}`);
      for (const e of cl) out.push(`    ${e.ts} ${e.from && e.from.rev}→${e.to && e.to.rev} ${e.reason}`);
    }
  } else if (subcmd === 'changed') {
    const arr = res.data && Array.isArray(res.data.changed) ? res.data.changed : [];
    for (const uid of arr) out.push(uid);
  } else if (subcmd === 'diff') {
    const d = res.data || {};
    for (const uid of d.added || []) out.push(`+ ${uid}`);
    for (const uid of d.removed || []) out.push(`- ${uid}`);
    for (const uid of d.changed || []) out.push(`~ ${uid}`);
  } else if (subcmd === 'build') {
    const s = res.summary || {};
    out.push(`registry: ${s.artifacts} artifact(s)${s.wrote ? ` written, ${s.logLines || 0} log line(s)` : ' (dry-run)'}`);
  } else if (subcmd === 'roll-up') {
    out.push(res.data && res.data.VERSION ? res.data.VERSION : '');
  } else if (subcmd === 'bump') {
    const rec = res.data;
    if (rec) out.push(`${rec.uid}: revision ${rec.revision}, version ${rec.version}`);
  } else if (subcmd === 'deps') {
    const arr = res.data && Array.isArray(res.data.deps) ? res.data.deps : [];
    for (const u of arr) out.push(u);
  } else if (subcmd === 'rdeps') {
    const arr = res.data && Array.isArray(res.data.rdeps) ? res.data.rdeps : [];
    for (const u of arr) out.push(u);
  } else if (subcmd === 'orphans') {
    const arr = res.data && Array.isArray(res.data.orphans) ? res.data.orphans : [];
    for (const u of arr) out.push(u);
  } else if (subcmd === 'dangling') {
    const arr = res.data && Array.isArray(res.data.dangling) ? res.data.dangling : [];
    for (const d of arr) {
      const sites = Array.isArray(d.sites) ? d.sites.map((s) => `${s.path}${s.line ? `:${s.line}` : ''}`).join(', ') : '';
      out.push(`${d.rawRef}\t${d.from}\t${sites}`);
    }
  }
  // Findings to stderr in the LEVEL path:line message grammar (parser-friendly).
  for (const f of res.findings || []) {
    const loc = f.line ? `${f.path}:${f.line}` : f.path;
    process.stderr.write(`${f.level} ${loc} ${f.message}\n`);
  }
  if (out.length) process.stdout.write(out.join('\n') + '\n');
  return res.ok ? 0 : (res.findings || []).some((f) => f.level === 'ERROR') ? 1 : 0;
}

/** True when this module is executed directly (not imported). */
function isMain() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const subcmd = argv[0];
  const rest = argv.slice(1);
  const json = rest.includes('--json');
  // The trailing non-flag positional may be a rootDir (tests target fixtures).
  run(subcmd, rest, {})
    .then((res) => {
      if (json) {
        const env = envelope({
          command: `registry ${subcmd || ''}`.trim(),
          ok: res.ok,
          data: res.data,
          findings: res.findings,
          summary: res.summary,
          forgeVersion: stripDesignRaw(),
        });
        writeStdoutSync(JSON.stringify(env) + '\n'); // SYNC write before exit — pipe-flush truncation (see json-out.mjs)
        process.exit(res.ok ? 0 : (res.findings || []).some((f) => f.level === 'ERROR') ? 1 : 0);
      } else {
        process.exit(renderHuman(subcmd, res));
      }
    })
    .catch(() => process.exit(1)); // fail-open: never an unhandled rejection
}

/** Raw VERSION for the --json envelope's `forge` field (the un-stripped string). */
function stripDesignRaw() {
  // Use the rootDir from the trailing positional if present; else cwd. Skip the
  // value token of a value-option (--kind/--since) so it is not mistaken for the
  // rootDir (mirrors normalize(); EVAL-REG-009).
  const argv = process.argv.slice(2);
  const rest = argv.slice(1);
  const VALUE_OPTS = new Set(['kind', 'since']);
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a !== 'string' || a.startsWith('--')) {
      const name = typeof a === 'string' ? a.slice(2) : '';
      if (VALUE_OPTS.has(name) && i + 1 < rest.length && !String(rest[i + 1]).startsWith('--')) i++;
      continue;
    }
    positional.push(a);
  }
  const rootDir = positional.length ? positional[positional.length - 1] : process.cwd();
  return readRawVersion(rootDir);
}

export default { run, summarize, buildRegistry, persistBuild, bumpArtifact, rollUp, bumpSemver, bundleIntegerToSemver };
