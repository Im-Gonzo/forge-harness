#!/usr/bin/env node
// @ts-check
/**
 * Forge CLI — the testable centerpiece that ties together the profiler, the
 * manifests, the templates, and the self-validators.
 *
 * Two roots, STRICTLY separate:
 *   FORGE_ROOT  — where this CLI, the manifests, templates, rules, and lint live
 *                 (the plugin payload). Resolved from import.meta.url.
 *   PROJECT_DIR — the TARGET project being profiled/initialised. A CLI arg,
 *                 defaulting to process.cwd(). Forge only ever WRITES under
 *                 <PROJECT_DIR>/.claude/.
 *
 * Design split (docs/ARCHITECTURE.md §7, docs/BOOTSTRAP.md):
 *   - Fact collection is deterministic (bootstrap/profile-project.mjs).
 *   - Profile *selection* from facts is LLM judgment (the bootstrap-harness
 *     SKILL). This CLI is intentionally DETERMINISTIC: it takes --profile or
 *     falls back to profiles.defaultProfile. It does not guess a profile.
 *
 * Invariants honoured here:
 *   1. Additive, never destructive — existing target files are never clobbered;
 *      `init` warns and skips them.
 *   2. Dry-run by default — `init` only writes with --apply.
 *
 * Conventions: Node ESM, ZERO dependencies (node: builtins only).
 *
 * Usage:
 *   forge profile   [dir] [--write]
 *   forge validate  [--strict] [dir]
 *   forge init      [dir] [--profile <name>] [--apply]
 *   forge doctor    [dir]
 *   forge sync      [dir]
 *   forge install   [--apply]            (Phase 4: global plugin install)
 *   forge uninstall [--apply]            (Phase 4: reverse via state file)
 *   forge help
 *
 * Phase 4 — global install (this file):
 *   `install`/`uninstall` register THIS repo as a Claude Code plugin in the
 *   user's ~/.claude/ (resolved from $HOME so it is sandbox-testable). The
 *   mechanism mirrors how Claude Code actually tracks plugins:
 *     - ~/.claude/plugins/known_marketplaces.json : a local marketplace entry
 *     - ~/.claude/plugins/installed_plugins.json  : the installed-plugin record
 *     - ~/.claude/settings.json                   : enabledPlugins (+ a mirror
 *       extraKnownMarketplaces) — MERGED, never overwritten
 *     - a SYMLINK from the marketplace's installLocation -> this repo, so edits
 *       to the library are live (no copy to keep in sync).
 *   Everything created/changed is recorded in ~/.claude/.forge-install-state.json
 *   so `uninstall` reverses it precisely (remove only what we made, restore the
 *   exact prior settings values). The install is ADDITIVE: if any target already
 *   exists with foreign content, install STOPS and reports rather than clobber.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

const FORGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Tiny fail-open filesystem helpers
// ---------------------------------------------------------------------------

/** @param {string} p */
function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
/** @param {string} p */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
/** @param {string} p */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
/** @param {string} p @returns {string} */
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}
/** @param {string} p @returns {any} */
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} s @returns {string} hex sha256 of a UTF-8 string. */
function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Provenance (ADR-0009) — LAZY manager bridge for `init --apply`.
//
// The marker schema tag the library Registry is recorded against. Canonical per
// ADR-0009 / schemas/marker.schema.json (provenance.registrySchema description).
const REGISTRY_SCHEMA_TAG = 'forge.registry.v1';

/**
 * Compute a marker's deterministic `provenance.sourceRev` by folding the library
 * Registry contentHash of every component the marker's modules[] resolve to
 * (ADR-0009 / BR-FLEET-001). LAZY-LOADS manager/fleet.mjs#computeSourceRev via
 * createRequire so the dispatch HOT PATH stays manager-free: this is reached ONLY
 * inside `cmdInit`'s --apply branch (never on a dry-run init), so `forge init`
 * dry-run imports NO forge/manager/* module (EVAL-CLI-006). createRequire keeps
 * cmdInit + main() SYNCHRONOUS (no top-level await). Fail-open: any failure
 * yields the empty-fold sourceRev (a valid degenerate value), never a throw — so
 * an init that cannot resolve provenance still writes a structurally valid block.
 *
 * @param {string} rootDir absolute FORGE library root (where .forge/registry.json lives)
 * @param {{modules?:string[]}} marker the marker being written (uses modules[])
 * @returns {string} "sha256:<hex>"
 */
function computeMarkerSourceRev(rootDir, marker) {
  try {
    const require = createRequire(import.meta.url);
    const fleet = require('../manager/fleet.mjs');
    const fn = fleet && (fleet.computeSourceRev || (fleet.default && fleet.default.computeSourceRev));
    if (typeof fn === 'function') return fn(rootDir, marker);
  } catch (e) {
    process.stderr.write(`[forge] provenance: could not compute sourceRev (${e && e.message}); using empty fold\n`);
  }
  // Fail-open: the empty fold is a well-formed (degenerate) sourceRev.
  return 'sha256:' + sha256hex(JSON.stringify({}));
}

// ---------------------------------------------------------------------------
// Shared loaders (manifests / version)
// ---------------------------------------------------------------------------

/** The raw Forge version (e.g. "0.1.0-design"). */
function rawVersion() {
  const v = readText(path.join(FORGE_ROOT, 'VERSION')).trim();
  return v || '0.0.0';
}

/**
 * The version emitted into generated artifacts. We strip a trailing `-design`
 * (the Phase-1 design suffix) so generated harnesses carry a clean semver-ish
 * string; any other suffix is kept verbatim.
 */
function forgeVersion() {
  const v = rawVersion();
  return v.endsWith('-design') ? v.slice(0, -'-design'.length) : v;
}

function loadProfiles() {
  return readJson(path.join(FORGE_ROOT, 'manifests', 'profiles.json')) || {};
}
function loadModules() {
  return readJson(path.join(FORGE_ROOT, 'manifests', 'modules.json')) || {};
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} args
 * @returns {{ positional: string[], flags: Set<string>, opts: Record<string,string> }}
 */
function parseArgs(args) {
  const positional = [];
  const flags = new Set();
  /** @type {Record<string,string>} */
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--profile') {
      // value-taking option
      opts.profile = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '';
    } else if (a.startsWith('--profile=')) {
      opts.profile = a.slice('--profile='.length);
    } else if (a.startsWith('--')) {
      flags.add(a.slice(2));
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, opts };
}

// ---------------------------------------------------------------------------
// Delegation: run a sibling Forge script as a child process.
// ---------------------------------------------------------------------------

/**
 * Run a FORGE_ROOT script, INHERITING stdio so its output streams straight
 * through. Returns the child's exit code (defaulting to 1 on spawn error).
 * @param {string} relScript path under FORGE_ROOT
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {number}
 */
function delegateInherit(relScript, args, cwd) {
  const abs = path.join(FORGE_ROOT, relScript);
  // Forward the parent's own node exec flags (process.execArgv) to the child.
  // In normal use this is empty, so the spawned command is unchanged (the flat
  // verbs stay byte-identical, EVAL-INT-007). When the parent is launched with
  // node-level instrumentation (e.g. `node --experimental-loader … forge
  // registry ls`), the child inherits that same loader so a module the child
  // imports across the process boundary — manager/registry.mjs — is observed by
  // the parent's import tracer (EVAL-CLI-006: process-boundary delegation).
  const res = spawnSync(process.execPath, [...process.execArgv, abs, ...args], {
    cwd: cwd || process.cwd(),
    stdio: 'inherit',
  });
  if (res.error) {
    process.stderr.write(`[forge] failed to run ${relScript}: ${res.error.message}\n`);
    return 1;
  }
  return res.status == null ? 1 : res.status;
}

// ---------------------------------------------------------------------------
// Manager dispatch (SPEC-08 taxonomy). The hot path (profile/validate/init/
// doctor/sync/install/uninstall/help) imports NO manager module — manager verbs
// reach their modules ONLY across a process boundary via delegateInherit, so
// `forge doctor`/`init`/`sync` never load forge/manager/* (EVAL-CLI-006).
// ---------------------------------------------------------------------------

// Registry sub-verbs recognized by the dispatcher. The bodies for the v0.3+
// graph/version verbs live in manager/registry.mjs; here we only gate dispatch
// vs. an unknown sub-verb (group usage + exit 2, EVAL-CLI-009/BR-CLI-009).
const REGISTRY_VERBS = new Set([
  'build', 'ls', 'show', 'changed', 'diff', // v0.2
  'deps', 'rdeps', 'orphans', 'dangling', // v0.3 graph
  'bump', 'log', 'roll-up', // v0.3+ version
]);

// Reserved taxonomy verbs whose modules are not built until a later phase. They
// are RECOGNIZED (named in --help, dispatched here) but, lacking a module, emit
// a concise "planned for a later version" notice and exit 0 — never a crash
// (SPEC-08 taxonomy reservation; EVAL-CLI-009/010). v0.4 promoted telemetry,
// stat, monitor, and eval-harness to LIVE (delegated below); only `optimize`
// stays reserved here until v0.6.
const PLANNED_VERBS = {
  optimize: 'v0.6',
};

// NOTE: `forge telemetry <sub>` (on|off|status|prune|wipe|stat|monitor) is NOT
// gated against an allow-list the way registry/fleet sub-verbs are. The telemetry
// reader is fail-open by contract (BR-TEL-013): an unknown sub-verb yields an
// off/empty INFO + exit 0, never exit 2 — so the dispatcher forwards the sub-verb
// VERBATIM and lets the module own the contract. `forge stat`/`forge monitor` are
// promoted top-level aliases for its `stat`/`monitor` readers (v0.4).

// Fleet sub-verbs recognized by the dispatcher. The bodies live in
// manager/fleet.mjs; here we only gate dispatch vs. an unknown sub-verb (group
// usage + exit 2, mirroring the registry contract). v0.3 dispatches enable/
// status/scan/drift/add; the v0.5 write verbs (sync/relink/forget/prune/ignore/
// pin) are recognized so an unknown token is the only exit-2 path.
const FLEET_VERBS = new Set([
  'enable', 'status', 'scan', 'drift', 'add', // v0.3
  'sync', 'relink', 'forget', 'prune', 'ignore', 'pin', // v0.5
]);

// Memory sub-verbs recognized by the dispatcher. The bodies live in
// manager/memory.mjs; here we only gate dispatch vs. an unknown sub-verb (group
// usage + exit 2, mirroring the registry/fleet contract). The vault operator is
// read/reindex/import over a project's curated memory (docs/METHOD.md §8).
const MEMORY_VERBS = new Set([
  'list', 'validate', 'reindex', 'import',
]);

// MCP sub-verbs recognized by the dispatcher. The bodies live in manager/mcp.mjs;
// here we only gate dispatch vs. an unknown sub-verb (group usage + exit 2,
// mirroring the registry/fleet/memory contract). NOTE: `mcp` is ALSO a registry
// KIND (the mcp/ catalog dir) — the CLI verb and the kind coexist (like `memory`).
// The verb ENABLES/DISABLES a catalog MCP server in a project's settings.json.
const MCP_VERBS = new Set([
  'list', 'enable', 'disable',
]);

// Source sub-verbs recognized by the dispatcher (federated catalog, ADR-0017). The
// bodies live in manager/source.mjs; here we only gate dispatch vs. an unknown
// sub-verb (group usage + exit 2, mirroring registry/fleet/memory/mcp). The verb
// operates the SOURCE registry (manifests/sources.json): add/list/remove are live;
// sync/trust are recognized PLANNED stubs (security-gated later Build steps).
const SOURCE_VERBS = new Set([
  'list', 'add', 'remove', 'sync', 'trust',
]);

// Catalog sub-verbs recognized by the dispatcher (federated catalog, ADR-0017). The
// bodies live in manager/catalog.mjs; here we only gate dispatch vs. an unknown
// sub-verb (group usage + exit 2). The verb operates the unified CATALOG (library ∪
// synced sources) + the admission lifecycle. All verbs are recognized PLANNED stubs
// this phase (build returns an empty catalog); none activates anything yet.
const CATALOG_VERBS = new Set([
  'build', 'ls', 'dedup', 'audit', 'judge', 'admit', 'revoke',
]);

// Slice sub-verbs recognized by the dispatcher (catalog slices + per-project
// subscriptions, ADR-0018). The bodies live in manager/slices.mjs; here we only gate
// dispatch vs. an unknown sub-verb (group usage + exit 2, mirroring source/catalog). A
// SLICE is a named group of ONE source's catalog records (v1: by registry kind, id
// "<sourceId>/<kind>"); subscribe/unsubscribe toggle the per-active-root opt-in set in
// .forge/subscriptions.json (list is read-only; subscribe/unsubscribe write on --apply).
const SLICE_VERBS = new Set([
  'list', 'subscribe', 'unsubscribe',
]);

// Compose sub-verbs recognized by the dispatcher (per-project composition + adoption,
// ADR-0019). The bodies live in manager/compose.mjs; here we only gate dispatch vs. an
// unknown sub-verb (group usage + exit 2, mirroring source/catalog/slice). A COMPOSITION is
// the per-active-root set of resources the project has ADOPTED from its catalog READ-VIEW
// (library-local ∪ subscribed-slice records, ADR-0018). adopt/remove toggle the per-project
// set in <activeRoot>/.forge/composition.json (list is read-only; adopt/remove write on
// --apply). ADOPT != ADMIT: it records a per-project selection and never writes the library.
const COMPOSE_VERBS = new Set([
  'list', 'adopt', 'remove',
]);

// Conflict sub-verbs recognized by the dispatcher (per-project conflicts + adjudication,
// ADR-0020). The bodies live in manager/conflict.mjs; here we only gate dispatch vs. an unknown
// sub-verb (group usage + exit 2, mirroring source/catalog/slice/compose). A CONFLICT is a uid
// that resolves to >= 2 DISTINCT candidate records in the project's catalog READ-VIEW (the dedup
// uid-collision/near-dup classes; BR-CAT-010); the set is DERIVED, never stored. list is read-only
// (deterministic-collection only — it CONSUMES recorded judge/eval signals, NEVER invokes a model);
// resolve/policy write the per-active-root .forge/adjudication.json on --apply (resolve --apply also
// updates .forge/composition.json via the compose helpers). DEFAULT policy is all-block.
const CONFLICT_VERBS = new Set([
  'list', 'resolve', 'policy',
]);

// Tailor sub-verbs recognized by the dispatcher (per-project tailoring + overlays, ADR-0021). The
// bodies live in manager/tailor.mjs; here we only gate dispatch vs. an unknown sub-verb (group
// usage + exit 2, mirroring source/catalog/slice/compose/conflict). A TAILORING OVERLAY is a
// per-ADOPTED-resource modifier (pin|override|layer|gate|fork|disable) layered ON TOP of a
// composition entry (ADR-0019); overlays are RECORDED INTENTIONS persisted in the SEPARATE
// per-active-root .forge/tailoring.json store, and the CLI folds them over the base catalog record
// into a deterministic RESOLVED PREVIEW (a display-only VIEW — NO .claude/ write here; application
// is Slice 5). list is read-only; add/remove write on --apply. add validates the resource is
// ADOPTED by reusing the compose read helpers (BR-CAT-015); NO model call.
const TAILOR_VERBS = new Set([
  'list', 'add', 'remove',
]);

// Lock sub-verbs recognized by the dispatcher (per-project LOCKFILE, ADR-0022). The bodies live in
// manager/lock.mjs; here we only gate dispatch vs. an unknown sub-verb (group usage + exit 2,
// mirroring source/catalog/slice/compose/conflict/tailor). `forge.lock` is the RESOLVED per-project
// COMPOSITION manifest (the project analogue of package-lock.json): the adopted set (ADR-0019)
// JOINED with the tailoring overlays (ADR-0021), the adjudication choices (ADR-0020), and each
// entry's pinned version/commit, plus a DETERMINISTIC content hash (excluding generatedAt). It lives
// at <activeRoot>/forge.lock (the project root, git-committable) — DISTINCT from .forge/sources.lock
// (which pins SOURCE commits, machine-local). show/diff are read-only; write resolves + writes
// <activeRoot>/forge.lock on --apply. MANIFEST-ONLY: lock write NEVER materializes/modifies .claude/
// (BR-CAT-019); it REUSES the compose/tailor/conflict read helpers + the source-commit pins and
// invokes NO model.
const LOCK_VERBS = new Set([
  'show', 'write', 'diff',
]);

/**
 * Print a registry group-usage banner (mirrors the child's static usage) for an
 * unknown sub-verb. Kept in-process so the bin owns the exit-2 contract without
 * depending on the child's exit code (the child returns 1 on an ERROR finding).
 * @param {string} sub
 */
function registryUsage(sub) {
  process.stderr.write(`[forge] unknown registry sub-verb: ${sub}\n\n`);
  log(`forge registry <verb>
  build [--write]        Catalog the library; --write persists .forge/registry.json.
  ls [--kind <k>]        List catalogued artifacts (optionally one kind).
  show <uid>             Show one artifact record + its changelog.
  changed [--since <ref>] UIDs whose revision advanced since a snapshot.
  diff <a> <b>           Record-level diff of two registry snapshots.
  deps <uid> | rdeps <uid> | orphans | dangling   (v0.3)
  bump <uid> | log [<uid>] | roll-up              (v0.3+)`);
}

/**
 * Print a fleet group-usage banner (mirrors registryUsage) for an unknown
 * sub-verb. Kept in-process so the bin owns the exit-2 contract without relying
 * on the child's exit code (the child returns 1 on an ERROR finding, not 2).
 * @param {string} sub
 */
function fleetUsage(sub) {
  process.stderr.write(`[forge] unknown fleet sub-verb: ${sub}\n\n`);
  log(`forge fleet <verb>      (opt-in, default OFF; machine-local cache under ~/.claude/forge/)
  enable                 Turn the local fleet cache ON (registers no project).
  status                 One reconciled row per registered project (read-only).
  add <project>          Register one project (reconcile its marker).
  scan [roots...]        Crawl scanRoots for markers and reconcile each.
  drift <project> [--component <uid>]   Component/version drift vs the library.
  sync | relink | forget | prune | ignore | pin   (v0.5, write — w/ --apply)`);
}

/**
 * Print a memory group-usage banner (mirrors fleetUsage) for an unknown sub-verb.
 * Kept in-process so the bin owns the exit-2 contract without relying on the
 * child's exit code (the child returns 1 on an ERROR finding, not 2).
 * @param {string} sub
 */
function memoryUsage(sub) {
  process.stderr.write(`[forge] unknown memory sub-verb: ${sub}\n\n`);
  log(`forge memory <verb>     (the project's curated memory vault — docs/METHOD.md §8)
  list                   Enumerate vault entries (id/type/status/title). Read-only.
  validate               Run the memory-integrity checks (links/type<->dir/index freshness).
  reindex [--write]      Regenerate index.md from active entries; --write persists it.
  import <srcDir> [--apply]   Map a foreign vault into forge-schema entries (additive).`);
}

/**
 * Print an mcp group-usage banner (mirrors memoryUsage) for an unknown sub-verb.
 * Kept in-process so the bin owns the exit-2 contract without relying on the
 * child's exit code (the child returns 1 on an ERROR finding, not 2).
 * @param {string} sub
 */
function mcpUsage(sub) {
  process.stderr.write(`[forge] unknown mcp sub-verb: ${sub}\n\n`);
  log(`forge mcp <verb>        (enable/disable a catalog MCP server in this project's .claude/settings.json)
  list                   List library MCP catalog components + whether each is enabled here. Read-only.
  enable <name> [--apply]    Additively merge the component's mcpServers into settings.json (skip existing).
  disable <name> [--apply]   Remove the component's declared mcpServers keys from settings.json.`);
}

/**
 * Print a source group-usage banner (mirrors mcpUsage) for an unknown sub-verb.
 * Kept in-process so the bin owns the exit-2 contract without relying on the
 * child's exit code (the child returns 1 on an ERROR finding, not 2).
 * @param {string} sub
 */
function sourceUsage(sub) {
  process.stderr.write(`[forge] unknown source sub-verb: ${sub}\n\n`);
  log(`forge source <verb>     (register external repos as federated catalog sources — ADR-0017)
  list                       List registered sources (id/kind/ref/trust/url). Read-only.
  add <id> <url> [--ref <r>] [--apply]   Register a new source (default ref main, trust untrusted).
  remove <id> [--apply]      Drop a source from manifests/sources.json.
  sync [id]                  (planned) Shallow-clone source(s) to ~/.claude/forge-sources/<id>; pin .forge/sources.lock.
  trust <id>                 (planned) Flip a source untrusted -> reviewed (security-gated).`);
}

/**
 * Print a catalog group-usage banner (mirrors sourceUsage) for an unknown sub-verb.
 * Kept in-process so the bin owns the exit-2 contract without relying on the
 * child's exit code (the child returns 1 on an ERROR finding, not 2).
 * @param {string} sub
 */
function catalogUsage(sub) {
  process.stderr.write(`[forge] unknown catalog sub-verb: ${sub}\n\n`);
  log(`forge catalog <verb>    (the unified catalog: library ∪ synced sources; admission lifecycle — ADR-0017)
  build                      (planned) Assemble the unified catalog (returns an empty catalog for now).
  ls                         (planned) List catalog records (discoverable; INERT until admitted).
  dedup                      (planned) Deterministic dedup classification across the catalog.
  audit <uid> --agent <n> --verdict <v> [--evidence <s>] [--apply]   Record an auditor agent's verdict (clean|suspicious|malicious); dry-run unless --apply.
  judge <uid> --verdict <v> [--rationale <s>] [--apply]              Record the judge agent's conflict decision (keep|replace|both|quarantine); dry-run unless --apply.
  admit <uid>                (planned) Run the admission pipeline (validate->dedup->judge->test->admit).
  revoke <uid>               (planned) De-activate an admitted record back to the catalog.`);
}

/**
 * Print a slice group-usage banner (mirrors sourceUsage/catalogUsage) for an unknown
 * sub-verb. Kept in-process so the bin owns the exit-2 contract without relying on the
 * child's exit code (the child returns 1 on an ERROR finding, not 2).
 * @param {string} sub
 */
function sliceUsage(sub) {
  process.stderr.write(`[forge] unknown slice sub-verb: ${sub}\n\n`);
  log(`forge slice <verb>      (catalog slices + per-project subscriptions — ADR-0018)
  list [--source <id>]       Derive slices (one source's records by kind, id "<sourceId>/<kind>") + mark subscribed. Read-only.
  subscribe <sliceId> [--apply]     Opt this project into a slice's records (read-view). Preview unless --apply.
  unsubscribe <sliceId> [--apply]   Drop a slice from the read-view (records stay admittable). Preview unless --apply.`);
}

/**
 * Print a compose group-usage banner (mirrors sliceUsage) for an unknown sub-verb. Kept
 * in-process so the bin owns the exit-2 contract without relying on the child's exit code
 * (the child returns 1 on an ERROR finding, not 2).
 * @param {string} sub
 */
function composeUsage(sub) {
  process.stderr.write(`[forge] unknown compose sub-verb: ${sub}\n\n`);
  log(`forge compose <verb>    (the per-project COMPOSITION: resources ADOPTED from the read-view — ADR-0019)
  list                       List adopted resources (uid/kind/source/version/criticality), JOINED to the catalog. Read-only.
  adopt <uid> [--source <id>] [--apply]    Adopt a read-view resource into this project (library-local, or --source <id>). adopt != admit. Preview unless --apply.
  remove <uid> [--source <id>] [--apply]   Drop the matching (uid, sourceId) entry from this project's composition. Preview unless --apply.`);
}

/**
 * Print a conflict group-usage banner (mirrors composeUsage) for an unknown sub-verb. Kept
 * in-process so the bin owns the exit-2 contract without relying on the child's exit code (the
 * child returns 1 on an ERROR finding, not 2).
 * @param {string} sub
 */
function conflictUsage(sub) {
  process.stderr.write(`[forge] unknown conflict sub-verb: ${sub}\n\n`);
  log(`forge conflict <verb>   (per-project conflicts + adjudication: a read-view uid with >= 2 candidates — ADR-0020)
  list [--json]              Derive read-view conflicts (dedup uid-collision/near-dup); attach recorded judge/eval signals; show state. Read-only, no model call.
  resolve <uid> --winner <sourceId|"library"> [--apply]   Record the human T2 pick; on --apply adopt the winner + drop losing peers in the composition. Preview unless --apply.
  policy [--set normal=auto|block] [--set compliance=...] [--set safety=...] [--apply]   Get/set the per-criticality policy (default all-block). Preview unless --apply.`);
}

/**
 * Print a tailor group-usage banner (mirrors conflictUsage) for an unknown sub-verb. Kept
 * in-process so the bin owns the exit-2 contract without relying on the child's exit code (the
 * child returns 1 on an ERROR finding, not 2).
 * @param {string} sub
 */
function tailorUsage(sub) {
  process.stderr.write(`[forge] unknown tailor sub-verb: ${sub}\n\n`);
  log(`forge tailor <verb>     (per-project tailoring overlays on adopted resources — ADR-0021)
  list [--json]              List tailored resources (uid/kind/source/overlays) + the resolved preview, JOINED to the composition. Read-only.
  add <uid> --type <pin|override|layer|gate|fork|disable> --detail <s> [--source <id>] [--apply]   Record an overlay on an ADOPTED resource (--detail optional for fork/disable). Intention only — not applied to .claude/ here. Preview unless --apply.
  remove <uid> --type <t> [--detail <s>] [--source <id>] [--apply]   Drop matching overlay(s) by type (optionally narrowed by detail). Preview unless --apply.`);
}

/**
 * Print a lock group-usage banner (mirrors tailorUsage) for an unknown sub-verb. Kept in-process so
 * the bin owns the exit-2 contract without relying on the child's exit code (the child returns 1 on
 * an ERROR finding, not 2).
 * @param {string} sub
 */
function lockUsage(sub) {
  process.stderr.write(`[forge] unknown lock sub-verb: ${sub}\n\n`);
  log(`forge lock <verb>       (the RESOLVED per-project lockfile forge.lock — ADR-0022; the project analogue of package-lock.json)
  show [--json]              Show forge.lock (lockPath/exists/contents/committed/inSync). Read-only.
  write [--apply]            Resolve the composition (adopted ∪ overlays ∪ adjudication ∪ pins) + a deterministic hash; write <activeRoot>/forge.lock. MANIFEST-ONLY — never touches .claude/. Preview unless --apply.
  diff [--json]              Compare the current forge.lock vs the freshly-resolved composition (+/~/- changes). Read-only.`);
}

/**
 * Emit the "planned for a later version" notice for a recognized-but-unbuilt
 * taxonomy verb and return exit 0 (fail-soft; never a crash).
 * @param {string} verb @param {string} phase
 * @returns {number}
 */
function plannedNotice(verb, phase) {
  log(`[forge] \`${verb}\` is reserved in the command taxonomy but not yet built — planned for ${phase}.`);
  log(`        See docs/manager/spec/SPEC-08-cli-and-status.md (MANAGER section) for the surface.`);
  return 0;
}

/**
 * Run profile-project.mjs and CAPTURE its JSON facts (in-memory, no --write).
 * Fails open: returns a minimal valid facts doc if anything goes wrong.
 * @param {string} dir
 * @returns {any}
 */
function captureFacts(dir) {
  const abs = path.join(FORGE_ROOT, 'bootstrap', 'profile-project.mjs');
  const res = spawnSync(process.execPath, [abs, dir], { encoding: 'utf8' });
  const fallback = {
    languages: [],
    packageManager: {},
    frameworks: [],
    testRunner: [],
    database: null,
    lintFormat: [],
    monorepo: false,
    ci: [],
    commands: {},
    docs: { constitution: null, readme: null, docsDir: null, specs: [] },
    hasTests: false,
  };
  if (res.error || res.status !== 0 || !res.stdout) {
    if (res.error) process.stderr.write(`[forge] profile capture failed: ${res.error.message}\n`);
    return fallback;
  }
  try {
    return JSON.parse(res.stdout);
  } catch (e) {
    process.stderr.write(`[forge] could not parse profiler output: ${e && e.message}\n`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Composition (deterministic): facts + --profile -> profile + modules
// ---------------------------------------------------------------------------

/**
 * Pick the base profile. Deterministic in all paths:
 *   1. honour --profile if it names a real profile;
 *   2. otherwise AUTO-SELECT the best-fit profile from facts (materialized ∪
 *      intended) using a fixed, documented decision table;
 *   3. fall back to profiles.defaultProfile ("generic") when nothing matches.
 *
 * Auto-selection is intentionally a small deterministic heuristic so `forge
 * init` does something sensible with no flags. It is NOT a replacement for the
 * bootstrap-harness SKILL — the SKILL (LLM judgment) can still override by
 * passing --profile, and that always wins. We document this in the init output.
 *
 * Decision table (only profiles present in profiles.json are eligible; if the
 * preferred one is absent we degrade to the next-best present one):
 *   - python AND typescript present AND a db  -> python-next-fullstack
 *   - typescript only (no python)             -> next-ts
 *   - python only (no typescript)             -> python-fastapi
 *   - python AND typescript, no db            -> python-next-fullstack
 *   - else                                    -> defaultProfile (generic)
 *
 * "present" means the language/db appears in the UNION of materialized facts and
 * facts.intended (the spec-aware hint), so a spec-first repo with no code yet
 * still classifies from its docs.
 *
 * @param {any} profilesDoc
 * @param {string} [requested]
 * @param {any} [facts]
 * @returns {{ profile: string, reason: string }}
 */
function pickProfile(profilesDoc, requested, facts) {
  const profiles = profilesDoc.profiles || {};
  const def = profilesDoc.defaultProfile || 'generic';

  // 1. Explicit --profile always wins (the SKILL's override path).
  if (requested && Object.prototype.hasOwnProperty.call(profiles, requested)) {
    return { profile: requested, reason: 'requested via --profile' };
  }
  if (requested) {
    return {
      profile: profiles[def] ? def : Object.keys(profiles)[0],
      reason: `--profile "${requested}" is not in profiles.json; fell back to default "${def}"`,
    };
  }

  // 2. Deterministic auto-selection from facts (materialized ∪ intended).
  const auto = facts ? autoSelectProfile(profilesDoc, facts) : null;
  if (auto) return auto;

  // 3. Fall back to the default profile.
  return { profile: def, reason: `default profile (no --profile given; facts inconclusive)` };
}

/**
 * Best-fit profile from facts, using materialized facts unioned with the
 * spec-aware `facts.intended` hint. Returns null when no rule matches or none
 * of the preferred profiles exist (caller falls back to defaultProfile).
 * @param {any} profilesDoc
 * @param {any} facts
 * @returns {{ profile: string, reason: string }|null}
 */
function autoSelectProfile(profilesDoc, facts) {
  const profiles = profilesDoc.profiles || {};
  /** @param {string} name */
  const has = (name) => Object.prototype.hasOwnProperty.call(profiles, name);

  // intended is documented as always present: {languages, frameworks, database}.
  const intended = facts.intended && typeof facts.intended === 'object' ? facts.intended : {};
  const mLangs = Array.isArray(facts.languages) ? facts.languages : [];
  const iLangs = Array.isArray(intended.languages) ? intended.languages : [];
  const langs = new Set([...mLangs, ...iLangs].map((s) => String(s).toLowerCase()));
  const hasPython = langs.has('python');
  const hasTs = langs.has('typescript');
  const hasDb = Boolean(facts.database) || Boolean(intended.database);

  const src = (set) =>
    `materialized∪intended langs=[${[...set].join(', ') || 'none'}], db=${hasDb}`;

  // Ordered preference list per match; the first present profile is chosen.
  if (hasPython && hasTs) {
    const want = hasDb ? ['python-next-fullstack'] : ['python-next-fullstack', 'next-ts', 'python-fastapi'];
    const pick = want.find(has);
    if (pick) {
      return {
        profile: pick,
        reason: `auto-selected (python+typescript${hasDb ? '+db' : ''}): ${src(langs)}`,
      };
    }
  }
  if (hasTs && !hasPython) {
    const pick = ['next-ts', 'python-next-fullstack'].find(has);
    if (pick) return { profile: pick, reason: `auto-selected (typescript only): ${src(langs)}` };
  }
  if (hasPython && !hasTs) {
    const pick = ['python-fastapi', 'python-next-fullstack'].find(has);
    if (pick) return { profile: pick, reason: `auto-selected (python only): ${src(langs)}` };
  }
  return null;
}

/**
 * Resolve the module set: base profile's modules, plus best-effort
 * moduleSelectionRules.add deltas whose `when` fact holds. Order preserved,
 * de-duplicated. The `when` evaluation is a small, documented matcher over a
 * fixed grammar — NOT a general expression engine.
 * @param {any} profilesDoc
 * @param {string} profile
 * @param {any} facts
 * @returns {{ modules: string[], added: Array<{module:string, when:string}> }}
 */
function resolveModules(profilesDoc, profile, facts) {
  const base = (profilesDoc.profiles?.[profile]?.modules || []).slice();
  const set = new Set(base);
  /** @type {Array<{module:string, when:string}>} */
  const added = [];
  const rules = profilesDoc.moduleSelectionRules?.add || [];
  for (const rule of rules) {
    if (!rule || typeof rule.when !== 'string' || typeof rule.module !== 'string') continue;
    if (set.has(rule.module)) continue;
    if (evalWhen(rule.when, facts)) {
      set.add(rule.module);
      added.push({ module: rule.module, when: rule.when });
    }
  }
  return { modules: [...set], added };
}

/**
 * Best-effort evaluator for the tiny moduleSelectionRules grammar used in
 * profiles.json. Supports exactly:
 *   facts.<key> == '<value>'
 *   facts.<key> == true | false
 *   facts.<key> includes '<value>'
 * Anything it doesn't recognise evaluates to false (fail-closed for adds).
 * @param {string} when
 * @param {any} facts
 * @returns {boolean}
 */
function evalWhen(when, facts) {
  const s = when.trim();
  let m;
  // facts.<key> == '<value>'  /  facts.<key> == "<value>"
  if ((m = /^facts\.(\w+)\s*==\s*['"]([^'"]*)['"]$/.exec(s))) {
    return facts?.[m[1]] === m[2];
  }
  // facts.<key> == true | false
  if ((m = /^facts\.(\w+)\s*==\s*(true|false)$/.exec(s))) {
    return facts?.[m[1]] === (m[2] === 'true');
  }
  // facts.<key> includes '<value>'
  if ((m = /^facts\.(\w+)\s+includes\s+['"]([^'"]*)['"]$/.exec(s))) {
    const v = facts?.[m[1]];
    return Array.isArray(v) && v.includes(m[2]);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Template variables (the 12 documented vars + a couple of derived helpers)
// ---------------------------------------------------------------------------

/**
 * Compute the 12 template variables from facts + version + dir + now.
 * Absent commands render as the empty string (the settings.json contract
 * depends on this for dropping empty Stop blocks).
 * @param {any} facts
 * @param {string} dir
 * @param {string} profile
 * @param {string[]} modules
 * @returns {Record<string,string>}
 */
function computeVars(facts, dir, profile, modules) {
  const cmds = facts.commands || {};
  // Map profiler command keys. The profiler namespaces with be_/fe_ ONLY when
  // both stacks are present; otherwise it uses the bare keys. Resolve both.
  const test = cmds.test || cmds.be_test || '';
  const typecheck = cmds.typecheck || cmds.be_typecheck || '';
  const lint = cmds.lint || cmds.be_lint || '';
  const feTest = cmds.fe_test || '';
  const feTypecheck = cmds.fe_typecheck || '';

  const languages = Array.isArray(facts.languages) ? facts.languages : [];
  const frameworks = Array.isArray(facts.frameworks) ? facts.frameworks : [];

  return {
    PROJECT_NAME: path.basename(path.resolve(dir)) || 'project',
    FORGE_VERSION: forgeVersion(),
    PROFILE: profile,
    MODULES: modules.join(', '),
    GENERATED_AT: new Date().toISOString(),
    LANGUAGES: languages.join(', '),
    STACK_SUMMARY: stackSummary(facts, languages, frameworks),
    TEST_CMD: test,
    TYPECHECK_CMD: typecheck,
    LINT_CMD: lint,
    FE_TEST_CMD: feTest,
    FE_TYPECHECK_CMD: feTypecheck,
  };
}

/**
 * Build a short, human stack summary from facts.
 * @param {any} facts @param {string[]} languages @param {string[]} frameworks
 */
function stackSummary(facts, languages, frameworks) {
  const parts = [];
  if (languages.length) parts.push(languages.join('/'));
  if (frameworks.length) parts.push(frameworks.slice(0, 4).join(' + '));
  if (facts.database) parts.push(`${facts.database} db`);
  if (facts.monorepo) parts.push('monorepo');
  return parts.length ? parts.join(', ') : 'general-purpose';
}

/**
 * Substitute {{VAR}} placeholders in a template string.
 * @param {string} tpl @param {Record<string,string>} vars
 */
function substitute(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole,
  );
}

// ---------------------------------------------------------------------------
// settings.json: honour the _forge / _forge_when contract.
// ---------------------------------------------------------------------------

/**
 * Render settings.json.tmpl: substitute vars, parse as JSON, drop any Stop hook
 * block whose `_forge_when` is empty (after substitution), strip every `_forge`
 * and `_forge_when` key, and return canonical JSON text. Throws if the parse
 * fails so the caller can surface a contract mismatch.
 * @param {string} tplText @param {Record<string,string>} vars
 * @returns {string}
 */
function renderSettings(tplText, vars) {
  const substituted = substitute(tplText, vars);
  const obj = JSON.parse(substituted); // throws on malformed -> surfaced upstream
  stripForgeKeys(obj);
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Recursively: in any array, drop objects whose `_forge_when` is an empty
 * string; everywhere, delete `_forge` and `_forge_when` keys.
 * @param {any} node
 */
function stripForgeKeys(node) {
  if (Array.isArray(node)) {
    // Drop empty-gated blocks first, then recurse into survivors.
    for (let i = node.length - 1; i >= 0; i--) {
      const el = node[i];
      if (el && typeof el === 'object' && !Array.isArray(el)) {
        if ('_forge_when' in el && String(el._forge_when).trim() === '') {
          node.splice(i, 1);
          continue;
        }
      }
      stripForgeKeys(el);
    }
    return;
  }
  if (node && typeof node === 'object') {
    delete node._forge;
    delete node._forge_when;
    for (const k of Object.keys(node)) stripForgeKeys(node[k]);
  }
}

// ---------------------------------------------------------------------------
// Rule-file resolution: find <FORGE_ROOT>/rules/**/<name>.md
// ---------------------------------------------------------------------------

/**
 * Recursively find a rule file named `<name>.md` anywhere under rules/.
 * Returns its absolute path or null.
 * @param {string} name
 * @returns {string|null}
 */
function findRuleFile(name) {
  const root = path.join(FORGE_ROOT, 'rules');
  const target = `${name}.md`;
  /** @type {string[]} */
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name === target) return full;
    }
  }
  return null;
}

/**
 * Collect the rule component names contributed by a set of selected modules.
 * Preserves first-seen order, de-duplicated.
 * @param {any} modulesDoc @param {string[]} selected
 * @returns {string[]}
 */
function selectedRuleNames(modulesDoc, selected) {
  const out = [];
  const seen = new Set();
  for (const mod of selected) {
    const def = modulesDoc.modules?.[mod];
    const rules = def?.components?.rules || [];
    for (const r of rules) {
      if (!seen.has(r)) {
        seen.add(r);
        out.push(r);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan model: a list of files Forge intends to materialise.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PlannedFile
 * @property {string} rel      project-relative path (e.g. ".claude/AGENTS.md")
 * @property {string} abs      absolute target path
 * @property {string} [content] rendered content (absent for copy-from-source)
 * @property {string} [from]   absolute source path (for copies)
 * @property {boolean} marker  true for the generated .forge.json marker
 * @property {boolean} userEditable
 * @property {string} [note]   "(planned)" / informational
 */

// ---------------------------------------------------------------------------
// Subcommand: init  (the renderer)
// ---------------------------------------------------------------------------

/**
 * @param {string} dir @param {{ profile?: string, apply: boolean }} options
 * @returns {number} exit code
 */
function cmdInit(dir, options) {
  const projectDir = path.resolve(dir);
  if (!isDir(projectDir)) {
    process.stderr.write(`[forge] init: target is not a directory: ${projectDir}\n`);
    return 1;
  }

  const profilesDoc = loadProfiles();
  const modulesDoc = loadModules();

  // 1. Profile the target (in-memory).
  const facts = captureFacts(projectDir);

  // 2. Pick the profile (deterministic: --profile, else auto-select from facts).
  const { profile, reason } = pickProfile(profilesDoc, options.profile, facts);

  // 3. Resolve modules (+ best-effort moduleSelectionRules deltas).
  const { modules, added } = resolveModules(profilesDoc, profile, facts);

  // 4. Compute template variables.
  const vars = computeVars(facts, projectDir, profile, modules);

  // 5/6. Build the plan.
  const claudeRel = '.claude';
  const claudeAbs = path.join(projectDir, claudeRel);
  /** @type {PlannedFile[]} */
  const plan = [];

  const tplDir = path.join(FORGE_ROOT, 'bootstrap', 'templates');

  // -- AGENTS.md
  plan.push({
    rel: path.join(claudeRel, 'AGENTS.md'),
    abs: path.join(claudeAbs, 'AGENTS.md'),
    content: substitute(readText(path.join(tplDir, 'AGENTS.md.tmpl')), vars),
    marker: false,
    userEditable: true,
  });

  // -- settings.json (honour the _forge_when contract; validate by parse)
  let settingsContent = '';
  let settingsError = '';
  try {
    settingsContent = renderSettings(readText(path.join(tplDir, 'settings.json.tmpl')), vars);
  } catch (e) {
    settingsError = String(e && e.message);
  }
  plan.push({
    rel: path.join(claudeRel, 'settings.json'),
    abs: path.join(claudeAbs, 'settings.json'),
    content: settingsContent,
    marker: false,
    userEditable: true,
    note: settingsError ? `(ERROR rendering settings.json: ${settingsError})` : undefined,
  });

  // -- memory/index.md
  plan.push({
    rel: path.join(claudeRel, 'memory', 'index.md'),
    abs: path.join(claudeAbs, 'memory', 'index.md'),
    content: substitute(readText(path.join(tplDir, 'memory', 'index.md.tmpl')), vars),
    marker: false,
    userEditable: true,
  });

  // -- memory/entry.example.md (seed/example)
  plan.push({
    rel: path.join(claudeRel, 'memory', 'entry.example.md'),
    abs: path.join(claudeAbs, 'memory', 'entry.example.md'),
    content: substitute(readText(path.join(tplDir, 'memory', 'entry.md.tmpl')), vars),
    marker: false,
    userEditable: true,
  });

  // -- bundles/example-bundle.md  (only when context-bundles is selected)
  if (modules.includes('context-bundles')) {
    plan.push({
      rel: path.join(claudeRel, 'bundles', 'example-bundle.md'),
      abs: path.join(claudeAbs, 'bundles', 'example-bundle.md'),
      content: substitute(readText(path.join(tplDir, 'bundles', 'example-bundle.md.tmpl')), vars),
      marker: false,
      userEditable: true,
    });
  }

  // -- 6. Rule files for selected modules.
  const ruleNames = selectedRuleNames(modulesDoc, modules);
  /** @type {Array<{name:string, status:'copy'|'planned', from?:string}>} */
  const ruleStatuses = [];
  for (const name of ruleNames) {
    const src = findRuleFile(name);
    if (src) {
      ruleStatuses.push({ name, status: 'copy', from: src });
      plan.push({
        rel: path.join(claudeRel, 'rules', `${name}.md`),
        abs: path.join(claudeAbs, 'rules', `${name}.md`),
        from: src,
        marker: false,
        userEditable: true,
      });
    } else {
      ruleStatuses.push({ name, status: 'planned' });
    }
  }

  // -- profile-project.json (the facts the marker references).
  const factsJson = JSON.stringify(facts, null, 2) + '\n';
  plan.push({
    rel: path.join(claudeRel, 'profile-project.json'),
    abs: path.join(claudeAbs, 'profile-project.json'),
    content: factsJson,
    marker: false,
    userEditable: false,
  });

  // ---- Report the plan (always; this IS the dry-run output) ----
  const header = options.apply ? 'APPLY' : 'DRY-RUN';
  log(`\nForge init — ${header}`);
  log('================================================================');
  log(`  target project : ${projectDir}`);
  log(`  forge root     : ${FORGE_ROOT}`);
  log(`  forge version  : ${vars.FORGE_VERSION}  (raw: ${rawVersion()})`);
  log(`  profile        : ${profile}   (${reason})`);
  if (!options.profile) {
    const how = reason.startsWith('auto-selected') ? 'auto-selected from facts' : 'fell back to the default profile';
    log(`  note           : ${how} deterministically; the bootstrap-harness SKILL can override with --profile.`);
  }
  log(`  modules        : ${modules.join(', ')}`);
  if (added.length) {
    log('  module deltas  : ' + added.map((a) => `+${a.module} [${a.when}]`).join(', '));
  }
  log('');
  log('  Template variables:');
  for (const k of [
    'PROJECT_NAME', 'FORGE_VERSION', 'PROFILE', 'MODULES', 'GENERATED_AT',
    'LANGUAGES', 'STACK_SUMMARY', 'TEST_CMD', 'TYPECHECK_CMD', 'LINT_CMD',
    'FE_TEST_CMD', 'FE_TYPECHECK_CMD',
  ]) {
    log(`    {{${k}}} = ${JSON.stringify(vars[k])}`);
  }
  log('');
  if (ruleStatuses.length) {
    log('  Rule components (from selected modules):');
    for (const r of ruleStatuses) {
      log(`    ${r.status === 'copy' ? 'copy   ' : 'skip   '} ${r.name}${r.status === 'planned' ? '  (planned — not yet built)' : ''}`);
    }
    log('');
  }

  // ---- Determine per-file action (additive: never clobber) ----
  log('  Files:');
  /** @type {Array<{rel:string, action:string}>} */
  const fileActions = [];
  for (const f of plan) {
    if (exists(f.abs)) {
      fileActions.push({ rel: f.rel, action: 'SKIP (exists — preserved)' });
    } else {
      fileActions.push({ rel: f.rel, action: options.apply ? 'WRITE' : 'would write' });
    }
  }
  // Marker is computed/printed after we know what actually got written.
  for (const fa of fileActions) {
    log(`    ${fa.action.padEnd(26)} ${fa.rel}`);
  }
  log(`    ${(options.apply ? 'WRITE' : 'would write').padEnd(26)} ${path.join(claudeRel, '.forge.json')}  (marker)`);
  log('');

  if (!options.apply) {
    log('  DRY-RUN only — no files written. Re-run with --apply to materialise.');
    log('================================================================\n');
    return 0;
  }

  // ---- APPLY: write files additively, recording what we actually wrote ----
  /** @type {Array<{path:string, checksum:string, userEditable:boolean}>} */
  const markerFiles = [];
  const written = [];
  const skipped = [];

  for (const f of plan) {
    if (exists(f.abs)) {
      skipped.push(f.rel);
      process.stderr.write(`[forge] skip (exists, preserving user content): ${f.rel}\n`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(f.abs), { recursive: true });
      let content = f.content;
      if (content == null && f.from) content = readText(f.from);
      fs.writeFileSync(f.abs, content ?? '', 'utf8');
      written.push(f.rel);
      // Record EVERY file we wrote in the marker, path relative to projectDir.
      markerFiles.push({
        path: path.relative(projectDir, f.abs),
        checksum: 'sha256:' + sha256hex(content ?? ''),
        userEditable: true,
      });
    } catch (e) {
      process.stderr.write(`[forge] failed to write ${f.rel}: ${e && e.message}\n`);
    }
  }

  // ---- 7. Generate the marker IN CODE (never from a template) ----
  const markerAbs = path.join(claudeAbs, '.forge.json');
  const marker = {
    forgeVersion: vars.FORGE_VERSION,
    profile,
    modules,
    generatedAt: vars.GENERATED_AT,
    facts: 'profile-project.json',
    files: markerFiles,
  };
  // ADDITIVE provenance (ADR-0009, BR-FLEET-001/002): fold the LIBRARY Registry
  // contentHash of every component the marker's modules[] resolve to into one
  // deterministic sourceRev so the fleet can detect component-level drift. The
  // resolution targets the FORGE library (FORGE_ROOT/.forge/registry.json), not
  // the target project — init tailors AGAINST the library. This only adds the
  // optional `provenance` field (schema-widened, additive); every existing marker
  // field above is untouched, and a legacy marker without it stays valid. The
  // bridge lazy-loads manager/fleet.mjs, reached ONLY here in the --apply branch,
  // so a dry-run `forge init` still imports no manager module (EVAL-CLI-006).
  marker.provenance = {
    registrySchema: REGISTRY_SCHEMA_TAG,
    sourceRev: computeMarkerSourceRev(FORGE_ROOT, marker),
  };
  let markerWritten = false;
  if (exists(markerAbs)) {
    process.stderr.write(`[forge] skip (exists, preserving): ${path.join(claudeRel, '.forge.json')}\n`);
    skipped.push(path.join(claudeRel, '.forge.json'));
  } else {
    try {
      fs.mkdirSync(path.dirname(markerAbs), { recursive: true });
      fs.writeFileSync(markerAbs, JSON.stringify(marker, null, 2) + '\n', 'utf8');
      markerWritten = true;
      written.push(path.join(claudeRel, '.forge.json'));
    } catch (e) {
      process.stderr.write(`[forge] failed to write marker: ${e && e.message}\n`);
    }
  }

  log('  Applied:');
  log(`    wrote   : ${written.length} file(s)`);
  log(`    skipped : ${skipped.length} file(s) (already existed — preserved)`);
  if (!markerWritten && skipped.includes(path.join(claudeRel, '.forge.json'))) {
    log('    note    : marker already existed; re-run on a fresh dir or use `forge sync` to reconcile.');
  }
  log('================================================================\n');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: doctor  (read-only health check)
// ---------------------------------------------------------------------------

/**
 * Minimal hand-rolled structural check against marker.schema.json's required
 * shape. Returns a list of problem strings (empty = structurally valid).
 * @param {any} m
 * @returns {string[]}
 */
function validateMarkerShape(m) {
  const problems = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return ['marker is not a JSON object'];
  }
  const reqStr = ['forgeVersion', 'profile', 'generatedAt', 'facts'];
  for (const k of reqStr) {
    if (typeof m[k] !== 'string' || m[k].length < 1) {
      problems.push(`missing/invalid required string field: ${k}`);
    }
  }
  if (!Array.isArray(m.modules) || m.modules.length < 1) {
    problems.push('modules must be a non-empty array');
  } else if (!m.modules.every((x) => typeof x === 'string' && x.length >= 1)) {
    problems.push('modules must contain non-empty strings');
  }
  if (!Array.isArray(m.files)) {
    problems.push('files must be an array');
  } else {
    m.files.forEach((f, i) => {
      if (!f || typeof f !== 'object') {
        problems.push(`files[${i}] is not an object`);
        return;
      }
      if (typeof f.path !== 'string' || f.path.length < 1) problems.push(`files[${i}].path invalid`);
      if (typeof f.checksum !== 'string' || !/^sha256:[0-9a-f]+$/.test(f.checksum)) {
        problems.push(`files[${i}].checksum invalid (expected "sha256:<hex>")`);
      }
      if (typeof f.userEditable !== 'boolean') problems.push(`files[${i}].userEditable must be boolean`);
    });
  }
  return problems;
}

/**
 * @param {string} dir
 * @returns {number} exit code (0 healthy, 1 problems)
 */
function cmdDoctor(dir) {
  const projectDir = path.resolve(dir);
  const claudeAbs = path.join(projectDir, '.claude');
  const markerAbs = path.join(claudeAbs, '.forge.json');

  log(`\nForge doctor — read-only health check`);
  log('================================================================');
  log(`  target project : ${projectDir}`);

  if (!isFile(markerAbs)) {
    log(`  RESULT: no Forge marker at .claude/.forge.json`);
    log(`  -> run \`forge init ${dir} --apply\` to generate a harness.`);
    log('  ----------------------------------------------------------------');
    reportInstallState();
    // ADDITIVE manager-scope block (SPEC-08). Self-contained: reads
    // <project>/.forge/registry.json directly (no manager import/spawn — the hot
    // path stays manager-free, EVAL-CLI-006). Renders NOTHING when no manager
    // state exists, so this no-marker path stays byte-identical to baseline
    // (EVAL-INT-007). Advisory only: never alters the exit code (ADR-0007).
    reportManagerScope(projectDir);
    log('================================================================\n');
    return 1;
  }

  const marker = readJson(markerAbs);
  let problems = 0;
  let warnings = 0;

  // -- structural validation
  const shapeIssues = marker == null ? ['marker is not valid JSON'] : validateMarkerShape(marker);
  if (shapeIssues.length) {
    problems += shapeIssues.length;
    log(`  [FAIL] marker structure (${shapeIssues.length} issue(s)):`);
    for (const p of shapeIssues) log(`         - ${p}`);
  } else {
    log(`  [OK]   marker structurally valid (${marker.files.length} tracked file(s))`);
  }

  if (marker && typeof marker === 'object') {
    // -- version drift
    const cur = forgeVersion();
    if (marker.forgeVersion && marker.forgeVersion !== cur) {
      warnings++;
      log(`  [WARN] Forge version drift: marker ${JSON.stringify(marker.forgeVersion)} vs current ${JSON.stringify(cur)} — \`forge sync\` recommended`);
    } else if (marker.forgeVersion) {
      log(`  [OK]   Forge version matches (${cur})`);
    }

    // -- facts pointer
    if (typeof marker.facts === 'string') {
      const factsAbs = path.join(claudeAbs, marker.facts);
      if (isFile(factsAbs)) log(`  [OK]   facts present: .claude/${marker.facts}`);
      else {
        warnings++;
        log(`  [WARN] facts pointer missing on disk: .claude/${marker.facts}`);
      }
    }

    // -- per-file existence + checksum drift
    if (Array.isArray(marker.files)) {
      let missing = 0;
      let drifted = 0;
      for (const f of marker.files) {
        if (!f || typeof f.path !== 'string') continue;
        const fileAbs = path.join(projectDir, f.path);
        if (!isFile(fileAbs)) {
          missing++;
          problems++;
          log(`  [FAIL] tracked file missing: ${f.path}`);
          continue;
        }
        if (typeof f.checksum === 'string' && f.checksum.startsWith('sha256:')) {
          const actual = 'sha256:' + sha256hex(readText(fileAbs));
          if (actual !== f.checksum) {
            drifted++;
            log(`  [INFO] user-edited (checksum drift, will be preserved on sync): ${f.path}`);
          }
        }
      }
      if (missing === 0) log(`  [OK]   all ${marker.files.length} tracked file(s) present`);
      if (drifted > 0) log(`  [INFO] ${drifted} file(s) user-edited since generation (expected; sacred on sync)`);
    }

    // -- referenced hook commands/scripts exist
    const settingsAbs = path.join(claudeAbs, 'settings.json');
    if (isFile(settingsAbs)) {
      const settings = readJson(settingsAbs);
      const hookProblems = checkHookCommands(settings, projectDir);
      if (hookProblems.length) {
        for (const hp of hookProblems) {
          warnings++;
          log(`  [WARN] ${hp}`);
        }
      } else {
        log(`  [OK]   settings.json hook commands look resolvable`);
      }
    }
  }

  // -- global install state (independent of the project marker)
  log('  ----------------------------------------------------------------');
  reportInstallState();

  // -- ADDITIVE manager-scope block (SPEC-08). Appended AFTER the existing
  // per-project marker checks + install-state report. Self-contained (reads
  // <project>/.forge/registry.json directly; imports/spawns NO manager module,
  // so the hot path stays manager-free — EVAL-CLI-006). When no manager state
  // exists it renders nothing and `problems`/exit stay byte-identical to the
  // pre-manager baseline (EVAL-INT-007). Its WARN/INFO lines are advisory and
  // NEVER flip doctor's exit (ADR-0007); doctor stays the pass/fail command,
  // distinct from the informational `status` (EVAL-CLI-004).
  reportManagerScope(projectDir);

  log('----------------------------------------------------------------');
  if (problems > 0) {
    log(`  RESULT: ${problems} problem(s), ${warnings} warning(s) — UNHEALTHY`);
    log(`  (note: \`forge doctor --fix\` is planned; this phase never writes.)`);
    log('================================================================\n');
    return 1;
  }
  log(`  RESULT: healthy${warnings ? ` (${warnings} warning(s))` : ''}`);
  log('================================================================\n');
  return 0;
}

/**
 * ADDITIVE manager-scope report for `forge doctor` (SPEC-08 §"doctor extension").
 *
 * Reads the project's committed registry snapshot at <projectDir>/.forge/
 * registry.json DIRECTLY (the same fail-open readJson/isFile/sha256hex helpers
 * the rest of this file uses). It imports NO `forge/manager/*` module and spawns
 * nothing — so `forge doctor` stays off the manager hot path (EVAL-CLI-006 /
 * EVAL-INT-010). The "in sync" notion mirrors validate-registry's CONTENT-drift
 * check (compare each tracked artifact's on-disk hash to the recorded
 * contentHash) WITHOUT an in-memory rebuild (which would require importing the
 * manager). VERSION drift mirrors the snapshot's recorded VERSION vs the running
 * forgeVersion().
 *
 * "Manager state exists" means the project is Forge-managed at all: it has a
 * `.claude/.forge.json` marker (even a broken one) OR a `.forge/registry.json`
 * snapshot. Either one makes the manager scope RELEVANT, so the block appears.
 * A bare tree with NEITHER renders nothing (the keystone baseline path).
 *
 * INVARIANTS:
 *   - When no manager state exists (no marker AND no registry.json), emit
 *     NOTHING and return. doctor's output + exit then stay byte-identical to the
 *     pre-manager baseline (EVAL-INT-007, the keystone).
 *   - Every line here is advisory (OK / WARN / INFO). The caller does NOT add
 *     these to `problems`, so they NEVER flip doctor's exit code (ADR-0007).
 *     doctor remains the pass/fail health command; `status` is informational.
 *
 * @param {string} projectDir absolute project dir (the doctor target)
 * @returns {void}
 */
function reportManagerScope(projectDir) {
  const registryAbs = path.join(projectDir, '.forge', 'registry.json');
  const markerAbs = path.join(projectDir, '.claude', '.forge.json');
  const hasRegistry = isFile(registryAbs);
  const hasMarker = isFile(markerAbs);
  // Fail-open gate: no manager state at all → render nothing (additive;
  // baseline-safe). A bare tree (no marker, no registry) is untouched.
  if (!hasRegistry && !hasMarker) return;

  log('  ----------------------------------------------------------------');
  log('  MANAGER SCOPE (additive)');

  // -- Registry presence/sync. Absent registry is a fail-open "no data" INFO
  //    (the project is marker-managed but the catalog was never built).
  if (!hasRegistry) {
    log('  [INFO] registry not built: .forge/registry.json absent — run `forge registry build --write`');
    log('  [INFO] telemetry OFF · fleet not enabled');
    if (hasMarker) offerFleetRegistration(projectDir);
    return;
  }

  const registry = readJson(registryAbs);
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.artifacts)) {
    // Present but unreadable/malformed: advisory only (never fails doctor).
    log('  [WARN] registry present but unreadable/malformed: .forge/registry.json — run `forge registry build --write`');
    log('  [INFO] telemetry OFF · fleet not enabled');
    if (hasMarker) offerFleetRegistration(projectDir);
    return;
  }

  const count = registry.artifacts.length;
  const builtAt = typeof registry.generatedAt === 'string' && registry.generatedAt ? registry.generatedAt : 'unknown';

  // -- In-sync check: per-tracked-artifact on-disk content drift vs the recorded
  //    contentHash (mirrors validate-registry's CONTENT-drift WARN; no rebuild).
  //    A drifted/missing artifact file means the catalog may be stale.
  let drifted = 0;
  for (const a of registry.artifacts) {
    if (!a || typeof a.path !== 'string' || !a.path) continue;
    // Skip hook pseudo-paths (e.g. hooks/hooks.json#forge:secret-scan): the `#`
    // fragment names a sub-artifact, not a real file, so an on-disk isFile()/hash
    // check would always spuriously report it as missing/changed. The registry
    // (onDiskPathForRecord) and validate-registry both treat `#` paths as having
    // no on-disk presence — mirror that here so doctor reports ZERO drift for
    // them, matching validate-registry exactly. (Advisory output only.)
    if (a.path.includes('#')) continue;
    if (typeof a.contentHash !== 'string' || !a.contentHash) continue;
    const fileAbs = path.join(projectDir, a.path);
    if (!isFile(fileAbs)) {
      drifted++;
      continue;
    }
    if (sha256hex(readText(fileAbs)) !== a.contentHash) drifted++;
  }

  if (drifted === 0) {
    log(`  [OK]   registry present & in sync (${count} artifact(s), built ${builtAt})`);
  } else {
    log(`  [WARN] registry may be stale (${drifted} of ${count} tracked artifact(s) changed on disk since last build) — run \`forge registry build --write\``);
  }

  // -- VERSION drift: the snapshot's recorded VERSION vs the running forge.
  //    Advisory; tolerant of the `-design` pre-release suffix (SPEC-02).
  const snapVersion = typeof registry.VERSION === 'string' ? registry.VERSION : '';
  const cur = forgeVersion();
  if (snapVersion && stripDesignSuffix(snapVersion) !== cur) {
    log(`  [WARN] VERSION drift (registry ${JSON.stringify(snapVersion)} vs current ${JSON.stringify(cur)}) — run \`forge registry build --write\``);
  }

  // -- Telemetry / fleet posture (opt-in, default OFF; v0.4/v0.3 fill these in).
  //    Read-only detection of their state roots under <project>/.forge.
  const telemetryOn = isDir(path.join(projectDir, '.forge', 'telemetry')) &&
    isFile(path.join(projectDir, '.forge', 'telemetry', 'config.json'));
  const fleetEnabled = isFile(path.join(projectDir, '.forge', 'fleet.json'));
  log(`  [INFO] telemetry ${telemetryOn ? 'ON' : 'OFF'} · fleet ${fleetEnabled ? 'enabled' : 'not enabled'}`);

  // -- Fleet detect-and-offer (BR-FLEET-007/008, EVAL-FLEET-006). When the
  //    MACHINE-LOCAL fleet (~/.claude/forge/fleet.json) is opt-in ENABLED and
  //    this marker-managed project is NOT yet registered, OFFER registration —
  //    never silently register (global mutation needs explicit `fleet add`).
  //    Strictly READ-ONLY and fail-open: any error degrades to no offer.
  if (hasMarker) offerFleetRegistration(projectDir);
}

/**
 * READ-ONLY fleet detect-and-offer. Reads the machine-local fleet index; if the
 * fleet is enabled and `projectDir` is not among its registered projects, prints
 * a one-line OFFER to run `forge fleet add`. Writes NOTHING (invariant #3:
 * global mutation requires explicit confirmation). Fail-open on any error.
 * @param {string} projectDir
 * @returns {void}
 */
function offerFleetRegistration(projectDir) {
  try {
    const { home } = resolveClaudeHome();
    if (!home) return;
    const idxPath = path.join(home, '.claude', 'forge', 'fleet.json');
    const index = readJson(idxPath);
    if (!index || typeof index !== 'object' || index.fleetEnabled !== true) return;
    const projects = index.projects && typeof index.projects === 'object' ? index.projects : {};
    let real = projectDir;
    try {
      real = fs.realpathSync(projectDir);
    } catch {
      /* fall back to the given path */
    }
    const id = sha256hex(real).slice(0, 16);
    if (Object.prototype.hasOwnProperty.call(projects, id)) {
      log('  [OK]   fleet: this project is registered (tracked in ~/.claude/forge/fleet.json)');
      return;
    }
    log('  [INFO] fleet enabled but this project is unregistered — offer: run `forge fleet add .` to register (nothing written until you do)');
  } catch {
    /* fail-open: no offer */
  }
}

/** Strip a trailing `-design` pre-release suffix (mirrors forgeVersion). */
function stripDesignSuffix(v) {
  return typeof v === 'string' && v.endsWith('-design') ? v.slice(0, -'-design'.length) : v;
}

/**
 * Inspect settings.json hook commands and flag obviously-missing referenced
 * scripts. Best-effort: we only verify a leading local script path (./x or a
 * relative *.mjs/*.sh/*.js token) exists; tool invocations (uv, pnpm, …) are
 * assumed available on PATH and not flagged.
 * @param {any} settings @param {string} projectDir
 * @returns {string[]}
 */
function checkHookCommands(settings, projectDir) {
  /** @type {string[]} */
  const out = [];
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const event of Object.keys(hooks)) {
    const blocks = hooks[event];
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const inner = block?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const cmd = h?.command;
        if (typeof cmd !== 'string' || !cmd.trim()) continue;
        // Look for an explicit local-script token.
        const tokens = cmd.split(/\s+/);
        for (const t of tokens) {
          const looksLocal = t.startsWith('./') || t.startsWith('../') ||
            (/\.(mjs|cjs|js|sh|py)$/.test(t) && (t.includes('/') || t.startsWith('.')));
          if (looksLocal) {
            const abs = path.isAbsolute(t) ? t : path.join(projectDir, t);
            if (!exists(abs)) out.push(`${event} hook references missing script: ${t}`);
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Subcommand: sync  (minimal diff-plan stub)
// ---------------------------------------------------------------------------

/**
 * @param {string} dir @param {{ profile?: string }} options
 * @returns {number}
 */
function cmdSync(dir, options) {
  const projectDir = path.resolve(dir);
  const claudeAbs = path.join(projectDir, '.claude');
  const markerAbs = path.join(claudeAbs, '.forge.json');

  log(`\nForge sync — diff plan (read-only; full apply planned for Phase 4)`);
  log('================================================================');
  log(`  target project : ${projectDir}`);

  if (!isFile(markerAbs)) {
    log(`  No Forge marker found. Run \`forge init ${dir} --apply\` first.`);
    log('================================================================\n');
    return 1;
  }

  const marker = readJson(markerAbs);
  if (!marker || typeof marker !== 'object') {
    log(`  Marker is unreadable/invalid. Run \`forge doctor ${dir}\`.`);
    log('================================================================\n');
    return 1;
  }

  const profilesDoc = loadProfiles();
  const facts = captureFacts(projectDir);
  const { profile } = pickProfile(profilesDoc, options.profile || marker.profile, facts);
  const { modules } = resolveModules(profilesDoc, profile, facts);

  const oldMods = new Set(Array.isArray(marker.modules) ? marker.modules : []);
  const newMods = new Set(modules);
  const addedMods = [...newMods].filter((m) => !oldMods.has(m));
  const removedMods = [...oldMods].filter((m) => !newMods.has(m));

  log(`  profile (marker) : ${marker.profile}`);
  log(`  profile (now)    : ${profile}`);
  log(`  modules (marker) : ${[...oldMods].join(', ') || '(none)'}`);
  log(`  modules (now)    : ${[...newMods].join(', ') || '(none)'}`);
  log(`  modules added    : ${addedMods.join(', ') || '(none)'}`);
  log(`  modules removed  : ${removedMods.join(', ') || '(none)'}`);
  log('');

  // File checksum drift -> user-edited (sacred).
  if (Array.isArray(marker.files)) {
    const edited = [];
    const missing = [];
    for (const f of marker.files) {
      if (!f || typeof f.path !== 'string') continue;
      const abs = path.join(projectDir, f.path);
      if (!isFile(abs)) {
        missing.push(f.path);
        continue;
      }
      if (typeof f.checksum === 'string' && f.checksum.startsWith('sha256:')) {
        const actual = 'sha256:' + sha256hex(readText(abs));
        if (actual !== f.checksum) edited.push(f.path);
      }
    }
    log(`  user-edited files (checksum drift — would be PRESERVED): ${edited.length ? '' : '(none)'}`);
    for (const p of edited) log(`    - ${p}`);
    if (missing.length) {
      log(`  tracked files now missing: `);
      for (const p of missing) log(`    - ${p}`);
    }
  }

  log('');
  log('  full apply planned for Phase 4 — sync currently writes nothing.');
  log('================================================================\n');
  return 0;
}

// ===========================================================================
// Phase 4 — global plugin install / uninstall
//
// Strict separation preserved: FORGE_ROOT is the plugin payload (this repo);
// the TARGET here is the user's Claude Code config home, resolved from $HOME
// (NOT cwd) so it is sandbox-testable via `HOME=/tmp/... forge install`.
//
// What an install registers (mirrors how Claude Code actually tracks plugins,
// verified against a real ~/.claude/plugins layout):
//   1. A SYMLINK at <home>/.claude/plugins/marketplaces/forge -> FORGE_ROOT.
//      Using a symlink (not a copy) means edits to the library are live.
//   2. A marketplace entry in <home>/.claude/plugins/known_marketplaces.json
//      keyed "forge" -> { source:{source:'local',path:FORGE_ROOT}, installLocation }.
//   3. An installed-plugin record in <home>/.claude/plugins/installed_plugins.json
//      keyed "forge@forge" (v2 shape: an array of install records).
//   4. settings.json MERGE: enabledPlugins["forge@forge"]=true and a mirror
//      extraKnownMarketplaces.forge (so the marketplace is known even if the
//      plugins/ json is reset). Both merged; prior values recorded for restore.
//
// All of it is recorded in <home>/.claude/.forge-install-state.json. ADDITIVE:
// if any of our keys/paths already exist with FOREIGN content, install STOPS.
// ===========================================================================

const FORGE_PLUGIN_NAME = 'forge';
const FORGE_MARKETPLACE = 'forge';
const FORGE_PLUGIN_REF = `${FORGE_PLUGIN_NAME}@${FORGE_MARKETPLACE}`;
const INSTALL_STATE_VERSION = 'forge.install.v1';

/**
 * Resolve the user's Claude config home from $HOME (sandbox-friendly).
 * @returns {{ home: string, claudeDir: string, pluginsDir: string,
 *   marketplacesDir: string, marketplaceLink: string, knownMarketplaces: string,
 *   installedPlugins: string, settings: string, statePath: string }}
 */
function resolveClaudeHome() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const claudeDir = path.join(home, '.claude');
  const pluginsDir = path.join(claudeDir, 'plugins');
  const marketplacesDir = path.join(pluginsDir, 'marketplaces');
  return {
    home,
    claudeDir,
    pluginsDir,
    marketplacesDir,
    marketplaceLink: path.join(marketplacesDir, FORGE_MARKETPLACE),
    knownMarketplaces: path.join(pluginsDir, 'known_marketplaces.json'),
    installedPlugins: path.join(pluginsDir, 'installed_plugins.json'),
    settings: path.join(claudeDir, 'settings.json'),
    statePath: path.join(claudeDir, '.forge-install-state.json'),
  };
}

/** @param {string} p Read the symlink target, or '' if not a symlink/unreadable. */
function readLink(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return '';
  }
}
/** @param {string} p true if p is a symlink (even a dangling one). */
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Build the full install plan (pure — performs NO writes). Surfaces every
 * intended change plus any blocking conflict (foreign pre-existing content).
 * @returns {{
 *   loc: ReturnType<typeof resolveClaudeHome>,
 *   alreadyInstalled: boolean,
 *   conflicts: string[],
 *   actions: Array<{ kind: string, target: string, detail: string }>,
 *   settingsPlan: { enabledPlugins: {prior: any, set: boolean},
 *                   extraKnownMarketplaces: {prior: any, set: boolean},
 *                   fileExists: boolean, parseError: string },
 *   knownMarketplacesPrior: any,
 *   installedPluginsPrior: any,
 * }}
 */
function planInstall() {
  const loc = resolveClaudeHome();
  /** @type {string[]} */
  const conflicts = [];
  /** @type {Array<{kind:string, target:string, detail:string}>} */
  const actions = [];

  if (!loc.home) {
    conflicts.push('$HOME is not set; cannot resolve ~/.claude');
  }

  // -- detect a prior Forge install (so we can no-op / report idempotently).
  const existingState = readJson(loc.statePath);
  const alreadyInstalled =
    existingState && typeof existingState === 'object' &&
    existingState.schemaVersion === INSTALL_STATE_VERSION;

  // -- 1. symlink marketplaces/forge -> FORGE_ROOT
  if (exists(loc.marketplaceLink) || isSymlink(loc.marketplaceLink)) {
    const tgt = readLink(loc.marketplaceLink);
    if (isSymlink(loc.marketplaceLink) && path.resolve(tgt) === path.resolve(FORGE_ROOT)) {
      actions.push({ kind: 'symlink', target: loc.marketplaceLink, detail: `already -> ${FORGE_ROOT} (ok)` });
    } else {
      conflicts.push(
        `${loc.marketplaceLink} already exists (${isSymlink(loc.marketplaceLink) ? `symlink -> ${tgt}` : 'real path'}) — refusing to clobber`,
      );
    }
  } else {
    actions.push({ kind: 'symlink', target: loc.marketplaceLink, detail: `-> ${FORGE_ROOT}` });
  }

  // -- 2. known_marketplaces.json (merge key "forge")
  const km = readJson(loc.knownMarketplaces);
  if (km !== null && (typeof km !== 'object' || Array.isArray(km))) {
    conflicts.push(`${loc.knownMarketplaces} is not a JSON object — refusing to edit`);
  } else if (km && Object.prototype.hasOwnProperty.call(km, FORGE_MARKETPLACE) && !alreadyInstalled) {
    conflicts.push(`known_marketplaces.json already has a "${FORGE_MARKETPLACE}" entry — refusing to clobber`);
  } else {
    actions.push({ kind: 'merge', target: loc.knownMarketplaces, detail: `add marketplace "${FORGE_MARKETPLACE}"` });
  }

  // -- 3. installed_plugins.json (merge key "forge@forge")
  const ip = readJson(loc.installedPlugins);
  if (ip !== null && (typeof ip !== 'object' || Array.isArray(ip))) {
    conflicts.push(`${loc.installedPlugins} is not a JSON object — refusing to edit`);
  } else if (ip && ip.plugins && Object.prototype.hasOwnProperty.call(ip.plugins, FORGE_PLUGIN_REF) && !alreadyInstalled) {
    conflicts.push(`installed_plugins.json already has "${FORGE_PLUGIN_REF}" — refusing to clobber`);
  } else {
    actions.push({ kind: 'merge', target: loc.installedPlugins, detail: `add plugin "${FORGE_PLUGIN_REF}"` });
  }

  // -- 4. settings.json (merge enabledPlugins + extraKnownMarketplaces)
  const settingsPlan = {
    enabledPlugins: { prior: undefined, set: false },
    extraKnownMarketplaces: { prior: undefined, set: false },
    fileExists: isFile(loc.settings),
    parseError: '',
  };
  const settings = settingsPlan.fileExists ? readJson(loc.settings) : {};
  if (settingsPlan.fileExists && (settings === null || typeof settings !== 'object' || Array.isArray(settings))) {
    settingsPlan.parseError = 'settings.json is not a JSON object';
    conflicts.push(`${loc.settings} is not a JSON object — refusing to edit`);
  } else {
    const s = settings || {};
    const ep = s.enabledPlugins;
    if (ep && Object.prototype.hasOwnProperty.call(ep, FORGE_PLUGIN_REF) && !alreadyInstalled) {
      conflicts.push(`settings.enabledPlugins already has "${FORGE_PLUGIN_REF}" — refusing to clobber`);
    } else {
      settingsPlan.enabledPlugins.prior =
        ep && Object.prototype.hasOwnProperty.call(ep, FORGE_PLUGIN_REF) ? ep[FORGE_PLUGIN_REF] : undefined;
      settingsPlan.enabledPlugins.set = true;
      actions.push({ kind: 'settings', target: loc.settings, detail: `set enabledPlugins["${FORGE_PLUGIN_REF}"]=true` });
    }
    const ekm = s.extraKnownMarketplaces;
    if (ekm && Object.prototype.hasOwnProperty.call(ekm, FORGE_MARKETPLACE) && !alreadyInstalled) {
      conflicts.push(`settings.extraKnownMarketplaces already has "${FORGE_MARKETPLACE}" — refusing to clobber`);
    } else {
      settingsPlan.extraKnownMarketplaces.prior =
        ekm && Object.prototype.hasOwnProperty.call(ekm, FORGE_MARKETPLACE) ? ekm[FORGE_MARKETPLACE] : undefined;
      settingsPlan.extraKnownMarketplaces.set = true;
      actions.push({ kind: 'settings', target: loc.settings, detail: `set extraKnownMarketplaces["${FORGE_MARKETPLACE}"]` });
    }
  }

  return {
    loc,
    alreadyInstalled: Boolean(alreadyInstalled),
    existingState: alreadyInstalled ? existingState : null,
    conflicts,
    actions,
    settingsPlan,
    knownMarketplacesPrior: km,
    installedPluginsPrior: ip,
    // Pre-existence of files/containers (captured BEFORE any write) so uninstall
    // can remove exactly what install created and leave the rest pristine.
    preexist: {
      knownMarketplacesFile: isFile(loc.knownMarketplaces),
      installedPluginsFile: isFile(loc.installedPlugins),
      settingsFile: isFile(loc.settings),
      settingsEnabledPluginsContainer: Boolean(
        settings && typeof settings === 'object' && settings.enabledPlugins && typeof settings.enabledPlugins === 'object',
      ),
      settingsExtraKnownMarketplacesContainer: Boolean(
        settings && typeof settings === 'object' && settings.extraKnownMarketplaces && typeof settings.extraKnownMarketplaces === 'object',
      ),
    },
  };
}

/** Marketplace descriptor we register for Forge (local source). */
function forgeMarketplaceEntry(loc) {
  return {
    source: { source: 'local', path: FORGE_ROOT },
    installLocation: loc.marketplaceLink,
    lastUpdated: new Date().toISOString(),
  };
}
/** installed_plugins.json record for Forge (v2 shape: array of records). */
function forgeInstalledRecord() {
  return {
    scope: 'user',
    installPath: FORGE_ROOT,
    version: pluginManifestVersion(),
    installedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    source: 'forge install (symlink, live)',
  };
}
/** Read the plugin version from .claude-plugin/plugin.json, falling back. */
function pluginManifestVersion() {
  const pj = readJson(path.join(FORGE_ROOT, '.claude-plugin', 'plugin.json'));
  return (pj && typeof pj.version === 'string' && pj.version) || forgeVersion();
}

/**
 * @param {{ apply: boolean }} options
 * @returns {number} exit code
 */
function cmdInstall(options) {
  const plan = planInstall();
  const loc = plan.loc;
  const header = options.apply ? 'APPLY' : 'DRY-RUN';

  log(`\nForge install — ${header}`);
  log('================================================================');
  log(`  forge root      : ${FORGE_ROOT}`);
  log(`  claude home     : ${loc.claudeDir}  (from $HOME)`);
  log(`  plugin ref      : ${FORGE_PLUGIN_REF}`);
  log(`  install state   : ${loc.statePath}`);
  if (plan.alreadyInstalled) {
    log('  note            : a Forge install-state already exists; install is idempotent (re-applies the same registration).');
  }
  log('');

  log('  Planned changes (all ADDITIVE — nothing existing is overwritten):');
  for (const a of plan.actions) {
    const verb = options.apply ? a.kind.toUpperCase() : `would ${a.kind}`;
    log(`    ${verb.padEnd(16)} ${a.target}`);
    log(`    ${''.padEnd(16)}   ${a.detail}`);
  }
  log('');

  // No-clobber assertion.
  if (plan.conflicts.length) {
    log('  [STOP] no-clobber assertion FAILED — Forge will not overwrite existing assets:');
    for (const c of plan.conflicts) log(`    - ${c}`);
    log('  Resolve/remove the conflicting items (or `forge uninstall`) and retry.');
    log('================================================================\n');
    return 1;
  }
  log('  [OK]   no-clobber assertion: every target is absent or already ours.');

  if (!options.apply) {
    log('');
    log('  DRY-RUN only — NOTHING written. Re-run with --apply to perform the install.');
    log('================================================================\n');
    return 0;
  }

  // ---- APPLY ----
  /** @type {Array<{kind:string, target:string, prior?:any}>} */
  const performed = [];
  try {
    // 1. symlink
    if (!(isSymlink(loc.marketplaceLink) && path.resolve(readLink(loc.marketplaceLink)) === path.resolve(FORGE_ROOT))) {
      fs.mkdirSync(loc.marketplacesDir, { recursive: true });
      fs.symlinkSync(FORGE_ROOT, loc.marketplaceLink);
      performed.push({ kind: 'symlink', target: loc.marketplaceLink });
    }

    // 2. known_marketplaces.json
    {
      const km = plan.knownMarketplacesPrior && typeof plan.knownMarketplacesPrior === 'object'
        ? plan.knownMarketplacesPrior : {};
      const priorHad = Object.prototype.hasOwnProperty.call(km, FORGE_MARKETPLACE);
      km[FORGE_MARKETPLACE] = forgeMarketplaceEntry(loc);
      writeJsonFile(loc.knownMarketplaces, km);
      performed.push({ kind: 'known_marketplaces', target: loc.knownMarketplaces, prior: priorHad ? 'existed' : 'created-key' });
    }

    // 3. installed_plugins.json
    {
      const ip = plan.installedPluginsPrior && typeof plan.installedPluginsPrior === 'object'
        ? plan.installedPluginsPrior : { version: 2, plugins: {} };
      if (!ip.plugins || typeof ip.plugins !== 'object') ip.plugins = {};
      if (typeof ip.version !== 'number') ip.version = 2;
      const priorHad = Object.prototype.hasOwnProperty.call(ip.plugins, FORGE_PLUGIN_REF);
      ip.plugins[FORGE_PLUGIN_REF] = [forgeInstalledRecord()];
      writeJsonFile(loc.installedPlugins, ip);
      performed.push({ kind: 'installed_plugins', target: loc.installedPlugins, prior: priorHad ? 'existed' : 'created-key' });
    }

    // 4. settings.json (merge; record EXACT prior values for restore)
    {
      const s = isFile(loc.settings) ? (readJson(loc.settings) || {}) : {};
      if (plan.settingsPlan.enabledPlugins.set) {
        if (!s.enabledPlugins || typeof s.enabledPlugins !== 'object') s.enabledPlugins = {};
        s.enabledPlugins[FORGE_PLUGIN_REF] = true;
      }
      if (plan.settingsPlan.extraKnownMarketplaces.set) {
        if (!s.extraKnownMarketplaces || typeof s.extraKnownMarketplaces !== 'object') s.extraKnownMarketplaces = {};
        s.extraKnownMarketplaces[FORGE_MARKETPLACE] = { source: { source: 'local', path: FORGE_ROOT } };
      }
      writeJsonFile(loc.settings, s);
      performed.push({ kind: 'settings', target: loc.settings });
    }

    // ---- write the install state for clean reversal ----
    // On a re-install (alreadyInstalled), the on-disk settings already carry OUR
    // keys, so re-deriving "prior" from them would record OUR own value as the
    // user's — corrupting reversal. Instead, PRESERVE the original install-state's
    // prior records (and original symlink-created flag) verbatim.
    const prev = plan.existingState;
    const symlinkCreatedNow = performed.some((p) => p.kind === 'symlink');
    const symlinkRecord = prev && prev.created
      ? (prev.created.symlink || (symlinkCreatedNow ? loc.marketplaceLink : null))
      : (symlinkCreatedNow ? loc.marketplaceLink : null);
    const epPrior = prev && prev.settings?.enabledPlugins
      ? prev.settings.enabledPlugins
      : {
          key: FORGE_PLUGIN_REF,
          existedBefore: plan.settingsPlan.enabledPlugins.prior !== undefined,
          priorValue: plan.settingsPlan.enabledPlugins.prior ?? null,
        };
    const ekmPrior = prev && prev.settings?.extraKnownMarketplaces
      ? prev.settings.extraKnownMarketplaces
      : {
          key: FORGE_MARKETPLACE,
          existedBefore: plan.settingsPlan.extraKnownMarketplaces.prior !== undefined,
          priorValue: plan.settingsPlan.extraKnownMarketplaces.prior ?? null,
        };

    const state = {
      schemaVersion: INSTALL_STATE_VERSION,
      installedAt: (prev && prev.installedAt) || new Date().toISOString(),
      lastInstalledAt: new Date().toISOString(),
      forgeRoot: FORGE_ROOT,
      forgeVersion: pluginManifestVersion(),
      pluginRef: FORGE_PLUGIN_REF,
      marketplace: FORGE_MARKETPLACE,
      created: {
        // symlink we created (null if it pre-existed correct & we left it)
        symlink: symlinkRecord,
        knownMarketplacesKey: FORGE_MARKETPLACE,
        installedPluginsKey: FORGE_PLUGIN_REF,
      },
      // Whether each file/container pre-existed (preserve the ORIGINAL on
      // re-install) so uninstall can delete files/containers Forge created and
      // leave the rest exactly as found.
      preexist: (prev && prev.preexist) || plan.preexist,
      // EXACT prior values so uninstall restores or deletes precisely.
      settings: {
        path: loc.settings,
        enabledPlugins: epPrior,
        extraKnownMarketplaces: ekmPrior,
      },
    };
    writeJsonFile(loc.statePath, state);

    log('');
    log('  Applied:');
    for (const p of performed) log(`    ${p.kind.padEnd(20)} ${p.target}`);
    log(`    state                ${loc.statePath}`);
    log('');
    log('  Forge is registered. Restart Claude Code (or reload) to pick up the plugin.');
    log('  Reverse anytime with: forge uninstall --apply');
    log('================================================================\n');
    return 0;
  } catch (e) {
    process.stderr.write(`[forge] install failed: ${e && e.message}\n`);
    log('  Install aborted mid-way; run `forge uninstall --apply` then retry, or inspect the state file.');
    log('================================================================\n');
    return 1;
  }
}

/**
 * @param {{ apply: boolean }} options
 * @returns {number} exit code
 */
function cmdUninstall(options) {
  const loc = resolveClaudeHome();
  const header = options.apply ? 'APPLY' : 'DRY-RUN';
  log(`\nForge uninstall — ${header}`);
  log('================================================================');
  log(`  claude home     : ${loc.claudeDir}  (from $HOME)`);
  log(`  install state   : ${loc.statePath}`);

  const state = readJson(loc.statePath);
  if (!state || typeof state !== 'object' || state.schemaVersion !== INSTALL_STATE_VERSION) {
    log('  No Forge install-state found (or unrecognized). Nothing to uninstall.');
    log('  (Forge only removes what its own install-state recorded — never guesses.)');
    log('================================================================\n');
    return 0;
  }

  /** @type {Array<{kind:string, detail:string}>} */
  const steps = [];
  // 1. symlink (only if WE created it)
  if (state.created && state.created.symlink) {
    steps.push({ kind: 'remove-symlink', detail: state.created.symlink });
  }
  // 2. known_marketplaces.json key
  steps.push({ kind: 'remove-known-marketplace', detail: `${loc.knownMarketplaces} :: "${FORGE_MARKETPLACE}"` });
  // 3. installed_plugins.json key
  steps.push({ kind: 'remove-installed-plugin', detail: `${loc.installedPlugins} :: "${FORGE_PLUGIN_REF}"` });
  // 4. settings.json restore
  const epRestore = state.settings?.enabledPlugins;
  const ekmRestore = state.settings?.extraKnownMarketplaces;
  steps.push({
    kind: 'settings-enabledPlugins',
    detail: epRestore?.existedBefore
      ? `restore prior value ${JSON.stringify(epRestore.priorValue)}`
      : `delete key "${FORGE_PLUGIN_REF}"`,
  });
  steps.push({
    kind: 'settings-extraKnownMarketplaces',
    detail: ekmRestore?.existedBefore
      ? `restore prior value`
      : `delete key "${FORGE_MARKETPLACE}"`,
  });
  steps.push({ kind: 'remove-state', detail: loc.statePath });

  log('');
  log('  Planned reversal (only items Forge recorded in its install-state):');
  for (const s of steps) {
    log(`    ${(options.apply ? s.kind : 'would ' + s.kind).padEnd(34)} ${s.detail}`);
  }
  log('');

  if (!options.apply) {
    log('  DRY-RUN only — NOTHING changed. Re-run with --apply to reverse.');
    log('================================================================\n');
    return 0;
  }

  // ---- APPLY reversal ----
  let problems = 0;
  // 1. symlink
  if (state.created && state.created.symlink) {
    try {
      if (isSymlink(state.created.symlink)) {
        fs.unlinkSync(state.created.symlink);
      } else if (exists(state.created.symlink)) {
        process.stderr.write(`[forge] not a symlink, leaving in place: ${state.created.symlink}\n`);
      }
    } catch (e) {
      problems++;
      process.stderr.write(`[forge] failed to remove symlink: ${e && e.message}\n`);
    }
  }
  const pre = state.preexist || {};
  // 2. known_marketplaces.json — drop our key; if WE created the whole file and
  //    it's now empty, remove the file so the home is left pristine.
  {
    const km = readJson(loc.knownMarketplaces);
    if (km && typeof km === 'object' && Object.prototype.hasOwnProperty.call(km, FORGE_MARKETPLACE)) {
      delete km[FORGE_MARKETPLACE];
      try {
        if (pre.knownMarketplacesFile === false && Object.keys(km).length === 0) {
          fs.unlinkSync(loc.knownMarketplaces);
        } else {
          writeJsonFile(loc.knownMarketplaces, km);
        }
      } catch (e) { problems++; process.stderr.write(`[forge] ${e && e.message}\n`); }
    }
  }
  // 3. installed_plugins.json — same treatment.
  {
    const ip = readJson(loc.installedPlugins);
    if (ip && typeof ip === 'object' && ip.plugins && Object.prototype.hasOwnProperty.call(ip.plugins, FORGE_PLUGIN_REF)) {
      delete ip.plugins[FORGE_PLUGIN_REF];
      try {
        if (pre.installedPluginsFile === false && Object.keys(ip.plugins).length === 0) {
          fs.unlinkSync(loc.installedPlugins);
        } else {
          writeJsonFile(loc.installedPlugins, ip);
        }
      } catch (e) { problems++; process.stderr.write(`[forge] ${e && e.message}\n`); }
    }
  }
  // 4. settings.json restore (exact prior values). If WE created a container
  //    (enabledPlugins / extraKnownMarketplaces) and it's now empty, drop it.
  {
    const s = isFile(loc.settings) ? readJson(loc.settings) : null;
    if (s && typeof s === 'object') {
      if (s.enabledPlugins && typeof s.enabledPlugins === 'object') {
        if (epRestore?.existedBefore) s.enabledPlugins[FORGE_PLUGIN_REF] = epRestore.priorValue;
        else delete s.enabledPlugins[FORGE_PLUGIN_REF];
        if (pre.settingsEnabledPluginsContainer === false && Object.keys(s.enabledPlugins).length === 0) {
          delete s.enabledPlugins;
        }
      }
      if (s.extraKnownMarketplaces && typeof s.extraKnownMarketplaces === 'object') {
        if (ekmRestore?.existedBefore) s.extraKnownMarketplaces[FORGE_MARKETPLACE] = ekmRestore.priorValue;
        else delete s.extraKnownMarketplaces[FORGE_MARKETPLACE];
        if (pre.settingsExtraKnownMarketplacesContainer === false && Object.keys(s.extraKnownMarketplaces).length === 0) {
          delete s.extraKnownMarketplaces;
        }
      }
      try { writeJsonFile(loc.settings, s); } catch (e) { problems++; process.stderr.write(`[forge] ${e && e.message}\n`); }
    }
  }
  // 5. remove state file (last — it's our source of truth)
  try {
    if (exists(loc.statePath)) fs.unlinkSync(loc.statePath);
  } catch (e) {
    problems++;
    process.stderr.write(`[forge] failed to remove state file: ${e && e.message}\n`);
  }

  log('  Reversed:');
  log(`    ${problems === 0 ? 'all recorded changes undone' : problems + ' problem(s) — see stderr'}`);
  log('  Restart Claude Code to drop the plugin from the session.');
  log('================================================================\n');
  return problems === 0 ? 0 : 1;
}

/**
 * Write a JSON file with 2-space indent + trailing newline, creating parent
 * dirs as needed. Throws on failure (callers handle).
 * @param {string} p @param {any} obj
 */
function writeJsonFile(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Report the global install state for `forge doctor` (read-only).
 * @returns {void}
 */
function reportInstallState() {
  const loc = resolveClaudeHome();
  const state = readJson(loc.statePath);
  if (!state || typeof state !== 'object' || state.schemaVersion !== INSTALL_STATE_VERSION) {
    log(`  [INFO] global install: not installed (no ${path.basename(loc.statePath)} in ~/.claude)`);
    return;
  }
  const linkOk = isSymlink(loc.marketplaceLink) &&
    path.resolve(readLink(loc.marketplaceLink)) === path.resolve(FORGE_ROOT);
  const km = readJson(loc.knownMarketplaces);
  const ip = readJson(loc.installedPlugins);
  const settings = readJson(loc.settings);
  const kmOk = km && typeof km === 'object' && Object.prototype.hasOwnProperty.call(km, FORGE_MARKETPLACE);
  const ipOk = ip && ip.plugins && Object.prototype.hasOwnProperty.call(ip.plugins, FORGE_PLUGIN_REF);
  const enabled = settings && settings.enabledPlugins && settings.enabledPlugins[FORGE_PLUGIN_REF] === true;

  log(`  [${linkOk && kmOk && ipOk && enabled ? 'OK' : 'WARN'}]   global install: registered as ${FORGE_PLUGIN_REF} (installed ${state.installedAt})`);
  log(`         symlink             : ${linkOk ? 'OK -> ' + FORGE_ROOT : 'MISSING/DRIFTED at ' + loc.marketplaceLink}`);
  log(`         known_marketplaces  : ${kmOk ? 'OK' : 'MISSING'}`);
  log(`         installed_plugins   : ${ipOk ? 'OK' : 'MISSING'}`);
  log(`         settings.enabled    : ${enabled ? 'OK' : 'NOT enabled'}`);
}

// ---------------------------------------------------------------------------
// Output helper
// ---------------------------------------------------------------------------

/** @param {string} s */
function log(s) {
  process.stdout.write(s + '\n');
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function usage() {
  const v = rawVersion();
  log(`forge — a self-tailoring Claude Code harness (v${v})

USAGE
  forge <command> [dir] [options]

COMMANDS
  profile [dir] [--write]            Deterministically profile a project's stack.
                                     --write also saves .claude/profile-project.json.
  validate [--strict] [dir]          Run Forge's self-validators (delegates to lint/run-all).
  init [dir] [--profile <name>]      Render a tailored harness into <dir>/.claude/.
       [--apply]                     DRY-RUN by default; --apply writes (additive, never clobbers).
  doctor [dir]                       Read-only health check of an existing harness. (--fix planned.)
  sync [dir]                         Show a diff plan vs the marker. (Full apply planned for Phase 4.)
  install [--apply]                  Register Forge as a Claude Code plugin in ~/.claude.
                                     DRY-RUN by default; --apply symlinks the repo + MERGES settings
                                     (additive, no-clobber) and writes ~/.claude/.forge-install-state.json.
  uninstall [--apply]               Reverse a Forge install precisely via the state file.
                                     DRY-RUN by default; --apply removes only what install recorded.
  help                               This message.

MANAGER (harness management layer)
  status                             At-a-glance dashboard across all dimensions. Read-only.
  registry <verb>                    Artifact catalog, identity & dependency graph.
      build [--write] | ls [--kind <k>] | show <uid> | changed [--since <ref>]
      deps <uid> | rdeps <uid> | orphans | dangling      forward/reverse deps, orphans, dangling refs
      bump <uid> | log [<uid>] | diff <a> <b> | roll-up (v0.3+)
  fleet <verb>                       Where harnesses are installed (opt-in cache, default OFF).
      enable | status | add <project> | scan | drift     register & track installed harnesses
      sync [--all|<id>] | relink | forget | prune | ignore | pin   (v0.5)
  memory <verb>                      The project's curated memory vault (docs/METHOD.md §8).
      list | validate | reindex [--write] | import <srcDir> [--apply]   read/reindex/import entries
  mcp <verb>                         Enable/disable a catalog MCP server in .claude/settings.json (additive).
      list | enable <name> [--apply] | disable <name> [--apply]   merge/remove mcpServers entries
  source <verb>                      Register external repos as federated catalog sources (ADR-0017).
      list | add <id> <url> [--ref <r>] [--apply] | remove <id> [--apply] | sync [id] | trust <id>
  catalog <verb>                     Unified catalog (library ∪ synced sources) + admission (ADR-0017).
      build | ls | dedup | admit <uid> | revoke <uid>     (planned: catalog-until-admitted)
  slice <verb>                       Catalog slices + per-project subscriptions (ADR-0018).
      list [--source <id>] | subscribe <sliceId> [--apply] | unsubscribe <sliceId> [--apply]
  compose <verb>                     Per-project composition: resources adopted from the read-view (ADR-0019).
      list | adopt <uid> [--source <id>] [--apply] | remove <uid> [--source <id>] [--apply]
  conflict <verb>                    Per-project conflicts + adjudication: read-view uids with >= 2 candidates (ADR-0020).
      list [--json] | resolve <uid> --winner <sourceId|library> [--apply] | policy [--set <dim>=auto|block] [--apply]
  tailor <verb>                      Per-project tailoring overlays on adopted resources + resolved preview (ADR-0021).
      list [--json] | add <uid> --type <t> --detail <s> [--source <id>] [--apply] | remove <uid> --type <t> [--detail <s>] [--apply]
  lock <verb>                        Resolved per-project lockfile forge.lock: adopted ∪ overlays ∪ adjudication ∪ pins + a hash (ADR-0022).
      show [--json] | write [--apply] | diff [--json]
  analyze [dir]                      Static context-budget report (token estimates). Read-only.
  telemetry <verb>                   Local-only, opt-in usage signals (default OFF).
      on | off | status | prune | wipe | stat | monitor  toggle/read local usage signals
  stat [--since <ref>]               Telemetry rollup (alias of 'telemetry stat'). Read-only.
  monitor                            At-a-glance telemetry snapshot (alias of 'telemetry monitor'). Read-only.
  eval-harness [uid|--changed|--all|--report]  Behavioral eval of the harness. Read/write results.
  optimize                           Dry-run prune/trim plan (--apply to act). (v0.6, planned)

GLOBAL FLAGS (manager)
  --json            Machine-readable envelope instead of human text.
  --dry-run/--apply Writers are DRY-RUN by default; --apply (or --write for registry) persists.
  --strict          Count advisory WARN findings toward the exit code.
  --quiet           Suppress human banners.

NOTES
  - "dir" is the TARGET project (default: current directory). It is kept strictly
    separate from FORGE_ROOT (the library: ${FORGE_ROOT}).
  - install/uninstall resolve ~/.claude from $HOME (sandbox-testable). They never
    overwrite existing plugin/marketplace/settings keys — if one exists, install STOPS.
  - Profile SELECTION: --profile always wins. With no flag, init AUTO-SELECTS a
    best-fit profile deterministically from facts (materialized ∪ intended); the
    bootstrap-harness SKILL can override via --profile.
  - status is informational (always exits 0); doctor is the pass/fail health command.
  - No background process. Telemetry is opt-in, local-only, never networked.
  - Every manager writer is dry-run by default; nothing mutates without --apply/--write.
`);
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const { positional, flags, opts } = parseArgs(rest);
  const dir = positional[0] || process.cwd();

  switch (cmd) {
    case 'profile': {
      // Delegate, passing through positional dir + --write (and any other flags).
      process.exit(delegateInherit('bootstrap/profile-project.mjs', rest, process.cwd()));
      return;
    }
    case 'validate': {
      // Delegate to run-all. Pass --strict and --json through; rootDir is
      // FORGE_ROOT unless a dir was explicitly given (validators target the
      // Forge repo by default). --json makes run-all synthesize the C3 envelope
      // (EVAL-CLI-002/008); the child validators themselves are unchanged.
      const args = [];
      if (flags.has('strict')) args.push('--strict');
      if (flags.has('json')) args.push('--json');
      if (positional[0]) args.push(positional[0]);
      process.exit(delegateInherit('lint/run-all.mjs', args, FORGE_ROOT));
      return;
    }
    case 'init':
      process.exit(cmdInit(dir, { profile: opts.profile, apply: flags.has('apply') }));
      return;
    case 'doctor':
      process.exit(cmdDoctor(dir));
      return;
    case 'sync':
      process.exit(cmdSync(dir, { profile: opts.profile }));
      return;
    case 'install':
      process.exit(cmdInstall({ apply: flags.has('apply') }));
      return;
    case 'uninstall':
      process.exit(cmdUninstall({ apply: flags.has('apply') }));
      return;

    // ----- MANAGER taxonomy (SPEC-08) — dispatched by DELEGATION to the dual-
    // mode child modules. main() stays SYNCHRONOUS: delegateInherit spawns a
    // child process (a process boundary), so the manager modules never load on
    // the hot path (EVAL-CLI-006). Post-verb args are forwarded VERBATIM; each
    // child renders human or --json itself.
    case 'registry': {
      // `rest` is everything after `registry` (sub-verb + its args/flags). The
      // sub-verb is the first non-flag token. Gate an UNKNOWN sub-verb here so
      // the bin owns the group-usage + exit-2 contract (EVAL-CLI-009), instead
      // of delegating to the child (which returns 1 on an ERROR finding).
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !REGISTRY_VERBS.has(sub)) {
        registryUsage(sub);
        process.exit(2);
        return;
      }
      // `forge registry build --write` -> registry.mjs ["build","--write", ...].
      // --json (if present in rest) is forwarded as-is; the child renders it.
      // The child runs in the CALLER's cwd so it targets the user's tree: a
      // trailing positional (e.g. `registry build <tree>`) overrides it, but
      // with no positional the registry resolves its root to cwd — which is
      // where the project's .forge/ state lives, NOT FORGE_ROOT.
      process.exit(delegateInherit('manager/registry.mjs', rest, process.cwd()));
      return;
    }
    case 'status':
      // `forge status --json` -> status.mjs ["--json", ...]. status is
      // informational and always exits 0 (the child enforces this). Run in the
      // caller's cwd so the dashboard reads the project's registry/state.
      process.exit(delegateInherit('manager/status.mjs', rest, process.cwd()));
      return;

    case 'analyze':
      // analyze is READ-ONLY: it accepts no mutation flag. Reject --apply with a
      // usage error (non-zero) BEFORE delegating (EVAL-CLI-010, BR-CLI-010).
      // optimize is the dry-run/--apply path, not analyze.
      if (flags.has('apply')) {
        process.stderr.write('[forge] analyze is read-only and does not accept --apply (use `forge optimize --apply` to act on a plan).\n');
        usage();
        process.exit(2);
        return;
      }
      // LIVE (v0.3): the analyze body is the efficiency C4 module, whose dual-mode
      // entry takes the sub-verb as argv[0] (defaulting to 'analyze'). Delegate
      // across a process boundary so the manager module never loads on the hot
      // path (EVAL-CLI-006). `rest` (post-verb args: a trailing project dir,
      // --project, --json) is forwarded VERBATIM; the child renders human/JSON
      // itself, with leading-`~` token estimates (EVAL-EFF-001).
      process.exit(delegateInherit('manager/efficiency.mjs', ['analyze', ...rest], process.cwd()));
      return;

    case 'fleet': {
      // LIVE (v0.3): delegate `forge fleet <sub> [args]` to manager/fleet.mjs via
      // a process boundary (hot path stays manager-free, EVAL-CLI-006). The
      // sub-verb is the first non-flag token; gate an UNKNOWN one HERE so the bin
      // owns the group-usage + exit-2 contract (mirrors registry), since the child
      // returns 1 (not 2) on its own unknown-subcommand ERROR. The child runs in
      // the caller's cwd so a relative `fleet add <project>` resolves correctly;
      // its machine-local index lives under $HOME (resolved inside the module).
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !FLEET_VERBS.has(sub)) {
        fleetUsage(sub);
        process.exit(2);
        return;
      }
      process.exit(delegateInherit('manager/fleet.mjs', rest, process.cwd()));
      return;
    }

    case 'memory': {
      // Delegate `forge memory <sub> [args]` to manager/memory.mjs via a process
      // boundary (hot path stays manager-free, EVAL-CLI-006). The sub-verb is the
      // first non-flag token; gate an UNKNOWN one HERE so the bin owns the group-
      // usage + exit-2 contract (mirrors registry/fleet), since the child returns 1
      // (not 2) on its own unknown-subcommand ERROR. The child runs in the caller's
      // cwd so it targets the user's project vault (.claude/memory or memory/).
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !MEMORY_VERBS.has(sub)) {
        memoryUsage(sub);
        process.exit(2);
        return;
      }
      // FAIL-OPEN guard (mirrors eval-harness): the C4 module may ship as a separate
      // deliverable. If the module file is absent, delegating would spawn a child
      // that crashes with a raw MODULE_NOT_FOUND (exit 1) — a hard failure that
      // violates fail-open. So degrade to the concise planned-notice + exit 0. The
      // verb is LIVE the moment the module exists (no further bin edit needed). The
      // existsSync is a cheap stat on a fixed path — it imports NO manager module,
      // so the hot-path-is-manager-free property (EVAL-CLI-006) is preserved (the
      // module only loads in the spawned child, across the process boundary).
      const memMod = path.join(FORGE_ROOT, 'manager', 'memory.mjs');
      if (!isFile(memMod)) {
        process.exit(plannedNotice('memory', 'a later version (module pending)'));
        return;
      }
      process.exit(delegateInherit('manager/memory.mjs', rest, process.cwd()));
      return;
    }

    case 'mcp': {
      // Delegate `forge mcp <sub> [args]` to manager/mcp.mjs via a process boundary
      // (hot path stays manager-free, EVAL-CLI-006). The sub-verb is the first
      // non-flag token; gate an UNKNOWN one HERE so the bin owns the group-usage +
      // exit-2 contract (mirrors registry/fleet/memory), since the child returns 1
      // (not 2) on its own unknown-subcommand ERROR. The child runs in the caller's
      // cwd so it targets the user's project (.claude/settings.json) while reading
      // the library catalog (FORGE_ROOT/mcp/*.json) from its own install location.
      // NOTE: `mcp` is also a registry KIND (the mcp/ catalog dir) — the verb and
      // the kind coexist here (like `memory`).
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !MCP_VERBS.has(sub)) {
        mcpUsage(sub);
        process.exit(2);
        return;
      }
      // FAIL-OPEN guard (mirrors memory/eval-harness): the C4 module may ship as a
      // separate deliverable. If the module file is absent, delegating would spawn a
      // child that crashes with a raw MODULE_NOT_FOUND (exit 1) — a hard failure that
      // violates fail-open. So degrade to the concise planned-notice + exit 0. The
      // verb is LIVE the moment the module exists (no further bin edit needed). The
      // existsSync is a cheap stat on a fixed path — it imports NO manager module, so
      // the hot-path-is-manager-free property (EVAL-CLI-006) is preserved (the module
      // only loads in the spawned child, across the process boundary).
      const mcpMod = path.join(FORGE_ROOT, 'manager', 'mcp.mjs');
      if (!isFile(mcpMod)) {
        process.exit(plannedNotice('mcp', 'a later version (module pending)'));
        return;
      }
      process.exit(delegateInherit('manager/mcp.mjs', rest, process.cwd()));
      return;
    }

    case 'source': {
      // Delegate `forge source <sub> [args]` to manager/source.mjs via a process
      // boundary (hot path stays manager-free, EVAL-CLI-006). The federated-catalog
      // SOURCE registry operator (ADR-0017): add/list/remove the registered external
      // repos in manifests/sources.json (sync/trust are planned stubs). The sub-verb
      // is the first non-flag token; gate an UNKNOWN one HERE so the bin owns the
      // group-usage + exit-2 contract (mirrors registry/fleet/memory/mcp), since the
      // child returns 1 (not 2) on its own unknown-subcommand ERROR. The module
      // operates on its OWN library manifest, so cwd is incidental.
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !SOURCE_VERBS.has(sub)) {
        sourceUsage(sub);
        process.exit(2);
        return;
      }
      // FAIL-OPEN guard (mirrors memory/mcp/eval-harness): the C4 module may ship as
      // a separate deliverable. If absent, degrade to the concise planned-notice +
      // exit 0 rather than spawning a child that crashes with MODULE_NOT_FOUND. The
      // existsSync is a cheap stat on a fixed path — it imports NO manager module, so
      // EVAL-CLI-006 (hot-path-is-manager-free) is preserved.
      const sourceMod = path.join(FORGE_ROOT, 'manager', 'source.mjs');
      if (!isFile(sourceMod)) {
        process.exit(plannedNotice('source', 'a later version (module pending)'));
        return;
      }
      process.exit(delegateInherit('manager/source.mjs', rest, process.cwd()));
      return;
    }

    case 'catalog': {
      // Delegate `forge catalog <sub> [args]` to manager/catalog.mjs via a process
      // boundary (hot path stays manager-free, EVAL-CLI-006). The federated unified
      // CATALOG (library ∪ synced sources) + admission lifecycle operator (ADR-0017):
      // build/ls/dedup/admit/revoke (all PLANNED stubs this phase; nothing activates).
      // The sub-verb is the first non-flag token; gate an UNKNOWN one HERE so the bin
      // owns the group-usage + exit-2 contract (mirrors registry/fleet/memory/mcp/
      // source), since the child returns 1 (not 2) on its own unknown-subcommand ERROR.
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !CATALOG_VERBS.has(sub)) {
        catalogUsage(sub);
        process.exit(2);
        return;
      }
      // FAIL-OPEN guard (mirrors source/memory/mcp): the C4 module may ship as a
      // separate deliverable. If absent, degrade to the concise planned-notice +
      // exit 0 rather than spawning a child that crashes with MODULE_NOT_FOUND.
      const catalogMod = path.join(FORGE_ROOT, 'manager', 'catalog.mjs');
      if (!isFile(catalogMod)) {
        process.exit(plannedNotice('catalog', 'a later version (module pending)'));
        return;
      }
      process.exit(delegateInherit('manager/catalog.mjs', rest, process.cwd()));
      return;
    }

    case 'slice': {
      // Delegate `forge slice <sub> [args]` to manager/slices.mjs via a process boundary
      // (hot path stays manager-free, EVAL-CLI-006). The catalog SLICE + per-project
      // SUBSCRIPTION operator (ADR-0018): list derives slices (one source's records by
      // registry kind, id "<sourceId>/<kind>") + marks each subscribed; subscribe/
      // unsubscribe toggle the opt-in set in <activeRoot>/.forge/subscriptions.json
      // (preview by default, write on --apply). The sub-verb is the first non-flag token;
      // gate an UNKNOWN one HERE so the bin owns the group-usage + exit-2 contract
      // (mirrors source/catalog), since the child returns 1 (not 2) on its own
      // unknown-subcommand ERROR. slices.mjs reads/writes subscriptions UNDER the project
      // cwd (per-project state), so the cwd is meaningful — pass process.cwd().
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !SLICE_VERBS.has(sub)) {
        sliceUsage(sub);
        process.exit(2);
        return;
      }
      // FAIL-OPEN guard (mirrors source/catalog/memory/mcp): the C4 module may ship as a
      // separate deliverable. If absent, degrade to the concise planned-notice + exit 0
      // rather than spawning a child that crashes with MODULE_NOT_FOUND.
      const sliceMod = path.join(FORGE_ROOT, 'manager', 'slices.mjs');
      if (!isFile(sliceMod)) {
        process.exit(plannedNotice('slice', 'a later version (module pending)'));
        return;
      }
      process.exit(delegateInherit('manager/slices.mjs', rest, process.cwd()));
      return;
    }

    case 'compose': {
      // Delegate `forge compose <sub> [args]` to manager/compose.mjs via a process boundary
      // (hot path stays manager-free, EVAL-CLI-006). The per-project COMPOSITION + ADOPTION
      // operator (ADR-0019): list JOINs the adopted set to the catalog read-view; adopt/remove
      // toggle the per-active-root set in <activeRoot>/.forge/composition.json (preview by
      // default, write on --apply). ADOPT != ADMIT — it records a per-project selection and
      // never writes the library. The sub-verb is the first non-flag token; gate an UNKNOWN
      // one HERE so the bin owns the group-usage + exit-2 contract (mirrors source/catalog/
      // slice), since the child returns 1 (not 2) on its own unknown-subcommand ERROR.
      // compose.mjs reads/writes composition UNDER the project cwd (per-project state), so the
      // cwd is meaningful — pass process.cwd().
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !COMPOSE_VERBS.has(sub)) {
        composeUsage(sub);
        process.exit(2);
        return;
      }
      // FAIL-OPEN guard (mirrors source/catalog/slice/memory/mcp): the C4 module may ship as a
      // separate deliverable. If absent, degrade to the concise planned-notice + exit 0 rather
      // than spawning a child that crashes with MODULE_NOT_FOUND.
      const composeMod = path.join(FORGE_ROOT, 'manager', 'compose.mjs');
      if (!isFile(composeMod)) {
        process.exit(plannedNotice('compose', 'a later version (module pending)'));
        return;
      }
      process.exit(delegateInherit('manager/compose.mjs', rest, process.cwd()));
      return;
    }

    case 'conflict': {
      // Delegate `forge conflict <sub> [args]` to manager/conflict.mjs via a process boundary
      // (hot path stays manager-free, EVAL-CLI-006). The per-project CONFLICT + ADJUDICATION
      // operator (ADR-0020): list DERIVES conflicts from the catalog dedup view filtered to the
      // read-view (BR-CAT-010, deterministic-collection only — NO model call, BR-CAT-011);
      // resolve records the human T2 pick + updates the composition via the compose helpers;
      // policy gets/sets the per-criticality policy (default all-block) in
      // <activeRoot>/.forge/adjudication.json (preview by default, write on --apply). The sub-verb
      // is the first non-flag token; gate an UNKNOWN one HERE so the bin owns the group-usage +
      // exit-2 contract (mirrors source/catalog/slice/compose), since the child returns 1 (not 2)
      // on its own unknown-subcommand ERROR. conflict.mjs reads/writes adjudication + composition
      // UNDER the project cwd (per-project state), so the cwd is meaningful — pass process.cwd().
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !CONFLICT_VERBS.has(sub)) {
        conflictUsage(sub);
        process.exit(2);
        return;
      }
      // FAIL-OPEN guard (mirrors source/catalog/slice/compose/memory/mcp): the C4 module may ship
      // as a separate deliverable. If absent, degrade to the concise planned-notice + exit 0
      // rather than spawning a child that crashes with MODULE_NOT_FOUND.
      const conflictMod = path.join(FORGE_ROOT, 'manager', 'conflict.mjs');
      if (!isFile(conflictMod)) {
        process.exit(plannedNotice('conflict', 'a later version (module pending)'));
        return;
      }
      process.exit(delegateInherit('manager/conflict.mjs', rest, process.cwd()));
      return;
    }

    case 'tailor': {
      // Delegate `forge tailor <sub> [args]` to manager/tailor.mjs via a process boundary (hot path
      // stays manager-free, EVAL-CLI-006). The per-project TAILORING + OVERLAY operator (ADR-0021):
      // list JOINS each tailored (uid, sourceId) entry to its ADOPTED composition record (reusing
      // the compose read-view) for kind + base values and folds the overlays into a deterministic
      // RESOLVED PREVIEW (a display-only VIEW — NO .claude/ write here, application is Slice 5);
      // add/remove record/drop a {type, detail} overlay (per-type dedupe, BR-CAT-016) in the
      // SEPARATE per-active-root .forge/tailoring.json store (preview by default, write on --apply).
      // add validates the resource is ADOPTED (BR-CAT-015) and never adopts as a side effect; NO
      // model call. The sub-verb is the first non-flag token; gate an UNKNOWN one HERE so the bin
      // owns the group-usage + exit-2 contract (mirrors source/catalog/slice/compose/conflict),
      // since the child returns 1 (not 2) on its own unknown-subcommand ERROR. tailor.mjs reads the
      // tailoring + composition stores UNDER the project cwd (per-project state) — pass process.cwd().
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !TAILOR_VERBS.has(sub)) {
        tailorUsage(sub);
        process.exit(2);
        return;
      }
      // FAIL-OPEN guard (mirrors source/catalog/slice/compose/conflict): the C4 module may ship as a
      // separate deliverable. If absent, degrade to the concise planned-notice + exit 0 rather than
      // spawning a child that crashes with MODULE_NOT_FOUND.
      const tailorMod = path.join(FORGE_ROOT, 'manager', 'tailor.mjs');
      if (!isFile(tailorMod)) {
        process.exit(plannedNotice('tailor', 'a later version (module pending)'));
        return;
      }
      process.exit(delegateInherit('manager/tailor.mjs', rest, process.cwd()));
      return;
    }

    case 'lock': {
      // Delegate `forge lock <sub> [args]` to manager/lock.mjs via a process boundary (hot path
      // stays manager-free, EVAL-CLI-006). The per-project LOCKFILE operator (ADR-0022): show reads
      // <activeRoot>/forge.lock + reports exists/committed/inSync; write RESOLVES the composition
      // (the adopted set JOINED with overlays + adjudication + pins, REUSING the compose/tailor/
      // conflict read helpers) + a DETERMINISTIC content hash (excluding generatedAt, BR-CAT-018)
      // and writes <activeRoot>/forge.lock on --apply (preview by default); diff compares the current
      // lock vs the freshly-resolved composition (+/~/- changes). MANIFEST-ONLY: lock write NEVER
      // materializes/modifies .claude/, the library, or the stores it reads (BR-CAT-019); NO model
      // call. forge.lock is DISTINCT from .forge/sources.lock (it CONSUMES its per-entry commit). The
      // sub-verb is the first non-flag token; gate an UNKNOWN one HERE so the bin owns the
      // group-usage + exit-2 contract (mirrors source/catalog/slice/compose/conflict/tailor), since
      // the child returns 1 (not 2) on its own unknown-subcommand ERROR. lock.mjs reads/writes
      // forge.lock UNDER the project cwd (per-project state) — pass process.cwd().
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub !== undefined && !LOCK_VERBS.has(sub)) {
        lockUsage(sub);
        process.exit(2);
        return;
      }
      // FAIL-OPEN guard (mirrors source/catalog/slice/compose/conflict/tailor): the C4 module may
      // ship as a separate deliverable. If absent, degrade to the concise planned-notice + exit 0
      // rather than spawning a child that crashes with MODULE_NOT_FOUND.
      const lockMod = path.join(FORGE_ROOT, 'manager', 'lock.mjs');
      if (!isFile(lockMod)) {
        process.exit(plannedNotice('lock', 'a later version (module pending)'));
        return;
      }
      process.exit(delegateInherit('manager/lock.mjs', rest, process.cwd()));
      return;
    }

    // ----- v0.4 telemetry surface (SPEC-05/SPEC-08) — LIVE. All three reach the
    // SAME dual-mode module (manager/telemetry.mjs) across a process boundary, so
    // the hot path stays manager-free (EVAL-CLI-006) and main() stays SYNCHRONOUS.
    // The telemetry reader is fail-open by contract (BR-TEL-013): off/empty ⇒ an
    // actionable message + exit 0; --json ⇒ an ok:true envelope with empty data
    // (EVAL-TEL-013). The store lives under $HOME (resolved inside the module), so
    // delegating in the caller's cwd is correct.
    case 'telemetry':
      // `forge telemetry <sub> [args]` -> telemetry.mjs [<sub>, ...args]. The
      // sub-verb is forwarded VERBATIM as argv[0]; an unknown sub-verb is the
      // module's fail-open INFO + exit 0 (NOT exit 2) — telemetry never blocks.
      process.exit(delegateInherit('manager/telemetry.mjs', rest, process.cwd()));
      return;
    case 'stat':
      // Promoted top-level alias for `telemetry stat` (v0.4): the rollup reader.
      // Forward post-verb args AFTER the injected `stat` sub-verb so the child's
      // run('stat', …)/--json envelope is produced (EVAL-TEL-013).
      process.exit(delegateInherit('manager/telemetry.mjs', ['stat', ...rest], process.cwd()));
      return;
    case 'monitor':
      // Promoted top-level alias for `telemetry monitor` (v0.4): the at-a-glance
      // snapshot. monitor ignores --apply (SPEC-08); the module renders/exits.
      process.exit(delegateInherit('manager/telemetry.mjs', ['monitor', ...rest], process.cwd()));
      return;

    // ----- v0.4 eval-harness surface (SPEC-07/SPEC-08) — LIVE. Delegated to the
    // dual-mode manager/eval-harness.mjs across a process boundary (hot path stays
    // manager-free, EVAL-CLI-006; main() stays SYNCHRONOUS). Post-verb args
    // ([uid] | --changed | --all | --report [+ --json]) are forwarded VERBATIM;
    // the child renders human/--json itself (EVAL-EVAL-CLI). NO model call runs in
    // tests — `--report` "runs nothing" per SPEC-07 §CLI; running a real reviewer
    // is a manual LIVE exercise, never a unit test.
    case 'eval-harness': {
      // FAIL-OPEN guard: the C4 module ships as a SEPARATE deliverable this phase.
      // Until it lands, delegating would spawn a child that crashes with a raw
      // MODULE_NOT_FOUND stack trace (exit 1) — a hard failure that violates the
      // fail-open invariant. So if the module file is absent, degrade to the same
      // concise planned-notice + exit 0. The verb is LIVE the moment the module
      // exists (no further bin edit needed). Checking existsSync here is a cheap
      // stat on a fixed path — it imports NO manager module, so the EVAL-CLI-006
      // hot-path-is-manager-free property is preserved (the module only loads in
      // the spawned child, across the process boundary).
      const evalMod = path.join(FORGE_ROOT, 'manager', 'eval-harness.mjs');
      if (!isFile(evalMod)) {
        process.exit(plannedNotice('eval-harness', 'v0.4 (module pending)'));
        return;
      }
      process.exit(delegateInherit('manager/eval-harness.mjs', rest, process.cwd()));
      return;
    }

    case 'optimize':
      // Recognized-but-unbuilt taxonomy verb (v0.6): a concise "planned" notice,
      // exit 0 (fail-soft; never a crash). Its body lands in a later phase.
      process.exit(plannedNotice(cmd, PLANNED_VERBS[cmd]));
      return;

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      usage();
      process.exit(0);
      return;
    default:
      process.stderr.write(`[forge] unknown command: ${cmd}\n\n`);
      usage();
      process.exit(2);
  }
}

main();
