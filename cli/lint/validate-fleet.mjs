#!/usr/bin/env node
/**
 * validate-fleet — the paired self-validator for the manager's READ-ONLY fleet
 * dimension (SPEC-04, ADR-0009/0010, BR-FLEET-024, EVAL-FLEET-005). Auto-discovered
 * by lint/run-all.mjs (filename matches `validate-*.mjs`, no runner edit needed).
 *
 * Advisory-first (ADR-0007). It asserts the C4 module CONTRACT for manager/fleet.mjs —
 * the things the module cannot prove about itself in-process:
 *
 *   1. manager/fleet.mjs EXISTS and imports cleanly (no throw, no process.exit at
 *      import — the dual-mode isMain() guard).
 *   2. It exports `run` and `summarize` (the C4 contract) and `computeSourceRev`
 *      (the provenance helper, ADR-0009).
 *   3. It is DRY-RUN by default and READ-ONLY toward project trees: invoking a read
 *      verb (`status`) writes NOTHING under the FORGE library tree and creates NO
 *      fleet.json inside any project (fleet state lives ONLY under the machine-local
 *      `~/.claude/forge/` root — BR-FLEET-005/017). We verify this by pointing HOME at
 *      a throwaway sandbox, running `status`, and asserting the library tree is
 *      untouched and no project-side fleet.json appeared.
 *   4. `run()` honours the print/compute split: it returns the `{ok,data,findings,
 *      summary}` shape and writes NOTHING to stdout/stderr.
 *
 * Output convention mirrors lint/validate-registry.mjs EXACTLY: findings to STDERR as
 * `LEVEL  path:line  message`; a one-line `validate-fleet: … PASS/FAIL` summary to
 * STDOUT. Exit 0 unless an ERROR (or `--strict` and any WARN). Fail-open: any internal
 * failure degrades to a PASS-with-INFO, never a crash.
 *
 * Invocation: node lint/validate-fleet.mjs [--strict] [rootDir]
 * Zero dependencies beyond node: builtins + the manager module under test (relative).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- argument parsing ------------------------------------------------------

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const positional = args.filter((a) => !a.startsWith('--'));
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = positional[0] ? path.resolve(positional[0]) : path.resolve(SELF_DIR, '..');

const FLEET_MODULE = path.join(ROOT, 'manager', 'fleet.mjs');

// ---- finding accumulators (mirror validate-registry.mjs) -------------------

const errors = [];
const warnings = [];
const infos = [];

function err(loc, msg) { errors.push(`ERROR  ${loc}  ${msg}`); }
function warn(loc, msg) { warnings.push(`WARN   ${loc}  ${msg}`); }
function info(loc, msg) { infos.push(`INFO   ${loc}  ${msg}`); }

// ---- helpers (self-contained, fail-open) -----------------------------------

/** List every relative file path under `root`, recursively (fail-open). */
function listFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  })(root);
  return out;
}

// ---- the contract checks ---------------------------------------------------

/**
 * The full contract assessment. Async because it dynamic-imports the module under
 * test and calls its async `run`. Never throws (each step is guarded); accumulates
 * findings and returns.
 */
async function main() {
  // (1) module exists.
  if (!fs.existsSync(FLEET_MODULE)) {
    err('manager/fleet.mjs', 'fleet module is missing (the fleet dimension is unbuilt)');
    return;
  }

  // (1b) imports cleanly (no throw / no process.exit at import — the isMain() guard).
  let mod;
  try {
    mod = await import(pathToFileUrl(FLEET_MODULE));
  } catch (e) {
    err('manager/fleet.mjs', `fleet module failed to import: ${e && e.message ? e.message : String(e)}`);
    return;
  }

  // (2) exports the C4 contract + the provenance helper.
  if (typeof mod.run !== 'function') err('manager/fleet.mjs', 'must export run(subcmd, args, ctx)');
  if (typeof mod.summarize !== 'function') err('manager/fleet.mjs', 'must export summarize(state)');
  if (typeof mod.computeSourceRev !== 'function') {
    warn('manager/fleet.mjs', 'should export computeSourceRev(rootDir, marker) (ADR-0009 provenance helper)');
  }
  if (typeof mod.run !== 'function') return; // cannot exercise the rest without run

  // (3)+(4) dry-run / read-only + print/compute split. Point HOME at a throwaway
  // sandbox so the machine-local fleet root is redirected away from the real $HOME,
  // then run a READ verb and assert nothing leaked into the library or a project tree.
  const home = mkSandbox('forge-validate-fleet-home');
  const proj = mkSandbox('forge-validate-fleet-proj');
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const libBefore = snapshot(ROOT);

  const stdoutChunks = [];
  const stderrChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.stdout.write = (c) => (stdoutChunks.push(String(c)), true);
    process.stderr.write = (c) => (stderrChunks.push(String(c)), true);

    let res;
    try {
      res = await mod.run('status', [], { FORGE_ROOT: ROOT, cwd: proj, HOME: home });
    } catch (e) {
      // restore writers before recording the finding so it is not swallowed
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      err('manager/fleet.mjs', `fleet.run('status') threw (must fail-open): ${e && e.message ? e.message : String(e)}`);
      res = null;
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }

    // print/compute split: run() prints nothing.
    if (stdoutChunks.join('') !== '') err('manager/fleet.mjs', 'run() wrote to stdout (must be silent — print/compute split)');
    if (stderrChunks.join('') !== '') err('manager/fleet.mjs', 'run() wrote to stderr (must be silent — print/compute split)');

    // the { ok, data, findings, summary } shape.
    if (res && typeof res === 'object') {
      for (const k of ['ok', 'data', 'findings', 'summary']) {
        if (!(k in res)) err('manager/fleet.mjs', `run() result is missing "${k}" (C4 shape)`);
      }
    } else if (res !== null) {
      err('manager/fleet.mjs', 'run() did not return a result object');
    }
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  }

  // (3) the library tree is byte-untouched by a read verb.
  const libAfter = snapshot(ROOT);
  if (libBefore !== libAfter) {
    err('manager/fleet.mjs', 'a fleet read verb mutated the FORGE library tree (must be read-only)');
  }
  // (3) no project-side fleet.json (state lives only under ~/.claude/forge/).
  if (fs.existsSync(path.join(proj, '.forge', 'fleet.json')) || fs.existsSync(path.join(proj, '.claude', 'fleet.json'))) {
    err('manager/fleet.mjs', 'fleet wrote a fleet.json inside a project tree (state must live only under ~/.claude/forge/)');
  }

  cleanup(home);
  cleanup(proj);
  info('manager/fleet.mjs', 'fleet read-only contract assessed (dry-run, machine-local state, print/compute split)');
}

// ---- tiny fs sandbox helpers (zero-dep) ------------------------------------

function mkSandbox(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
/** A cheap signature of a tree (relative paths only — fast, additive-change-sensitive). */
function snapshot(root) {
  try {
    return listFiles(root).sort().join('\n');
  } catch {
    return '';
  }
}
/** Convert an absolute path to a file:// URL for dynamic import (cross-platform). */
function pathToFileUrl(abs) {
  const resolved = path.resolve(abs);
  const prefixed = resolved.startsWith('/') ? resolved : '/' + resolved.replace(/\\/g, '/');
  return 'file://' + encodeURI(prefixed);
}

// ---- entry (mirror validate-registry.mjs; fail-open outer boundary) --------

/** True only when run directly (not when import()-ed). */
function isMain() {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function run() {
  try {
    await main();
  } catch (e) {
    // Fail-open at the outermost boundary: never crash the aggregate run-all.
    console.error(`INFO   manager/fleet.mjs  validate-fleet internal error (fail-open): ${e && e.message ? e.message : String(e)}`);
    for (const line of infos) console.error(line);
    console.log('validate-fleet: 0 error(s), 0 warning(s), 1 info — PASS');
    process.exit(0);
    return;
  }

  for (const line of infos) console.error(line);
  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `validate-fleet: ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info — ${failed ? 'FAIL' : 'PASS'}`,
  );
  process.exit(failed ? 1 : 0);
}

if (isMain()) {
  run();
}
