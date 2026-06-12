#!/usr/bin/env node
/**
 * validate-registry — lint Forge's OWN generated registry (SPEC-01 §Staleness,
 * SPEC-02 §Drift, ADR-0008, ADR-0014). Auto-discovered by lint/run-all.mjs.
 *
 * Advisory-first (ADR-0007). It does ONE thing the manager modules cannot do for
 * themselves: assert that the committed `.forge/registry.json` still equals a fresh
 * in-memory rebuild, and surface VERSION drift. Logic:
 *
 *   1. Resolve rootDir (positional arg, else the FORGE plugin root) like every
 *      sibling validator.
 *   2. No committed `<root>/.forge/registry.json` → ONE INFO ("no committed
 *      registry; run forge registry build --write") and PASS. The un-built real repo
 *      stays GREEN; the VERSION triple check still runs.
 *   3. Committed registry present → fresh-scan via `buildRegistry(root)` and compare,
 *      SPLIT by the kind of drift (decided model). A STRUCTURAL change — an artifact
 *      added/removed, or a shared artifact whose {kind,id,path,status,modules} changed
 *      — means the catalog is wrong: ERROR "registry stale, run forge registry build
 *      --write" and exit 1 (EVAL-REG-002).
 *   4. VERSION triple-drift (EVAL-REG-008 / BR-REG-008): read `<root>/VERSION`,
 *      `package.json` version, `.claude-plugin/plugin.json` version; the `-design`
 *      pre-release suffix is STRIPPED before the equality test (SPEC-02; '0.1.0-design'
 *      and '0.1.0' are the same release), so drift means the CORE versions differ. If
 *      the stripped triple is not all-equal, emit a WARN naming the raw values.
 *      Advisory: non-strict PASS, --strict fail by design.
 *   5. Content drift (EVAL-VER-007, advisory ADR-0007/0008): a shared artifact with
 *      the SAME structural identity whose committed contentHash no longer matches the
 *      fresh scan is an advisory WARN, never an ERROR.
 *
 * Output convention mirrors lint/validate-agents.mjs EXACTLY: findings to STDERR as
 * `LEVEL  path:line  message` (two-space separators); a one-line `validate-registry:
 * … PASS/FAIL` summary to STDOUT. Exit 0 unless an ERROR, or unless `--strict` and any
 * WARN. INFO never affects the exit code.
 *
 * Invocation: node lint/validate-registry.mjs [--strict] [rootDir]
 * Zero dependencies beyond node: builtins + the W1 manager libs (relative imports).
 * Fail-open: any internal failure degrades to a PASS-with-INFO, never a crash.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRegistry } from '../manager/registry.mjs';

// ---- argument parsing ------------------------------------------------------

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const positional = args.filter((a) => !a.startsWith('--'));
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = positional[0] ? path.resolve(positional[0]) : path.resolve(SELF_DIR, '..');

const REGISTRY_PATH = path.join(ROOT, '.forge', 'registry.json');

// ---- finding accumulators (mirror validate-agents.mjs) ---------------------

const errors = [];
const warnings = [];
const infos = [];

function err(loc, msg) { errors.push(`ERROR  ${loc}  ${msg}`); }
function warn(loc, msg) { warnings.push(`WARN   ${loc}  ${msg}`); }
function info(loc, msg) { infos.push(`INFO   ${loc}  ${msg}`); }

// ---- helpers (self-contained, fail-open) -----------------------------------

/** Read + parse a JSON file, returning null on any error (fail-open). */
function readJsonFile(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Read a `version` field from a JSON file (string or null). */
function readJsonVersion(absPath) {
  const doc = readJsonFile(absPath);
  return doc && typeof doc.version === 'string' ? doc.version : null;
}

/** Read the raw VERSION file text, trimmed (or null). */
function readVersionFile(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Strip a trailing `-design` suffix (mirrors bin/forge.mjs#forgeVersion). */
function stripDesign(v) {
  return typeof v === 'string' && v.endsWith('-design') ? v.slice(0, -'-design'.length) : v;
}

/**
 * A record's STRUCTURAL identity — the catalog-shape fields whose change means the
 * registry is structurally stale (a content edit alone does NOT change this). Excludes
 * contentHash/revision/version/timestamps/eval and frontmatter-body fields
 * (description/tags/owner/criticality), which ride on contentHash as content drift.
 */
function structuralKey(a) {
  if (!a || typeof a !== 'object') return '';
  const mods = Array.isArray(a.modules) ? [...a.modules].sort() : [];
  return JSON.stringify({ kind: a.kind, id: a.id, path: a.path, status: a.status, modules: mods });
}

/** Index a registry's artifacts by uid (fail-open to empty map). */
function artifactsByUid(reg) {
  const m = new Map();
  const arr = reg && Array.isArray(reg.artifacts) ? reg.artifacts : [];
  for (const a of arr) {
    if (a && typeof a.uid === 'string') m.set(a.uid, a);
  }
  return m;
}

// ---- checks ----------------------------------------------------------------

/**
 * VERSION triple-drift (EVAL-REG-008). Runs in BOTH the committed and the
 * un-built paths. Strips `-design` before the equality test but names the RAW
 * values in the advisory WARN. Missing sources are reported as `(missing)`.
 */
function checkVersionTriple() {
  const verFileRaw = readVersionFile(path.join(ROOT, 'VERSION'));
  const pkgRaw = readJsonVersion(path.join(ROOT, 'package.json'));
  const pluginRaw = readJsonVersion(path.join(ROOT, '.claude-plugin', 'plugin.json'));

  const verFile = stripDesign(verFileRaw);
  const pkg = stripDesign(pkgRaw);
  const plugin = stripDesign(pluginRaw);

  const allEqual = verFile === pkg && pkg === plugin;
  if (!allEqual) {
    warn(
      'VERSION',
      `version triple drift: VERSION='${verFileRaw ?? '(missing)'}' ` +
        `package.json='${pkgRaw ?? '(missing)'}' ` +
        `.claude-plugin/plugin.json='${pluginRaw ?? '(missing)'}' ` +
        `— align all three`,
    );
  }
}

/**
 * Staleness split by drift KIND (decided model). Fresh-scans the tree (no
 * carry-forward, so current file hashes are visible) and compares to the committed
 * snapshot: a STRUCTURAL change (uid added/removed, or a shared artifact whose
 * structuralKey changed) → stale ERROR (EVAL-REG-002); a CONTENT-only change (same
 * structuralKey, committed contentHash != fresh hash) → advisory WARN (EVAL-VER-007).
 */
function checkCommittedRegistry(committed) {
  let fresh;
  try {
    fresh = buildRegistry(ROOT); // fresh scan, NO carry-forward → current hashes
  } catch {
    // Fail-open: a rebuild failure must not turn into a false ERROR. INFO + return.
    info('.forge/registry.json', 'could not rebuild registry in memory; skipped staleness check');
    return;
  }

  const committedByUid = artifactsByUid(committed);
  const freshByUid = artifactsByUid(fresh);

  // Structural: any uid added or removed.
  let structural = false;
  for (const uid of committedByUid.keys()) if (!freshByUid.has(uid)) structural = true;
  for (const uid of freshByUid.keys()) if (!committedByUid.has(uid)) structural = true;

  // Per shared uid: structural-field change → ERROR; content-only hash change → WARN.
  /** @type {Array<{uid:string, path:string}>} */
  const contentDrift = [];
  for (const [uid, c] of committedByUid) {
    const f = freshByUid.get(uid);
    if (!f) continue;
    if (structuralKey(c) !== structuralKey(f)) {
      structural = true;
      continue;
    }
    const cHash = typeof c.contentHash === 'string' ? c.contentHash : '';
    const fHash = typeof f.contentHash === 'string' ? f.contentHash : '';
    if (cHash && fHash && cHash !== fHash) {
      contentDrift.push({ uid, path: typeof c.path === 'string' && c.path ? c.path : '.forge/registry.json' });
    }
  }

  if (structural) {
    err('.forge/registry.json', 'registry stale, run forge registry build --write');
    return;
  }
  for (const d of contentDrift) {
    warn(d.path, `${d.uid}: content changed but revision not bumped — run forge registry build --write`);
  }
}

/**
 * Dangling references (SPEC-03 / BR-DEP-003), ADDITIVE to the staleness/version logic.
 * A fresh in-memory build carries `danglingRefs[]` — typed edges whose target does not
 * resolve to a known uid (the prose-ref upgrade over validate-xref catches the real
 * `react-reviewer` blind spot). Each entry is reported as a WARN by default and an
 * ERROR under `--strict` (advisory-first, ADR-0007). The finding is line-located at the
 * first site so it is actionable. Fail-open: a rebuild failure simply skips this check.
 *
 * @param {{danglingRefs?: any[]}|null} fresh the fresh in-memory registry build
 */
function checkDanglingRefs(fresh) {
  const refs = fresh && Array.isArray(fresh.danglingRefs) ? fresh.danglingRefs : [];
  for (const d of refs) {
    if (!d || typeof d.rawRef !== 'string') continue;
    const site = Array.isArray(d.sites) && d.sites.length > 0 ? d.sites[0] : null;
    const loc = site && typeof site.path === 'string'
      ? (Number.isInteger(site.line) ? `${site.path}:${site.line}` : site.path)
      : '.forge/registry.json';
    const from = typeof d.from === 'string' ? d.from : '(unknown)';
    const msg = `dangling reference \`${d.rawRef}\` from ${from} does not resolve to a known artifact — run forge registry dangling`;
    if (STRICT) err(loc, msg);
    else warn(loc, msg);
  }
}

// ---- main ------------------------------------------------------------------

function main() {
  // (4) VERSION triple-drift runs unconditionally (committed or not).
  checkVersionTriple();

  const committed = readJsonFile(REGISTRY_PATH);
  if (!committed) {
    // (2) No committed registry: advisory INFO, PASS. Keeps the un-built real repo
    // green. (A present-but-corrupt file also lands here, fail-open.)
    info('.forge/registry.json', 'no committed registry; run forge registry build --write');
  } else {
    // (3) + (5) staleness + bump gate.
    checkCommittedRegistry(committed);
  }

  // (6) Dangling references (SPEC-03 / BR-DEP-003), ADDITIVE — a fresh in-memory build
  // surfaces unresolved typed edges (incl. the real `react-reviewer` prose blind spot).
  // Runs whether or not a registry is committed; fail-open on a rebuild failure.
  try {
    const fresh = buildRegistry(ROOT);
    checkDanglingRefs(fresh);
  } catch {
    /* fail-open: a rebuild failure must not turn into a false ERROR */
  }

  // Emit findings: STDERR for findings, STDOUT for the summary (mirror siblings).
  for (const line of infos) console.error(line);
  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `validate-registry: ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info — ${failed ? 'FAIL' : 'PASS'}`,
  );
  process.exit(failed ? 1 : 0);
}

try {
  main();
} catch (e) {
  // Fail-open at the outermost boundary: never crash the aggregate run-all.
  console.error(`INFO   .forge/registry.json  validate-registry internal error (fail-open): ${e && e.message ? e.message : String(e)}`);
  console.log('validate-registry: 0 error(s), 0 warning(s), 1 info — PASS');
  process.exit(0);
}
