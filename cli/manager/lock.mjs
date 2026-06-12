// @ts-check
/**
 * lock — the manager's per-project LOCKFILE operator (ADR-0022).
 *
 * GROUNDING IN THE BACKBONE. `forge.lock` is the RESOLVED per-project COMPOSITION manifest: the
 * project analogue of `package-lock.json`. It JOINS the adopted set (ADR-0019 composition) with
 * the TAILORING overlays (ADR-0021), the ADJUDICATION choices (ADR-0020), and each entry's pinned
 * `version`/`commit` (the catalog record / `.forge/sources.lock`, ADR-0017 §2.2), plus a
 * DETERMINISTIC content `hash` over the resolved entries. It lives at the ACTIVE PROJECT ROOT
 * (`<activeRoot>/forge.lock`), NOT under `.forge/` and NOT in the git-tracked library, and is
 * intended to be COMMITTED (BR-CAT-017).
 *
 * DISTINCT FROM `.forge/sources.lock`. The two lockfiles answer different questions and never merge
 * (ADR-0022 §2): `.forge/sources.lock` (`forge.sources.lock.v1`) pins each SOURCE's resolved git
 * `commit`, lives under `.forge/`, and is machine-local (NEVER committed); `forge.lock`
 * (`forge.lock.v1`) records the resolved PROJECT COMPOSITION, lives at the project root, and is
 * git-committable. `forge.lock` CONSUMES `sources.lock`'s per-entry `commit` as one input — that is
 * the only relationship.
 *
 * DERIVED — A PURE JOIN, NO NEW AUTHORITY (BR-CAT-017, ADR-0022 §5). The operator builds `entries`
 * by REUSING the existing per-project read helpers:
 *   - the adopted set + kind + base version from `manager/compose.mjs` (`compose list`, ADR-0019);
 *   - the overlays + the resolved (pin) version from `manager/tailor.mjs` (`tailor list`, ADR-0021)
 *     — a `pin` overlay wins the resolved `version`, else the catalog record version;
 *   - the adjudication winner per uid from `manager/conflict.mjs` (`conflict list`, ADR-0020);
 *   - each entry's pinned source `commit` from `<FORGE_ROOT>/.forge/sources.lock` (ADR-0017 §2.2).
 * We duplicate no scanning, read-view, dedup, adoption, conflict, or tailoring logic, and invoke NO
 * model. `forge.lock` is the ONLY place the resolved whole is persisted, precisely because a
 * committable content hash is the point; everything in it is reproducible from those inputs.
 *
 * DETERMINISTIC HASH, EXCLUDING `generatedAt` (BR-CAT-018, ADR-0022 §3). `hash` is a sha256 digest
 * (node:crypto, first 16 hex) over the CANONICAL resolved entries: entries sorted by uid then
 * sourceId, each entry's overlays sorted (by type, then detail), taken over the resolved fields
 * (`uid`, `sourceId`, `kind`, `version`, `commit`, sorted `overlays`, `adjudication`) and EXCLUDING
 * `generatedAt`. The SAME composition yields the SAME hash across machines and times; re-writing an
 * unchanged composition is idempotent (same entries → same hash). `generatedAt` is recorded for
 * humans ONLY (the standard JS Date API is available in the CLI itself — only Workflow scripts
 * forbid it) and never feeds the digest.
 *
 * MANIFEST-ONLY — NEVER MATERIALIZES `.claude/` (BR-CAT-019, ADR-0022 §4). `lock write` RESOLVES the
 * composition and, on `--apply`, writes `<activeRoot>/forge.lock` atomically (lib/store.mjs). It
 * writes ONLY that manifest. It MUST NOT generate/materialize/modify any real `.claude/` file, the
 * git-tracked library, or any resource content; it MUST NOT run the admission pipeline, read-view,
 * dedup, judge, or any model; it MUST NOT modify the composition/adjudication/tailoring stores it
 * READS. Materializing the resolved composition into a project's `.claude/` tree is the EXISTING
 * bootstrap composer's job and is EXPLICITLY OUT OF SCOPE (a future step, ADR-0022 §7).
 *
 * The two roots, kept STRICTLY separate (mirrors compose.mjs/conflict.mjs/tailor.mjs):
 *   - FORGE_ROOT  — this library's install location. `.forge/sources.lock` (the source commit pins)
 *                   lives here; we resolve it from this module's own URL and READ it.
 *   - ACTIVE ROOT — the target PROJECT (ctx.cwd / ctx.root / process.cwd()). forge.lock is read/
 *                   written HERE, at the project root (NOT under .forge/) — per-project state.
 *
 * HARD INVARIANTS (the plugin payload contract): zero runtime deps (node: builtins + relative
 * imports only); additive-never-destructive; writers PREVIEW by default (write only under
 * `--apply`); fail-open (no public entry throws past its surface — it degrades to a safe
 * `{ok,data,findings,summary}` envelope). Dual-mode with an `isMain()` guard — NEVER process.exit()
 * at import time. NO model/judge invocation.
 *
 * Subcommands (C4 `run(subcmd, args, ctx)`):
 *   - `show`           — read forge.lock; report exists/committed (best-effort git-tracked)/inSync
 *                        (file hash === freshly-resolved hash). Read-only.
 *   - `write [--apply]`— RESOLVE the composition, compute entries + hash; on --apply write
 *                        <activeRoot>/forge.lock atomically. Preview returns the would-be lock.
 *                        Idempotent (same composition → same hash). NEVER touches .claude/.
 *   - `diff`           — compare the CURRENT forge.lock vs the freshly-resolved composition; emit
 *                        +/~/- changes. Read-only.
 *
 * @module manager/lock
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import { readJson, writeJsonAtomic, forgeHome } from './lib/store.mjs';
// REUSE the existing per-project read helpers (ADR-0022 §5, BR-CAT-017). `compose list` gives the
// adopted set JOINED to its catalog records (kind + base version); `tailor list` gives the overlays
// + the resolved (pin) version per (uid, sourceId); `conflict list` gives the recorded adjudication
// winner per uid. We never re-scan, never re-derive the read-view, and never duplicate the write
// logic — relative specifiers keep this zerodep-clean.
import { run as composeRun } from './compose.mjs';
import { run as tailorRun } from './tailor.mjs';
import { run as conflictRun } from './conflict.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The emitter stamped on findings this module raises (C2 `lock`). */
const SOURCE = 'lock';

/** The on-disk lock schema tag (matches schemas/lock.schema.json). */
const SCHEMA_TAG = 'forge.lock.v1';

/** The lock file's current version integer. */
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Root + path resolution (mirrors compose.mjs/conflict.mjs)
// ---------------------------------------------------------------------------

/**
 * The ACTIVE PROJECT root the lockfile lives under. Mirrors compose.mjs: ctx.cwd / ctx.root, else
 * the process cwd. forge.lock is per-project state at the project root (ADR-0022 §1).
 * @param {any} ctx @returns {string}
 */
function resolveActiveRoot(ctx) {
  return (ctx && (ctx.cwd || ctx.root)) || process.cwd();
}

/** The project lockfile path under the active root (the only file this module writes). */
function lockPath(activeRoot) {
  return path.join(activeRoot, 'forge.lock');
}

/** Project-relative lock path for finding paths (fail-open). */
function relLock(activeRoot) {
  try {
    return path.relative(activeRoot, lockPath(activeRoot)) || lockPath(activeRoot);
  } catch {
    return 'forge.lock';
  }
}

/** Best-effort FORGE library root = two levels up from this module (manager/..). */
function selfForgeRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

/** The source lockfile path `<FORGE_HOME>/.forge/sources.lock` (the source commit pins, ADR-0017;
 *  relocated to the global config root by ADR-0023). `lock` only READS it here, to JOIN each
 *  entry's pinned `commit`; source.mjs OWNS and writes it. The `forgeRoot` arg is retained for
 *  the signature; the file is FORGE_HOME-rooted (machine-level GLOBAL federation state). */
function sourcesLockPath(_forgeRoot) {
  return path.join(forgeHome(), '.forge', 'sources.lock');
}

// ---------------------------------------------------------------------------
// Lock reads (forge.lock.v1)
// ---------------------------------------------------------------------------

/**
 * Read + normalize the project lockfile. An ABSENT file degrades to `{ exists:false, lock:null }`
 * (the additive contract: write may create it). A present-but-malformed file degrades to
 * `{ exists:true, malformed:true, lock:null }`. Fail-open: never throws.
 * @param {string} activeRoot
 * @returns {{ exists:boolean, malformed:boolean, lock:any }}
 */
function readLock(activeRoot) {
  const abs = lockPath(activeRoot);
  let exists = false;
  try {
    exists = fs.statSync(abs).isFile();
  } catch {
    exists = false;
  }
  if (!exists) return { exists: false, malformed: false, lock: null };
  const parsed = readJson(abs);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { exists: true, malformed: true, lock: null };
  }
  return { exists: true, malformed: false, lock: parsed };
}

// ---------------------------------------------------------------------------
// Source-commit pins (the one input CONSUMED from .forge/sources.lock, ADR-0017 §2.2)
// ---------------------------------------------------------------------------

/**
 * Read the per-source pinned commit map from `<FORGE_ROOT>/.forge/sources.lock` (the SOURCE
 * lockfile, forge.sources.lock.v1, BR-CAT-002). We CONSUME this store (forge source sync writes
 * it); we never write it here. Absent/malformed degrades to an empty map (fail-open) — every
 * entry's `commit` then resolves to null. Returns Map(sourceId -> commit:string|null).
 * @param {string} forgeRoot @returns {Map<string,string|null>}
 */
function readSourceCommits(forgeRoot) {
  /** @type {Map<string,string|null>} */
  const byId = new Map();
  const parsed = readJson(sourcesLockPath(forgeRoot));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return byId;
  const list = Array.isArray(parsed.sources) ? parsed.sources : [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    if (typeof s.id !== 'string' || !s.id) continue;
    const commit = typeof s.commit === 'string' && s.commit ? s.commit : null;
    byId.set(s.id, commit);
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Canonical entry order + content hash (BR-CAT-018, ADR-0022 §3)
// ---------------------------------------------------------------------------

/** Deterministic entry order: by uid, then by sourceId (null first). */
function compareEntries(a, b) {
  if (a.uid !== b.uid) return a.uid < b.uid ? -1 : 1;
  const sa = a.sourceId;
  const sb = b.sourceId;
  if (sa === sb) return 0;
  if (sa === null || sa === undefined) return -1;
  if (sb === null || sb === undefined) return 1;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Deterministic overlay order: by type, then by detail (mirrors tailor.mjs#compareOverlay). */
function compareOverlay(a, b) {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
}

/** A sorted clone of an overlay list (each overlay reduced to {type, detail}). */
function sortedOverlays(overlays) {
  const list = Array.isArray(overlays) ? overlays : [];
  return list
    .map((o) => ({ type: typeof o.type === 'string' ? o.type : '', detail: typeof o.detail === 'string' ? o.detail : '' }))
    .sort(compareOverlay);
}

/**
 * Compute the DETERMINISTIC content hash over the CANONICAL resolved entries (BR-CAT-018). The
 * canonical form sorts entries (uid, then sourceId) and each entry's overlays (type, then detail),
 * serializes ONLY the resolved fields (uid, sourceId, kind, version, commit, sorted overlays,
 * adjudication) — EXCLUDING `generatedAt` — and digests it with sha256 (node:crypto), taking the
 * first 16 hex. The SAME composition yields the SAME hash; `generatedAt` never participates.
 * @param {object[]} entries @returns {string}
 */
function computeHash(entries) {
  const canonical = entries
    .map((e) => ({
      uid: e.uid,
      sourceId: e.sourceId === undefined ? null : e.sourceId,
      kind: e.kind === undefined ? '' : e.kind,
      version: e.version === undefined ? null : e.version,
      commit: e.commit === undefined ? null : e.commit,
      overlays: sortedOverlays(e.overlays),
      adjudication: e.adjudication === undefined ? null : e.adjudication,
    }))
    .slice()
    .sort(compareEntries);
  const json = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Resolution — the pure JOIN over compose/tailor/conflict + the source pins (ADR-0022 §5)
// ---------------------------------------------------------------------------

/** The collision-safe key for a (uid, sourceId) pair (null sourceId -> the sentinel ' '). */
function entryKey(uid, sourceId) {
  return `${uid} ${sourceId === null || sourceId === undefined ? ' ' : sourceId}`;
}

/**
 * RESOLVE the composition into canonical lock entries by JOINing the existing read helpers. REUSES
 * `compose list` (adopted + kind + base version), `tailor list` (overlays + resolved pin version),
 * `conflict list` (adjudication winner per uid), and `.forge/sources.lock` (pinned commit per
 * sourceId). Pure: reads only, writes nothing, invokes no model. Fail-open: any helper failure
 * degrades to a WARN + an empty contribution, never a throw.
 *
 * @param {string} activeRoot @returns {Promise<{ entries:object[], findings:import('./lib/findings.mjs').Finding[] }>}
 */
async function resolveEntries(activeRoot) {
  const findings = [];
  const forgeRoot = selfForgeRoot();

  // 1. The adopted set, JOINed to the catalog read-view (kind + base version). compose list is the
  //    canonical adopted view (ADR-0019); we reuse it verbatim.
  /** @type {{uid:string,sourceId:string|null,kind:string,version:string}[]} */
  let adopted = [];
  try {
    const res = await composeRun('list', [], { cwd: activeRoot });
    adopted = res && res.data && Array.isArray(res.data.adopted) ? res.data.adopted : [];
  } catch (e) {
    findings.push(finding('WARN', 'lock', `compose list failed: ${e && e.message ? e.message : String(e)} — empty adopted set`));
    adopted = [];
  }

  // 2. The tailoring overlays + resolved (pin) version, keyed by (uid, sourceId). tailor list folds
  //    a `pin` overlay into resolved.version (ADR-0021 §3); we consume that resolved version.
  /** @type {Map<string,{overlays:{type:string,detail:string}[],version:string}>} */
  const tailorByKey = new Map();
  try {
    const res = await tailorRun('list', [], { cwd: activeRoot });
    const tailored = res && res.data && Array.isArray(res.data.tailored) ? res.data.tailored : [];
    for (const t of tailored) {
      if (!t || typeof t.uid !== 'string') continue;
      const sourceId = typeof t.sourceId === 'string' && t.sourceId ? t.sourceId : null;
      const overlays = sortedOverlays(t.overlays);
      const resolvedVersion = t.resolved && typeof t.resolved.version === 'string' ? t.resolved.version : '';
      tailorByKey.set(entryKey(t.uid, sourceId), { overlays, version: resolvedVersion });
    }
  } catch (e) {
    findings.push(finding('WARN', 'lock', `tailor list failed: ${e && e.message ? e.message : String(e)} — no overlays folded`));
  }

  // 3. The recorded adjudication winner per uid (the human T2 pick, ADR-0020). conflict list exposes
  //    `choice` (the recorded winner sourceId, or null) on each conflict; we key it by uid.
  /** @type {Map<string,string|null>} */
  const adjByUid = new Map();
  try {
    const res = await conflictRun('list', [], { cwd: activeRoot });
    const conflicts = res && res.data && Array.isArray(res.data.conflicts) ? res.data.conflicts : [];
    for (const c of conflicts) {
      if (!c || typeof c.uid !== 'string') continue;
      const choice = typeof c.choice === 'string' && c.choice ? c.choice : null;
      adjByUid.set(c.uid, choice);
    }
  } catch (e) {
    findings.push(finding('WARN', 'lock', `conflict list failed: ${e && e.message ? e.message : String(e)} — no adjudication folded`));
  }

  // 4. The pinned source commit per sourceId (CONSUMED from .forge/sources.lock, ADR-0017 §2.2).
  const commitBySource = readSourceCommits(forgeRoot);

  // JOIN: one entry per adopted (uid, sourceId). A `pin` overlay's resolved version wins over the
  // catalog record version (the §3 folding); commit is null for a library-local entry (sourceId
  // null) or an unpinned source; adjudication is the recorded winner for the uid (else null).
  const entries = [];
  for (const a of adopted) {
    if (!a || typeof a.uid !== 'string' || !a.uid) continue;
    const sourceId = typeof a.sourceId === 'string' && a.sourceId ? a.sourceId : null;
    const key = entryKey(a.uid, sourceId);
    const tail = tailorByKey.get(key) || null;
    const baseVersion = typeof a.version === 'string' && a.version ? a.version : null;
    // The pin (resolved) version wins when tailoring produced a non-empty one; else the base version.
    const version = tail && tail.version ? tail.version : baseVersion;
    const overlays = tail ? tail.overlays : [];
    const commit = sourceId === null ? null : (commitBySource.has(sourceId) ? commitBySource.get(sourceId) : null);
    const adjudication = adjByUid.has(a.uid) ? adjByUid.get(a.uid) : null;
    entries.push({
      uid: a.uid,
      sourceId,
      kind: typeof a.kind === 'string' ? a.kind : '',
      version,
      commit: commit === undefined ? null : commit,
      overlays,
      adjudication: adjudication === undefined ? null : adjudication,
    });
  }
  entries.sort(compareEntries);
  return { entries, findings };
}

/**
 * Build the full freshly-resolved lock object (entries + hash + schema/version + a fresh
 * generatedAt). The hash is computed over the entries ONLY (excluding generatedAt). The
 * generatedAt timestamp is from the runtime clock (ADR-0022 §3 — allowed in the CLI itself).
 * @param {object[]} entries @returns {{schema:string,version:number,generatedAt:string,hash:string,entries:object[]}}
 */
function buildLock(entries) {
  return {
    schema: SCHEMA_TAG,
    version: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    hash: computeHash(entries),
    entries,
  };
}

// ---------------------------------------------------------------------------
// git tracking (best-effort `committed` signal)
// ---------------------------------------------------------------------------

/**
 * Best-effort "is forge.lock tracked by git?" (ADR-0022 §6). Runs `git ls-files --error-unmatch
 * forge.lock` in the active root; status 0 means tracked. ANY failure (no git, not a repo, not
 * tracked, spawn error) degrades to `false`. Never throws. Read-only (no working-tree mutation).
 * @param {string} activeRoot @returns {boolean}
 */
function isCommitted(activeRoot) {
  try {
    const r = spawnSync('git', ['ls-files', '--error-unmatch', '--', 'forge.lock'], {
      cwd: activeRoot,
      encoding: 'utf8',
      shell: false,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// normalize — mirrors compose.mjs#normalize (lock has no value-opts; --apply only)
// ---------------------------------------------------------------------------

/**
 * Normalise `ctx`/`args` to { apply, positional, flags }. `lock` takes no value-opts; `--apply` (or
 * `--write`) is the write toggle for `write`. Mirrors compose.mjs#normalize.
 */
function normalize(args, ctx) {
  const flags = new Set();
  const positional = [];
  const argList = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  for (const a of argList) {
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      flags.add(eq >= 0 ? body.slice(0, eq) : body);
    } else {
      positional.push(a);
    }
  }
  if (ctx && ctx.flags instanceof Set) for (const f of ctx.flags) flags.add(f);
  const apply = flags.has('apply') || flags.has('write') || (ctx && (ctx.apply === true || ctx.write === true));
  return { apply: !!apply, positional, flags };
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr. Returns `{ ok, data, findings, summary }`. Fail-open: any
 * internal failure degrades to an ok-ish empty result, never a throw.
 *
 * `show`/`diff` write NOTHING. `write` writes ONLY `<activeRoot>/forge.lock` and ONLY under
 * `--apply`; the default is always a preview. NO `.claude/` file, library record, or
 * composition/adjudication/tailoring store is EVER mutated (MANIFEST-ONLY, BR-CAT-019). NO model.
 *
 * @param {string} subcmd show | write | diff
 * @param {any} args string[] | { positional, flags }
 * @param {any} ctx { cwd?, root?, flags?, apply?, write? }
 * @returns {Promise<{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const n = normalize(args, ctx);
    const activeRoot = resolveActiveRoot(ctx);
    switch (subcmd) {
      case 'show':
        return await doShow(activeRoot);
      case 'write':
        return await doWrite(activeRoot, n.apply);
      case 'diff':
        return await doDiff(activeRoot);
      default:
        return result(false, { usage: usageText() }, [
          finding('ERROR', 'lock', `unknown lock subcommand: ${subcmd || '(none)'}`),
        ]);
    }
  } catch (e) {
    return result(false, null, [
      finding('ERROR', 'lock', `lock error: ${e && e.message ? e.message : String(e)}`),
    ]);
  }
}

/**
 * `show` — read forge.lock; report its contents, whether it exists, whether it is git-tracked
 * (best-effort `committed`), and whether it is in sync (the file's `hash` equals a freshly-resolved
 * hash, §3). Read-only — resolves the composition only to compute the comparison hash, writes
 * nothing.
 *
 * Returns `data { lockPath, exists, lock:<contents>|null, committed, inSync }` (ADR-0022 §6).
 */
async function doShow(activeRoot) {
  const findings = [];
  const { exists, malformed, lock } = readLock(activeRoot);
  if (malformed) {
    findings.push(finding('WARN', relLock(activeRoot), 'forge.lock is not a JSON object — treating as absent for sync comparison'));
  } else if (!exists) {
    findings.push(finding('INFO', relLock(activeRoot), 'no forge.lock yet — run `forge lock write --apply` to resolve + commit the composition'));
  }

  const committed = isCommitted(activeRoot);

  // Freshly resolve to compute the comparison hash (read-only; the resolved entries are not written).
  const { entries, findings: resFindings } = await resolveEntries(activeRoot);
  for (const f of resFindings) findings.push(f);
  const freshHash = computeHash(entries);

  const fileHash = lock && typeof lock.hash === 'string' ? lock.hash : null;
  const inSync = exists && !malformed && fileHash !== null && fileHash === freshHash;

  if (exists && !malformed && !inSync) {
    findings.push(finding('WARN', relLock(activeRoot), `forge.lock is STALE — its hash (${fileHash || '—'}) != the freshly-resolved hash (${freshHash}); run \`forge lock write --apply\` to re-resolve (ADR-0022 §6)`));
  }

  return result(true, {
    lockPath: lockPath(activeRoot),
    exists,
    lock: malformed ? null : lock,
    committed,
    inSync,
  }, findings, {
    exists: exists ? 1 : 0,
    committed: committed ? 1 : 0,
    inSync: inSync ? 1 : 0,
    entries: lock && Array.isArray(lock.entries) ? lock.entries.length : (exists ? 0 : entries.length),
  });
}

/**
 * `write [--apply]` — RESOLVE the composition (§5), compute entries + hash (§3), and on `--apply`
 * write `<activeRoot>/forge.lock` atomically (lib/store.mjs). Preview (no `--apply`) returns the
 * would-be lock without writing. Idempotent: re-writing an unchanged composition yields the same
 * hash. MANIFEST-ONLY — NEVER touches `.claude/`, the library, or the stores it reads (BR-CAT-019).
 *
 * Returns `data { lockPath, applied, written, hash, priorHash, changed, lock:<would-be|written> }`.
 */
async function doWrite(activeRoot, apply) {
  const findings = [];
  const { entries, findings: resFindings } = await resolveEntries(activeRoot);
  for (const f of resFindings) findings.push(f);

  const lock = buildLock(entries);
  const newHash = lock.hash;

  // Compare against any current lock to report whether the resolved composition CHANGED.
  const { exists, malformed, lock: priorLock } = readLock(activeRoot);
  const priorHash = !malformed && priorLock && typeof priorLock.hash === 'string' ? priorLock.hash : null;
  const changed = priorHash !== newHash; // a fresh write (no prior) or a different hash is a change.

  let written = false;
  if (apply) {
    written = writeJsonAtomic(lockPath(activeRoot), lock);
    if (!written) {
      findings.push(finding('WARN', relLock(activeRoot), 'could not write forge.lock'));
    } else if (changed) {
      findings.push(finding('INFO', 'lock', `wrote forge.lock: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, hash ${newHash} (resolved composition — MANIFEST ONLY, no .claude/ written; ADR-0022 §4)`));
    } else {
      findings.push(finding('INFO', 'lock', `wrote forge.lock: unchanged composition, hash ${newHash} (idempotent — same entries → same hash)`));
    }
  } else {
    findings.push(finding('INFO', relLock(activeRoot), `dry-run: pass --apply to write forge.lock (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, hash ${newHash})${exists && !changed ? ' — in sync with the current lock' : ''}`));
  }

  return result(true, {
    lockPath: lockPath(activeRoot),
    applied: !!apply,
    written,
    hash: newHash,
    priorHash,
    changed,
    lock,
  }, findings, {
    entries: entries.length,
    written: written ? 1 : 0,
    changed: changed ? 1 : 0,
  });
}

/**
 * `diff` — compare the CURRENT forge.lock against the freshly-resolved composition (what `write`
 * would produce) and emit per-entry changes: `"+"` = newly resolved entry not in the lock; `"-"` =
 * in the lock but no longer resolved; `"~"` = version / overlay / adjudication changed. Read-only.
 *
 * Returns `data { changes:[ { op, uid, sourceId, from?, to?, note? } ], summary, hash, priorHash,
 * inSync }` (ADR-0022 §6).
 */
async function doDiff(activeRoot) {
  const findings = [];
  const { exists, malformed, lock } = readLock(activeRoot);
  if (malformed) {
    findings.push(finding('WARN', relLock(activeRoot), 'forge.lock is not a JSON object — diffing against an empty lock'));
  } else if (!exists) {
    findings.push(finding('INFO', relLock(activeRoot), 'no forge.lock yet — every resolved entry shows as a new "+" addition'));
  }

  const { entries: fresh, findings: resFindings } = await resolveEntries(activeRoot);
  for (const f of resFindings) findings.push(f);

  const priorEntries = lock && Array.isArray(lock.entries) ? lock.entries : [];
  const priorByKey = new Map();
  for (const e of priorEntries) {
    if (!e || typeof e.uid !== 'string') continue;
    const sourceId = typeof e.sourceId === 'string' && e.sourceId ? e.sourceId : null;
    priorByKey.set(entryKey(e.uid, sourceId), e);
  }
  const freshByKey = new Map();
  for (const e of fresh) freshByKey.set(entryKey(e.uid, e.sourceId), e);

  const changes = [];
  // All keys, sorted deterministically by uid then sourceId.
  const allKeys = new Set([...priorByKey.keys(), ...freshByKey.keys()]);
  const ordered = [...allKeys].sort((ka, kb) => {
    const a = freshByKey.get(ka) || priorByKey.get(ka);
    const b = freshByKey.get(kb) || priorByKey.get(kb);
    return compareEntries(a, b);
  });

  for (const key of ordered) {
    const prior = priorByKey.get(key) || null;
    const next = freshByKey.get(key) || null;
    if (prior && !next) {
      changes.push({ op: '-', uid: prior.uid, sourceId: prior.sourceId === undefined ? null : prior.sourceId, note: 'no longer resolved (removed from the composition)' });
    } else if (!prior && next) {
      changes.push({ op: '+', uid: next.uid, sourceId: next.sourceId, note: 'newly resolved entry not in the lock' });
    } else if (prior && next) {
      const note = describeEntryDelta(prior, next);
      if (note) {
        changes.push({ op: '~', uid: next.uid, sourceId: next.sourceId, from: entrySummary(prior), to: entrySummary(next), note });
      }
    }
  }

  const priorHash = !malformed && lock && typeof lock.hash === 'string' ? lock.hash : null;
  const freshHash = computeHash(fresh);
  const inSync = exists && !malformed && priorHash !== null && priorHash === freshHash;

  const summary = {
    total: changes.length,
    added: changes.filter((c) => c.op === '+').length,
    removed: changes.filter((c) => c.op === '-').length,
    changed: changes.filter((c) => c.op === '~').length,
  };

  if (changes.length === 0) {
    findings.push(finding('INFO', 'lock', exists && !malformed
      ? 'forge.lock is in sync with the resolved composition — no changes'
      : 'no entries resolved and no lock present — nothing to diff'));
  } else {
    findings.push(finding('WARN', 'lock', `${summary.total} change(s) — forge.lock is stale (+${summary.added} ~${summary.changed} -${summary.removed}); run \`forge lock write --apply\` to re-resolve`));
  }

  return result(true, {
    changes,
    summary,
    hash: freshHash,
    priorHash,
    inSync,
  }, findings, summary);
}

/** A compact one-field summary of a lock entry (for a diff's from/to). */
function entrySummary(e) {
  return {
    version: e.version === undefined ? null : e.version,
    commit: e.commit === undefined ? null : e.commit,
    overlays: sortedOverlays(e.overlays).map((o) => `${o.type}${o.detail ? `=${o.detail}` : ''}`),
    adjudication: e.adjudication === undefined ? null : e.adjudication,
  };
}

/**
 * Describe what changed between a prior and a fresh entry (version / overlays / adjudication /
 * commit). Returns a human note, or '' when nothing material changed (same resolved fields).
 * @param {object} prior @param {object} next @returns {string}
 */
function describeEntryDelta(prior, next) {
  const parts = [];
  const pv = prior.version === undefined ? null : prior.version;
  const nv = next.version === undefined ? null : next.version;
  if (pv !== nv) parts.push(`version ${pv || '—'} → ${nv || '—'}`);
  const pc = prior.commit === undefined ? null : prior.commit;
  const nc = next.commit === undefined ? null : next.commit;
  if (pc !== nc) parts.push(`commit ${pc || '—'} → ${nc || '—'}`);
  const po = JSON.stringify(sortedOverlays(prior.overlays));
  const no = JSON.stringify(sortedOverlays(next.overlays));
  if (po !== no) parts.push('overlays changed');
  const pa = prior.adjudication === undefined ? null : prior.adjudication;
  const na = next.adjudication === undefined ? null : next.adjudication;
  if (pa !== na) parts.push(`adjudication ${pa || '—'} → ${na || '—'}`);
  return parts.join('; ');
}

/**
 * C4 `summarize(state)` — pure; map a run-state to a one-panel summary. Handles a show state
 * (entries/inSync), a write state (entries/hash), and a diff state (changes). Returns a `(no data)`
 * panel when the state is unrecognized (fail-open).
 * @param {any} state @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  const s = state && typeof state === 'object' ? state : null;
  if (!s) {
    return makePanel({ panel: 'lock', ok: false, lines: ['(no data)'], hint: 'forge lock show' });
  }
  // diff state
  if (Array.isArray(s.changes)) {
    const n = s.changes.length;
    return makePanel({ panel: 'lock', ok: n === 0, lines: n === 0 ? ['in sync', 'no changes'] : [`${n} change${n === 1 ? '' : 's'}`, 'lock stale'] });
  }
  // show state
  if (typeof s.exists === 'boolean') {
    const entries = s.lock && Array.isArray(s.lock.entries) ? s.lock.entries.length : 0;
    return makePanel({
      panel: 'lock',
      ok: s.exists ? !!s.inSync : true,
      lines: [s.exists ? `${entries} entr${entries === 1 ? 'y' : 'ies'}` : 'no lock', s.exists ? (s.inSync ? 'in sync' : 'stale') : 'run write'],
    });
  }
  // write state
  if (typeof s.hash === 'string' && s.lock && Array.isArray(s.lock.entries)) {
    return makePanel({ panel: 'lock', ok: true, lines: [`${s.lock.entries.length} entr${s.lock.entries.length === 1 ? 'y' : 'ies'}`, `hash ${s.hash}`] });
  }
  return makePanel({ panel: 'lock', ok: false, lines: ['(no data)'], hint: 'forge lock show' });
}

/** Build a Panel with a non-enumerable toString (mirrors compose.mjs#makePanel). */
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

/** Stamp a C2 finding from this module (lock pre-filled). */
function finding(level, p, message) {
  return makeFinding({ level, path: p, line: null, message, source: SOURCE });
}

/**
 * Assemble a ModuleResult `{ ok, data, findings, summary }` (the C4 contract).
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
    'forge lock show [--json]',
    'forge lock write [--apply]',
    'forge lock diff [--json]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Human render (print side)
// ---------------------------------------------------------------------------

/**
 * Render a ModuleResult as human text (print side). Returns the exit code. PRINT happens ONLY in
 * the script entry; run() never writes stdout.
 * @param {string} subcmd @param {{ok:boolean,data:any,findings:any[],summary:any}} res @returns {number}
 */
function renderHuman(subcmd, res) {
  const out = [];
  const data = res.data || {};
  if (data.usage) {
    out.push(data.usage);
  } else if (subcmd === 'show') {
    if (!data.exists) {
      out.push('lock: no forge.lock yet (forge lock write --apply)');
    } else {
      const lock = data.lock || {};
      const entries = Array.isArray(lock.entries) ? lock.entries : [];
      out.push(`lock: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}  schema=${lock.schema || '?'}  hash=${lock.hash || '?'}  committed=${data.committed ? 'yes' : 'no'}  ${data.inSync ? 'in-sync' : 'STALE'}`);
      for (const e of entries) {
        const src = e.sourceId === null || e.sourceId === undefined ? 'library-local' : e.sourceId;
        const ov = (Array.isArray(e.overlays) ? e.overlays : []).map((o) => `${o.type}${o.detail ? `=${o.detail}` : ''}`).join(',');
        out.push(`  ${e.uid}\t${src}@${e.version || '-'}\t#${e.commit || '-'}\t[${ov}]${e.adjudication ? `\tadj:${e.adjudication}` : ''}`);
      }
    }
  } else if (subcmd === 'write') {
    out.push(`lock write: ${data.changed ? 'changed' : 'unchanged'} (${(data.lock && data.lock.entries ? data.lock.entries.length : 0)} entries, hash ${data.hash})${data.applied ? (data.written ? ' — written' : ' — NOT written') : ' (preview — pass --apply)'}`);
  } else if (subcmd === 'diff') {
    const changes = Array.isArray(data.changes) ? data.changes : [];
    if (changes.length === 0) out.push('lock diff: in sync — no changes');
    for (const c of changes) {
      const src = c.sourceId === null || c.sourceId === undefined ? 'library-local' : c.sourceId;
      out.push(`  ${c.op} ${c.uid} (${src})${c.note ? `\t${c.note}` : ''}`);
    }
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
//   node manager/lock.mjs <subcmd> [flags]
// Renders human text, or the C3 --json envelope under --json. PRINT happens ONLY here.
// NEVER process.exit() at import time — the isMain() guard protects the node:test runner.
// ---------------------------------------------------------------------------

/** Read the running forge VERSION at the library root (fail-open to '0.0.0'). */
function readRunningVersion(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'VERSION'), 'utf8').trim();
    return raw || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

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
  // The active root is the process cwd (bin/forge.mjs runs us in the project cwd).
  run(subcmd, rest, { cwd: process.cwd() })
    .then((res) => {
      if (json) {
        const env = envelope({
          command: `lock ${subcmd || ''}`.trim(),
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

export default { run, summarize };
