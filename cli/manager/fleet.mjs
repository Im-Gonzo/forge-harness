// @ts-check
/**
 * fleet — the manager's READ-ONLY fleet view (SPEC-04, ADR-0009/0010, BR-FLEET-*).
 *
 * "Where are my harnesses installed, and which have drifted from the library?" The
 * fleet is a MACHINE-LOCAL, OPT-IN, disposable index of every tailored project on
 * this machine. It is privacy-first: nothing is recorded until the user runs
 * `forge fleet enable`, and the index lives ONLY under `~/.claude/forge/fleet.json`
 * (the machineStateHome root, ADR-0003) — never inside a tailored project or the
 * git-tracked library (BR-FLEET-005/017).
 *
 * THE MARKER IS THE TRUTH (BR-FLEET-006). The index is a cache reconstructible from
 * project markers alone (`<project>/.claude/.forge.json`); reconcile corrects a row
 * to match the marker and NEVER rewrites the marker from a row. No daemon (BR-FLEET-010):
 * refresh is opportunistic — a fleet command reconciles what it touches, nothing runs
 * in the background.
 *
 * v0.3 surface (this module) is READ-ONLY: it observes and reports, it never mutates a
 * project tree. The write/merge surface (`fleet sync --apply` 3-way merge) is v0.5 and
 * is intentionally NOT built here.
 *
 * Subcommands (C4 `run(subcmd, args, ctx)`):
 *   - `enable`  — write the opt-in flag (fleetEnabled:true) into the machine index.
 *                 This is the ONLY mutation a read verb performs, and only to the
 *                 machine-local root. detect-and-offer is the dispatcher's job; here
 *                 `enable` is the explicit toggle.
 *   - `status`  — one row per registered project (reconciled, fail-open).
 *   - `add <p>` — register a project (resolve its marker, reconcile, persist a row).
 *   - `scan`    — crawl scanRoots for nested `.claude/.forge.json` markers, bounded depth,
 *                 skip node_modules/.git, reconcile each (the marker rebuilds the index).
 *   - `drift`   — per-project drift: version-level (forgeVersion vs running forge) +
 *                 component/provenance-level (marker.provenance.sourceRev vs a fresh
 *                 computeSourceRev). `--component <uid>` scopes output to projects that
 *                 resolve to that component. Advisory WARN only (ADR-0007).
 *
 * PROVENANCE (ADR-0009): `computeSourceRev(rootDir, marker)` folds the library
 * Registry `contentHash` of every component the marker resolves to into one sha256
 * over the canonical, uid-SORTED `{uid: contentHash}` map. Order-independent by
 * construction. Drift compares `marker.provenance.sourceRev` (when present; ABSENT ⇒
 * unknown provenance, NOT an error — version-level drift only, BR-FLEET-003) to a
 * fresh computeSourceRev.
 *
 * HARD INVARIANTS: zero runtime deps (node: builtins + relative imports only);
 * additive-never-destructive; fail-open (no public entry throws past its surface);
 * writers dry-run by default; advisory gates (WARN, never block). Dual-mode with an
 * `isMain()` guard — NEVER call process.exit() at import time (it silently kills the
 * node:test runner).
 *
 * @module manager/fleet
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sha256hex } from './lib/hash.mjs';
import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import {
  readJson,
  writeJsonAtomic,
  machineStateHome,
  forgeStateDir,
  stampSchemaVersion,
} from './lib/store.mjs';
import { buildRegistry } from './registry.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** On-disk schema tag for the machine-local fleet index (SPEC-09 store gate). */
const FLEET_SCHEMA_VERSION = 'forge.fleet.v1';
/** The emitter stamped on findings this module raises (C2 `source`). */
const SOURCE = 'fleet';
/** Max directory depth `scan` descends from each scanRoot (BR-FLEET-011). */
const DEFAULT_SCAN_DEPTH = 6;
/** Directory names `scan` never descends into (BR-FLEET-011). */
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git']);

// ---------------------------------------------------------------------------
// Provenance: computeSourceRev (ADR-0009, BR-FLEET-001)
// ---------------------------------------------------------------------------

/**
 * Fold the library Registry `contentHash` of every component a project marker resolves
 * to into one deterministic `sourceRev`. PURE + order-independent: the fold sorts the
 * `{uid: contentHash}` map by uid before hashing, so the resolved set's order can never
 * change the result (the test oracle in eval-fleet.test.mjs recomputes this exactly).
 *
 * Resolution: a marker's `modules[]` names the resolved module set; a registry artifact
 * belongs to the resolved set iff its `modules[]` intersects the marker's `modules[]`
 * (the same `{profile,modules}→components` mapping init performs, ADR-0009). The
 * registry is the LIBRARY registry under `rootDir` (`<rootDir>/.forge/registry.json`);
 * absent/corrupt ⇒ a fresh in-memory `buildRegistry(rootDir)` scan is the fallback.
 *
 * Fail-open: any failure yields `"sha256:" + sha256hex("{}")` (the empty-fold), never a
 * throw. An empty resolved set is therefore a valid (degenerate) sourceRev, not an error.
 *
 * @param {string} rootDir Absolute FORGE library root (where `.forge/registry.json` lives).
 * @param {object} marker The project marker (`.claude/.forge.json`) — uses `modules[]`.
 * @returns {string} `"sha256:" + sha256hex(canonical(uid-sorted {uid: contentHash}))`.
 */
export function computeSourceRev(rootDir, marker) {
  try {
    const uidToHash = resolveComponentHashes(rootDir, marker);
    const sorted = {};
    for (const uid of Object.keys(uidToHash).sort()) sorted[uid] = uidToHash[uid];
    return 'sha256:' + sha256hex(JSON.stringify(sorted));
  } catch {
    // Fail-open: the empty fold is a well-formed (degenerate) sourceRev.
    return 'sha256:' + sha256hex(JSON.stringify({}));
  }
}

/**
 * Resolve a marker's `modules[]` to the `{uid: contentHash}` map of the library
 * components it pulls in. Reads the committed `<rootDir>/.forge/registry.json`; falls
 * back to a fresh `buildRegistry(rootDir)` scan when it is absent/corrupt. A component
 * is IN the resolved set iff its registry `modules[]` intersects the marker's set.
 * Fail-open: returns `{}` on any error.
 *
 * @param {string} rootDir
 * @param {object} marker
 * @returns {Record<string,string>} uid → contentHash for every resolved component.
 */
function resolveComponentHashes(rootDir, marker) {
  /** @type {Record<string,string>} */
  const out = {};
  const reg = loadRegistry(rootDir);
  const artifacts = reg && Array.isArray(reg.artifacts) ? reg.artifacts : [];
  const wanted = new Set(marker && Array.isArray(marker.modules) ? marker.modules : []);
  if (wanted.size === 0) return out;
  for (const a of artifacts) {
    if (!a || typeof a.uid !== 'string' || typeof a.contentHash !== 'string') continue;
    const mods = Array.isArray(a.modules) ? a.modules : [];
    if (mods.some((m) => wanted.has(m))) out[a.uid] = a.contentHash;
  }
  return out;
}

/** The set of registry uids a marker resolves to (for `--component` scoping). */
function resolveComponentUids(rootDir, marker) {
  return new Set(Object.keys(resolveComponentHashes(rootDir, marker)));
}

/**
 * Load the LIBRARY registry under `rootDir`: prefer the committed snapshot, else a
 * fresh in-memory scan (so an un-built library still resolves provenance). Fail-open
 * to null.
 * @param {string} rootDir @returns {any|null}
 */
function loadRegistry(rootDir) {
  const committed = readJson(path.join(forgeStateDir(rootDir), 'registry.json'));
  if (committed && Array.isArray(committed.artifacts)) return committed;
  try {
    const built = buildRegistry(rootDir);
    return built && Array.isArray(built.artifacts) ? built : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Machine-local index I/O (fail-open; only ever under machineStateHome)
// ---------------------------------------------------------------------------

/**
 * Absolute path to the machine-local fleet index (`~/.claude/forge/fleet.json`).
 *
 * `homeOverride` (from `ctx.HOME`) lets an in-process caller redirect the machine root
 * away from `process.env.HOME` — the test harness passes a per-test sandbox HOME in the
 * ctx so it never touches the real `$HOME`. When absent, the store's `machineStateHome()`
 * (which reads `process.env.HOME`/`USERPROFILE`) is the source of truth, so a directly
 * `node manager/fleet.mjs` invocation still resolves the real machine root.
 *
 * @param {string|null|undefined} [homeOverride]
 * @returns {string}
 */
function fleetIndexPath(homeOverride) {
  if (typeof homeOverride === 'string' && homeOverride) {
    return path.join(homeOverride, '.claude', 'forge', 'fleet.json');
  }
  return path.join(machineStateHome(), 'fleet.json');
}

/**
 * Read the machine-local fleet index, fail-open to a fresh DISABLED skeleton on a
 * missing OR corrupt file (BR-FLEET-014). The returned object is always well-formed:
 * `{ schemaVersion, schema, fleetEnabled, scanRoots, projects }`.
 *
 * @param {string|null|undefined} [homeOverride] redirect the machine root (ctx.HOME).
 * @returns {{schemaVersion:string, schema:string, fleetEnabled:boolean, scanRoots:string[], projects:Record<string,any>, _corrupt?:boolean, _present?:boolean}}
 */
function readIndex(homeOverride) {
  const idxPath = fleetIndexPath(homeOverride);
  let present = false;
  try {
    present = fs.existsSync(idxPath);
  } catch {
    present = false;
  }
  const raw = readJson(idxPath);
  if (!raw || typeof raw !== 'object' || !raw.projects || typeof raw.projects !== 'object') {
    // Missing or corrupt → treat as "no data" (fail-open). Flag corruption so a caller
    // can surface an advisory "fleet unavailable" without ever throwing.
    return {
      schemaVersion: FLEET_SCHEMA_VERSION,
      schema: FLEET_SCHEMA_VERSION,
      fleetEnabled: false,
      scanRoots: [],
      projects: {},
      _corrupt: present, // present-but-unreadable ⇒ corrupt; absent ⇒ just empty
      _present: present,
    };
  }
  return {
    schemaVersion: typeof raw.schemaVersion === 'string' ? raw.schemaVersion : FLEET_SCHEMA_VERSION,
    schema: typeof raw.schema === 'string' ? raw.schema : FLEET_SCHEMA_VERSION,
    fleetEnabled: raw.fleetEnabled === true,
    scanRoots: Array.isArray(raw.scanRoots) ? raw.scanRoots.filter((s) => typeof s === 'string') : [],
    projects: raw.projects,
    _present: true,
  };
}

/**
 * Persist the machine-local fleet index atomically. Writes ONLY under
 * machineStateHome (BR-FLEET-005/017) and strips the internal `_corrupt`/`_present`
 * markers before serialising. Fail-open: returns false on any error.
 *
 * @param {object} index
 * @param {string|null|undefined} [homeOverride] redirect the machine root (ctx.HOME).
 * @returns {boolean}
 */
function writeIndex(index, homeOverride) {
  const idxPath = fleetIndexPath(homeOverride);
  const clean = {
    schema: FLEET_SCHEMA_VERSION,
    fleetEnabled: index.fleetEnabled === true,
    scanRoots: Array.isArray(index.scanRoots) ? index.scanRoots : [],
    projects: index.projects && typeof index.projects === 'object' ? index.projects : {},
  };
  return writeJsonAtomic(idxPath, stampSchemaVersion(clean, FLEET_SCHEMA_VERSION));
}

// ---------------------------------------------------------------------------
// Marker reading + project identity
// ---------------------------------------------------------------------------

/** Read a project's marker bytes (`<project>/.claude/.forge.json`), or null. */
function readMarkerBytes(projectDir) {
  try {
    return fs.readFileSync(path.join(projectDir, '.claude', '.forge.json'));
  } catch {
    return null;
  }
}

/** Read + parse a project's marker, or null (fail-open). */
function readMarker(projectDir) {
  return readJson(path.join(projectDir, '.claude', '.forge.json'));
}

/** fs.realpathSync that fails open to the input (so a tmp path still compares). */
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Project id = sha256(realpath)[:16] (BR-FLEET-008). */
function projectId(projectDir) {
  return sha256hex(realpath(projectDir)).slice(0, 16);
}

/** Now as an ISO timestamp (fail-open to epoch). */
function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

// ---------------------------------------------------------------------------
// Reconciliation: build/refresh a per-project row FROM ITS MARKER (BR-FLEET-006)
// ---------------------------------------------------------------------------

/**
 * Reconcile (or build) a per-project row from its marker — the marker is the truth.
 * Computes a fresh markerChecksum (sha256 of the marker bytes); when it matches the
 * prior row's checksum the row is served FROM CACHE without re-hashing component files
 * (the cheap gate, BR-FLEET-012) — `fromCache:true`/`reHashed:false` flags say so.
 *
 * Status (BR-FLEET-009/010): `missing` when no marker on disk; `pinned` carried from a
 * prior row; otherwise `active`. `moved` detection (matching a marker at a new path by
 * `generatedAt`) is the scan's concern; a direct add/reconcile reports `active`.
 *
 * NEVER writes the marker (read-only). Fail-open: a torn marker yields a `missing`/
 * degraded row, never a throw.
 *
 * @param {string} rootDir Library root (for provenance/drift compute).
 * @param {string} projectDir Absolute project path.
 * @param {any|null} priorRow The prior index row for this project (or null).
 * @param {{runningVersion?:string}} [opts]
 * @returns {any} the reconciled row.
 */
function reconcileRow(rootDir, projectDir, priorRow, opts = {}) {
  const id = projectId(projectDir);
  const realPath = realpath(projectDir);
  const markerBytes = readMarkerBytes(projectDir);
  const ts = nowIso();

  if (!markerBytes) {
    // The project (or its marker) is gone — honest `missing`, never an error.
    return {
      id,
      path: realPath,
      tailoredFrom: priorRow && typeof priorRow.tailoredFrom === 'string' ? priorRow.tailoredFrom : null,
      profile: priorRow && typeof priorRow.profile === 'string' ? priorRow.profile : null,
      modules: priorRow && Array.isArray(priorRow.modules) ? priorRow.modules : [],
      generatedAt: priorRow && typeof priorRow.generatedAt === 'string' ? priorRow.generatedAt : null,
      lastSyncedAt: priorRow && typeof priorRow.lastSyncedAt === 'string' ? priorRow.lastSyncedAt : null,
      lastSeenAt: ts,
      markerChecksum: priorRow && typeof priorRow.markerChecksum === 'string' ? priorRow.markerChecksum : null,
      status: priorRow && priorRow.status === 'pinned' ? 'pinned' : 'missing',
      health: emptyHealth(),
      fromCache: false,
      reHashed: false,
    };
  }

  const markerChecksum = 'sha256:' + sha256hex(markerBytes);
  const marker = safeParse(markerBytes);

  // Cheap gate: an unchanged markerChecksum is served from cache without re-hashing the
  // resolved component files (BR-FLEET-012). The drift compute still reads the registry
  // (a single committed-snapshot read), but the EXPENSIVE per-file re-hash is skipped.
  const priorChecksum = priorRow && typeof priorRow.markerChecksum === 'string' ? priorRow.markerChecksum : null;
  const fromCache = priorChecksum !== null && priorChecksum === markerChecksum;

  const status = priorRow && priorRow.status === 'pinned' ? 'pinned' : 'active';
  const health = assessHealth(rootDir, projectDir, marker, opts.runningVersion);

  return {
    id,
    path: realPath,
    tailoredFrom: marker && typeof marker.forgeVersion === 'string' ? marker.forgeVersion : null,
    profile: marker && typeof marker.profile === 'string' ? marker.profile : null,
    modules: marker && Array.isArray(marker.modules) ? marker.modules : [],
    generatedAt: marker && typeof marker.generatedAt === 'string' ? marker.generatedAt : null,
    lastSyncedAt: priorRow && typeof priorRow.lastSyncedAt === 'string' ? priorRow.lastSyncedAt : null,
    lastSeenAt: ts,
    markerChecksum,
    status,
    health,
    fromCache,
    reHashed: !fromCache,
  };
}

/** A zeroed health block (used for a missing project). */
function emptyHealth() {
  return { versionBehind: false, componentsBehind: null, userEditedFiles: 0, grade: 'unknown' };
}

/**
 * Assess a project's health (BR-FLEET-003/004/013, ADR-0009):
 *   - versionBehind:    marker.forgeVersion strictly precedes the running forge.
 *   - componentsBehind: number of resolved components whose library contentHash changed
 *                       since tailor — computed by comparing the marker's
 *                       `provenance.sourceRev` to a fresh computeSourceRev. With NO
 *                       provenance (legacy marker) this is `null` (unknown), never a
 *                       number (BR-FLEET-003). When sourceRevs MATCH it is 0; when they
 *                       DIFFER it is a positive count of changed components.
 *   - userEditedFiles:  tracked files whose on-disk checksum drifted (best-effort).
 *   - grade:            healthy | drift | unhealthy (advisory).
 *
 * Fail-open: any failure degrades to a conservative, non-error health block.
 *
 * @param {string} rootDir @param {string} projectDir @param {any} marker @param {string|undefined} runningVersion
 * @returns {{versionBehind:boolean, componentsBehind:number|null, userEditedFiles:number, grade:string, provenanceKnown:boolean}}
 */
function assessHealth(rootDir, projectDir, marker, runningVersion) {
  const markerVersion = marker && typeof marker.forgeVersion === 'string' ? marker.forgeVersion : null;
  const running = typeof runningVersion === 'string' && runningVersion ? runningVersion : readRunningVersion(rootDir);
  const versionBehind = markerVersion && running ? semverLt(stripDesign(markerVersion), stripDesign(running)) : false;

  // Provenance-level drift: present sourceRev ⇒ compare to a fresh fold; absent ⇒
  // unknown (componentsBehind:null), version-level drift only (BR-FLEET-003).
  const recordedRev =
    marker && marker.provenance && typeof marker.provenance.sourceRev === 'string'
      ? marker.provenance.sourceRev
      : null;
  const provenanceKnown = recordedRev !== null;

  let componentsBehind = null;
  if (provenanceKnown) {
    const freshRev = computeSourceRev(rootDir, marker);
    componentsBehind = recordedRev === freshRev ? 0 : countChangedComponents(rootDir, marker, recordedRev);
  }

  const userEditedFiles = countUserEditedFiles(projectDir, marker);

  // Grade: a missing tracked file would be `unhealthy` (v0.5 sync territory — best-
  // effort here); component/version drift grades `drift`; otherwise `healthy`.
  let grade = 'healthy';
  if (versionBehind || (typeof componentsBehind === 'number' && componentsBehind > 0)) grade = 'drift';

  return { versionBehind: !!versionBehind, componentsBehind, userEditedFiles, grade, provenanceKnown };
}

/**
 * Count how many resolved components changed vs the recorded sourceRev. We cannot
 * recover the OLD per-component hashes from a folded sourceRev, so when the fold differs
 * we report the count of currently-resolved components as the (upper-bound) drift
 * signal — advisory only. Fail-open to 1 (some drift) so the report is never silently 0.
 *
 * @param {string} rootDir @param {any} marker @param {string} _recordedRev
 * @returns {number}
 */
function countChangedComponents(rootDir, marker, _recordedRev) {
  try {
    const n = resolveComponentUids(rootDir, marker).size;
    return n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

/**
 * Count tracked files whose on-disk checksum drifted from the marker (user edits).
 * Best-effort + fail-open: an unreadable file contributes nothing.
 * @param {string} projectDir @param {any} marker @returns {number}
 */
function countUserEditedFiles(projectDir, marker) {
  const files = marker && Array.isArray(marker.files) ? marker.files : [];
  let edited = 0;
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.checksum !== 'string') continue;
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(projectDir, f.path));
    } catch {
      continue; // missing tracked file — not a user edit (v0.5 grades this)
    }
    const actual = 'sha256:' + sha256hex(bytes);
    if (actual !== f.checksum) edited += 1;
  }
  return edited;
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** Read the running forge VERSION at `rootDir` (fail-open to '0.0.0'). */
function readRunningVersion(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'VERSION'), 'utf8').trim();
    return raw || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Strip a trailing `-design` pre-release suffix (mirrors registry.mjs#stripDesign). */
function stripDesign(v) {
  return typeof v === 'string' && v.endsWith('-design') ? v.slice(0, -'-design'.length) : v;
}

/** True when semver `a` strictly precedes `b` (tolerant; non-semver parts coerce to 0). */
function semverLt(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}

/** Parse a semver string into a [major, minor, patch] number triple (fail-open to 0s). */
function parseSemver(v) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || '').trim());
  return m ? [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0] : [0, 0, 0];
}

// ---------------------------------------------------------------------------
// Marker scan (bounded, skips node_modules/.git — BR-FLEET-011)
// ---------------------------------------------------------------------------

/**
 * Crawl each scanRoot for nested `.claude/.forge.json` markers, descending at most
 * `maxDepth` directory levels and NEVER into `node_modules`/`.git`. Returns the
 * absolute PROJECT directories (the parent of `.claude`). Bounded + fail-open: an
 * unreadable directory contributes nothing and never aborts the crawl.
 *
 * @param {string[]} scanRoots Absolute roots to crawl.
 * @param {number} [maxDepth] Max directory depth from each root (BR-FLEET-011).
 * @returns {string[]} absolute project directories holding a marker.
 */
function scanForMarkers(scanRoots, maxDepth = DEFAULT_SCAN_DEPTH) {
  /** @type {string[]} */
  const found = [];
  const seen = new Set();
  for (const root of scanRoots) {
    if (typeof root !== 'string' || !root) continue;
    walk(root, 0);
  }
  return found;

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable — skip, never throw
    }
    // A directory holding `.claude/.forge.json` IS a tailored project.
    for (const e of entries) {
      if (e.isDirectory() && e.name === '.claude') {
        const markerAbs = path.join(dir, '.claude', '.forge.json');
        let isFile = false;
        try {
          isFile = fs.statSync(markerAbs).isFile();
        } catch {
          isFile = false;
        }
        if (isFile && !seen.has(dir)) {
          seen.add(dir);
          found.push(dir);
        }
      }
    }
    // Descend (bounded), skipping noisy dirs and the `.claude` we already inspected.
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SCAN_SKIP_DIRS.has(e.name)) continue; // node_modules / .git (BR-FLEET-011)
      if (e.name === '.claude') continue; // already inspected for a marker
      walk(path.join(dir, e.name), depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** JSON.parse a Buffer/string fail-open to null. */
function safeParse(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

/** Normalise `ctx`/`args` to { rootDir, projectDir, component, write, positional, flags }. */
function normalize(args, ctx) {
  const flags = new Set();
  const positional = [];
  /** @type {Record<string,string>} */
  const opts = {};
  const argList = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  const VALUE_OPTS = new Set(['component']);
  for (let i = 0; i < argList.length; i++) {
    const a = argList[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      flags.add(name);
      if (eq >= 0) {
        opts[name] = body.slice(eq + 1);
      } else if (VALUE_OPTS.has(name) && i + 1 < argList.length && !String(argList[i + 1]).startsWith('--')) {
        opts[name] = String(argList[i + 1]);
        i++; // consume the value token so it is not mistaken for a positional
      }
    } else {
      positional.push(a);
    }
  }
  if (ctx && ctx.flags instanceof Set) for (const f of ctx.flags) flags.add(f);

  // rootDir = the FORGE LIBRARY root (for registry/provenance). cwd is the caller's
  // project; ctx.FORGE_ROOT names the library when they differ (tests pass both).
  const rootDir =
    (ctx && (ctx.FORGE_ROOT || ctx.forgeRoot || ctx.root)) ||
    selfForgeRoot();
  // projectDir = an explicit positional, else the caller cwd.
  const projectDir =
    (positional.length && positional[positional.length - 1]) ||
    (ctx && ctx.cwd) ||
    process.cwd();
  const component = opts.component || (ctx && ctx.opts && ctx.opts.component) || null;
  const write = flags.has('write') || flags.has('apply') || (ctx && (ctx.write === true || ctx.apply === true));
  // home = the machine-local root override. An in-process caller (the test harness,
  // the dispatcher) passes ctx.HOME so the fleet index never touches the real $HOME;
  // when absent, the store's machineStateHome() (process.env.HOME) is used.
  const home = (ctx && (ctx.HOME || ctx.home)) || null;
  return { rootDir, projectDir, component, write: !!write, positional, flags, home };
}

/** Best-effort FORGE library root = two levels up from this module (manager/..). */
function selfForgeRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr. Returns `{ ok, data, findings, summary }`.
 * Fail-open: any internal failure degrades to an ok-ish empty result, never a throw.
 *
 * Read verbs (`status`, `drift`) write NOTHING. `enable`/`add`/`scan` mutate ONLY the
 * machine-local index (`~/.claude/forge/fleet.json`), never a project tree.
 *
 * @param {string} subcmd enable | status | add | scan | drift
 * @param {any} args string[] | { positional, flags, opts }
 * @param {any} ctx { FORGE_ROOT?, forgeRoot?, root?, cwd?, HOME?, flags?, opts?, write?, apply? }
 * @returns {Promise<{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const n = normalize(args, ctx);
    switch (subcmd) {
      case 'enable':
        return doEnable(n.home);
      case 'status':
        return doStatus(n.rootDir, n.home);
      case 'add':
        return doAdd(n.rootDir, n.projectDir, n.home);
      case 'scan':
        return doScan(n.rootDir, n.positional, n.home);
      case 'drift':
        return doDrift(n.rootDir, n.projectDir, n.component, n.home);
      default:
        return result(false, { usage: usageText() }, [
          finding('ERROR', 'fleet', `unknown fleet subcommand: ${subcmd || '(none)'}`),
        ]);
    }
  } catch (e) {
    // Fail-open: never throw past run().
    return result(false, null, [finding('ERROR', 'fleet', `fleet error: ${e && e.message ? e.message : String(e)}`)]);
  }
}

/** `enable` — write the opt-in flag into the machine-local index (idempotent). */
function doEnable(home) {
  const index = readIndex(home);
  index.fleetEnabled = true;
  // enable alone registers NO project (enable is not registration, BR-FLEET-008).
  if (!index.projects || typeof index.projects !== 'object') index.projects = {};
  const wrote = writeIndex(index, home);
  const findings = wrote
    ? []
    : [finding('WARN', 'fleet', 'could not write the machine-local fleet index (fleet stays disabled)')];
  return result(wrote, { fleetEnabled: true, projects: {} }, findings, { enabled: wrote });
}

/** `status` — one reconciled row per registered project (read-only, fail-open). */
function doStatus(rootDir, home) {
  const index = readIndex(home);
  const findings = [];
  if (index._corrupt) findings.push(finding('WARN', 'fleet', 'fleet index unavailable (corrupt) — treated as no data'));
  const running = readRunningVersion(rootDir);
  /** @type {Record<string,any>} */
  const projects = {};
  for (const [id, row] of Object.entries(index.projects)) {
    const projectDir = row && typeof row.path === 'string' ? row.path : null;
    if (!projectDir) {
      projects[id] = row;
      continue;
    }
    projects[id] = reconcileRow(rootDir, projectDir, row, { runningVersion: running });
  }
  return result(true, { fleetEnabled: index.fleetEnabled, projects }, findings, {
    projects: Object.keys(projects).length,
  });
}

/** `add <project>` — register a project (reconcile its marker, persist the row). */
function doAdd(rootDir, projectDir, home) {
  const index = readIndex(home);
  const id = projectId(projectDir);
  const prior = index.projects[id] || null;
  const running = readRunningVersion(rootDir);
  const row = reconcileRow(rootDir, projectDir, prior, { runningVersion: running });
  // Stamp lastSyncedAt on first registration so the row schema is complete.
  if (!row.lastSyncedAt) row.lastSyncedAt = row.generatedAt || row.lastSeenAt;
  index.projects[id] = row;
  const wrote = writeIndex(index, home);
  const findings = wrote ? [] : [finding('WARN', 'fleet', 'could not persist the fleet row (machine index unwritable)')];
  return result(wrote, { id, row, projects: index.projects }, findings, { projects: Object.keys(index.projects).length });
}

/** `scan [roots...]` — crawl scanRoots for markers, reconcile each (marker rebuilds index). */
function doScan(rootDir, positional, home) {
  const index = readIndex(home);
  const roots = positional.length ? positional : index.scanRoots;
  const found = scanForMarkers(roots, DEFAULT_SCAN_DEPTH);
  const running = readRunningVersion(rootDir);
  for (const projectDir of found) {
    const id = projectId(projectDir);
    const prior = index.projects[id] || null;
    index.projects[id] = reconcileRow(rootDir, projectDir, prior, { runningVersion: running });
  }
  // Persist the discovered scanRoots so a later `scan` (no args) reuses them.
  if (positional.length) index.scanRoots = positional.slice();
  const wrote = writeIndex(index, home);
  const findings = wrote ? [] : [finding('WARN', 'fleet', 'could not persist the scanned fleet index')];
  return result(true, { found: found.length, projects: index.projects }, findings, {
    found: found.length,
    projects: Object.keys(index.projects).length,
  });
}

/**
 * `drift [project] [--component <uid>]` — per-project drift.
 *
 * No registered fleet (or a project arg) ⇒ assess that single project ad-hoc (so
 * `drift <project>` works without prior `add`, as the legacy-marker case needs). With a
 * registered fleet, assess every registered project; `--component <uid>` SCOPES the
 * output to projects whose marker resolves to that uid (BR-FLEET-023).
 *
 * Drift is advisory: a project that is behind yields a WARN finding, NEVER an ERROR
 * (BR-FLEET-022 / ADR-0007).
 *
 * @param {string} rootDir @param {string} projectDir @param {string|null} component @param {string|null} home
 */
function doDrift(rootDir, projectDir, component, home) {
  const index = readIndex(home);
  const running = readRunningVersion(rootDir);
  const findings = [];
  if (index._corrupt) findings.push(finding('WARN', 'fleet', 'fleet index unavailable (corrupt) — treated as no data'));

  // Decide the candidate project set. Registered rows take precedence; otherwise the
  // single ad-hoc projectDir (so a legacy `drift <proj>` works pre-registration).
  /** @type {Array<{id:string, dir:string, prior:any}>} */
  const candidates = [];
  const registeredIds = Object.keys(index.projects);
  if (registeredIds.length > 0) {
    for (const id of registeredIds) {
      const row = index.projects[id];
      const dir = row && typeof row.path === 'string' ? row.path : null;
      if (dir) candidates.push({ id, dir, prior: row });
    }
  } else {
    candidates.push({ id: projectId(projectDir), dir: projectDir, prior: null });
  }

  /** @type {Record<string,any>} */
  const projects = {};
  for (const c of candidates) {
    const marker = readMarker(c.dir);
    // `--component` scope: skip a project whose marker does not resolve to that uid.
    if (component) {
      const uids = marker ? resolveComponentUids(rootDir, marker) : new Set();
      if (!uids.has(component)) continue;
    }
    const row = reconcileRow(rootDir, c.dir, c.prior, { runningVersion: running });
    projects[c.id] = row;
    // Advisory WARN when this project is behind (version OR components).
    const h = row.health || {};
    const behind = h.versionBehind === true || (typeof h.componentsBehind === 'number' && h.componentsBehind > 0);
    if (behind) {
      const parts = [];
      if (h.versionBehind) parts.push(`version behind (${row.tailoredFrom} < ${running})`);
      if (typeof h.componentsBehind === 'number' && h.componentsBehind > 0) {
        parts.push(`${h.componentsBehind} component(s) behind`);
      }
      findings.push(finding('WARN', c.dir, `drift: ${parts.join(', ')}`));
    }
  }

  return result(true, { component: component || null, projects }, findings, {
    projects: Object.keys(projects).length,
  });
}

/**
 * C4 `summarize(state)` — pure; map the fleet index/run state to a one-panel summary.
 * Returns a `(no data)` panel when the fleet is disabled/absent (fail-open).
 *
 * @param {any} state the machine index (or a `run()` data payload) if available.
 * @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  const projects =
    state && typeof state === 'object' && state.projects && typeof state.projects === 'object' ? state.projects : null;
  const enabled = state && typeof state === 'object' ? state.fleetEnabled === true : false;
  if (!enabled || !projects) {
    return makePanel({
      panel: 'fleet',
      ok: false,
      lines: ['(no data)'],
      hint: 'forge fleet enable && forge fleet scan',
    });
  }
  const rows = Array.isArray(projects) ? projects : Object.values(projects);
  const total = rows.length;
  let drifted = 0;
  for (const r of rows) {
    const h = r && r.health ? r.health : r;
    if (h && (h.versionBehind === true || (typeof h.componentsBehind === 'number' && h.componentsBehind > 0))) drifted += 1;
  }
  return makePanel({
    panel: 'fleet',
    ok: true,
    lines: [`${total} project(s)`, `${drifted} drifted`],
  });
}

/**
 * Build a Panel object with a non-enumerable `toString` (mirrors registry.mjs#makePanel)
 * so `String(panel)` renders a human line while JSON stays the clean shape.
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

/** Stamp a C2 finding from this module (source pre-filled). */
function finding(level, p, message) {
  return makeFinding({ level, path: p, line: null, message, source: SOURCE });
}

/**
 * Assemble a ModuleResult `{ ok, data, findings, summary }` (the C4 contract). The C3
 * envelope REQUIRES summary.{errors,warnings,info}; a command's own counts are merged
 * ON TOP of that uniform triple (command keys win on overlap).
 *
 * @param {boolean} ok @param {any} data @param {import('./lib/findings.mjs').Finding[]} [findings] @param {object} [summary]
 */
function result(ok, data, findings = [], summary = undefined) {
  const list = Array.isArray(findings) ? findings : [];
  const sum = summary !== undefined ? { ...levelCounts(list), ...summary } : levelCounts(list);
  return { ok: !!ok, data: data === undefined ? null : data, findings: list, summary: sum };
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

/** Static usage banner for an unknown subcommand. */
function usageText() {
  return [
    'forge fleet enable',
    'forge fleet status',
    'forge fleet add <project>',
    'forge fleet scan [roots...]',
    'forge fleet drift [project] [--component <uid>]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Human render (print side) — the per-row fleet table (read-only)
// ---------------------------------------------------------------------------

/**
 * Render a ModuleResult as human text (print side). Returns the exit code. PRINT
 * happens ONLY in the script entry; run() never writes stdout (the print/compute split).
 *
 * @param {string} subcmd @param {{ok:boolean,data:any,findings:any[],summary:any}} res
 * @returns {number}
 */
function renderHuman(subcmd, res) {
  const out = [];
  const data = res.data || {};
  if (subcmd === 'enable') {
    out.push(`fleet: ${data.fleetEnabled ? 'enabled' : 'disabled'}`);
  } else if (subcmd === 'status' || subcmd === 'drift' || subcmd === 'add' || subcmd === 'scan') {
    const projects = data.projects && typeof data.projects === 'object' ? data.projects : {};
    const rows = Array.isArray(projects) ? projects : Object.values(projects);
    if (rows.length === 0) out.push('fleet: no projects');
    for (const r of rows) {
      const h = (r && r.health) || {};
      const flags = [];
      if (h.versionBehind) flags.push('version-behind');
      if (typeof h.componentsBehind === 'number' && h.componentsBehind > 0) flags.push(`${h.componentsBehind}-comp-behind`);
      out.push(`${r.id}\t${r.status}\t${r.path}${flags.length ? '\t' + flags.join(',') : ''}`);
    }
    if (subcmd === 'scan') out.push(`scanned: ${data.found || 0} marker(s)`);
  }
  for (const f of res.findings || []) {
    const loc = f.line ? `${f.path}:${f.line}` : f.path;
    process.stderr.write(`${f.level} ${loc} ${f.message}\n`);
  }
  if (out.length) process.stdout.write(out.join('\n') + '\n');
  return res.ok ? 0 : (res.findings || []).some((f) => f.level === 'ERROR') ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Dual-mode: direct script entry
//   node manager/fleet.mjs <subcmd> [flags] [project]
// Renders human text, or the C3 --json envelope under --json. PRINT happens ONLY here
// (the print/compute split): run() never writes stdout. NEVER process.exit() at import
// time — the isMain() guard ensures the node:test runner is never killed.
// ---------------------------------------------------------------------------

/** True when this module is executed directly (not imported). */
function isMain() {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const subcmd = argv[0];
  const rest = argv.slice(1);
  const json = rest.includes('--json');
  run(subcmd, rest, {})
    .then((res) => {
      if (json) {
        const env = envelope({
          command: `fleet ${subcmd || ''}`.trim(),
          ok: res.ok,
          data: res.data,
          findings: res.findings,
          summary: res.summary,
          forgeVersion: readRunningVersion(selfForgeRoot()),
        });
        writeStdoutSync(JSON.stringify(env) + '\n'); // SYNC write before exit — pipe-flush truncation (see json-out.mjs)
        process.exit(res.ok ? 0 : (res.findings || []).some((f) => f.level === 'ERROR') ? 1 : 0);
      } else {
        process.exit(renderHuman(subcmd, res));
      }
    })
    .catch(() => process.exit(1)); // fail-open: never an unhandled rejection
}

export default { run, summarize, computeSourceRev };
