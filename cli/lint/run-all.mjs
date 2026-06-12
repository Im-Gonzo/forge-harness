#!/usr/bin/env node
/**
 * run-all — the Forge self-validation runner the CLI (bin/forge.mjs validate) calls.
 *
 * Discovers and runs EVERY sibling validator in lint/ matching `validate-*.mjs` or
 * `check-*.mjs` as child processes (node:child_process spawnSync), passing through
 * `--strict` and an optional rootDir. Aggregates each validator's pass/fail, prints a
 * final summary, and exits 1 if any validator failed.
 *
 * ROBUST: validators are written in parallel by separate agents; a sibling file may
 * not exist yet, or a runner pattern may match no files. Both cases are handled
 * gracefully (skip with a note) rather than crashing. run-all NEVER includes itself.
 *
 * Usage:
 *   node lint/run-all.mjs [--strict] [rootDir]
 *
 * Zero dependencies. Self-contained.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseFindings } from '../manager/lib/findings.mjs';
import { envelope } from '../manager/lib/json-out.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const JSON_MODE = argv.includes('--json');
const positional = argv.filter((a) => !a.startsWith('--'));
const ROOT = positional.length > 0 ? path.resolve(positional[0]) : DEFAULT_ROOT;

/** The raw Forge VERSION string (stamped as envelope.forge); fail-open to ''. */
function rawForgeVersion() {
  try {
    return fs.readFileSync(path.join(DEFAULT_ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '';
  }
}

const SELF = path.basename(fileURLToPath(import.meta.url)); // run-all.mjs

// Patterns a validator file must match to be auto-discovered.
function isValidatorFile(name) {
  if (name === SELF) return false;
  if (!name.endsWith('.mjs')) return false;
  return name.startsWith('validate-') || name.startsWith('check-');
}

/**
 * The lint dir to discover validators from. By default this is run-all's OWN
 * directory (forge/lint) — so the no-arg / forge-self case is byte-identical to
 * before. When an EXPLICIT external rootDir is given AND it carries its own
 * `<root>/lint/` directory containing validator files (e.g. the EVAL-CLI-001
 * fixture tree), discover from there instead, so `run-all.mjs <root>` runs that
 * tree's validators. A root without a populated `lint/` falls back to SCRIPT_DIR,
 * preserving the legacy "run forge's validators against <dir>" behavior.
 */
function resolveLintDir() {
  if (ROOT === DEFAULT_ROOT) return SCRIPT_DIR;
  const candidate = path.join(ROOT, 'lint');
  try {
    const hasValidators = fs.readdirSync(candidate).some(isValidatorFile);
    if (hasValidators) return candidate;
  } catch {
    /* no <root>/lint — fall back */
  }
  return SCRIPT_DIR;
}

const LINT_DIR = resolveLintDir();

function discoverValidators() {
  let entries;
  try {
    entries = fs.readdirSync(LINT_DIR);
  } catch (e) {
    console.error(`run-all: cannot read lint dir ${LINT_DIR}: ${e.message}`);
    return [];
  }
  return entries.filter(isValidatorFile).sort();
}

function runValidator(file) {
  const abs = path.join(LINT_DIR, file);

  // Defensive: file vanished between discovery and run (parallel agents).
  if (!fs.existsSync(abs)) {
    return { file, status: 'skipped', reason: 'file not found (sibling may not be built yet)' };
  }

  const args = [abs];
  if (STRICT) args.push('--strict');
  // Pass the explicit rootDir so child validators target the same repo.
  args.push(ROOT);

  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });

  if (res.error) {
    return { file, status: 'errored', reason: res.error.message, stdout: '', stderr: '' };
  }

  return {
    file,
    status: res.status === 0 ? 'passed' : 'failed',
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

/**
 * Synthesize the C3 `--json` envelope (ADR-0004, SPEC-09) by parsing each child's
 * captured stdout+stderr into C2 findings. The child validators are UNCHANGED: the
 * parent owns the machine layer. `findings` aggregates across all children;
 * `data.validators` carries the per-child run status; `ok` is errors===0 AND no
 * failed/errored child. Prints exactly ONE envelope to stdout and suppresses the
 * human banner/echo. Exit code is decided by the shared logic in main().
 *
 * @param {Array} results The per-child run records from runValidator.
 * @returns {object} The C3 envelope.
 */
function buildEnvelope(results) {
  const findings = [];
  const validators = [];
  for (const r of results) {
    validators.push({
      file: r.file,
      status: r.status,
      code: typeof r.code === 'number' ? r.code : null,
    });
    if (r.status === 'skipped') continue;
    // Concatenate BOTH streams: findings print to stderr, the summary to stdout
    // (SPEC-09 §streams). Non-matching lines (banner/summary) are dropped.
    const combined = (r.stdout || '') + (r.stderr || '');
    for (const f of parseFindings(combined, r.file)) findings.push(f);
  }

  const errors = findings.filter((f) => f.level === 'ERROR').length;
  const warnings = findings.filter((f) => f.level === 'WARN').length;
  const info = findings.filter((f) => f.level === 'INFO').length;
  const passedCount = results.filter((r) => r.status === 'passed').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;
  const erroredCount = results.filter((r) => r.status === 'errored').length;

  // `ok` (C3, ADR-0004) = summary.errors === 0 AND no failed/errored child. The
  // `--strict` dial promotes advisory WARNs to fail the *exit code* (via the
  // children / the exit logic in main), NOT the computed `ok` — a WARN-only tree
  // is `ok:true` (EVAL-CLI-002), strict or not.
  const ok = errors === 0 && failedCount === 0 && erroredCount === 0;

  return envelope({
    command: 'validate',
    ok,
    data: { validators },
    findings,
    summary: { errors, warnings, info, passed: passedCount, failed: failedCount + erroredCount },
    forgeVersion: rawForgeVersion(),
  });
}

function main() {
  const validators = discoverValidators();

  if (!JSON_MODE) {
    console.log('================================================================');
    console.log(`Forge self-validation — run-all${STRICT ? ' (--strict)' : ''}`);
    console.log(`  repo root : ${ROOT}`);
    console.log(`  validators: ${validators.length} discovered`);
    console.log('================================================================\n');
  }

  if (validators.length === 0) {
    if (JSON_MODE) {
      process.stdout.write(JSON.stringify(buildEnvelope([])) + '\n');
      process.exit(0);
    }
    console.log('run-all: no validators discovered (lint/ has no validate-*/check-* files).');
    console.log('run-all: PASS (nothing to run)');
    process.exit(0);
  }

  const results = [];
  for (const file of validators) {
    if (!JSON_MODE) console.log(`---- ${file} ----`);
    const r = runValidator(file);
    results.push(r);

    if (JSON_MODE) continue; // No human echo under --json.

    if (r.status === 'skipped') {
      console.log(`SKIP ${file}: ${r.reason}\n`);
      continue;
    }
    if (r.status === 'errored') {
      console.log(`ERROR ${file}: failed to execute: ${r.reason}\n`);
      continue;
    }

    // Echo the child's own output so the aggregate run is self-explanatory.
    if (r.stdout.trim()) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n');
    if (r.stderr.trim()) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n');
    console.log('');
  }

  // ---- Aggregate summary ----
  const passed = results.filter((r) => r.status === 'passed');
  const failed = results.filter((r) => r.status === 'failed');
  const errored = results.filter((r) => r.status === 'errored');
  const skipped = results.filter((r) => r.status === 'skipped');

  // The `--strict` dial (ADR-0007, SPEC-08 §strict, EVAL-CLI-008): advisory WARN
  // findings count toward the EXIT CODE (not the computed `ok`). A child validator
  // may keep its own WARNs at exit 0 (e.g. the frozen EVAL-CLI-001 fixture, or the
  // unicode "allowed; flagged" symbols), so the dial is enforced HERE at the
  // aggregator: under --strict, any aggregated WARN makes the run exit non-zero.
  const strictWarn = STRICT && aggregateWarnCount(results) > 0;

  // Under --json: emit exactly one C3 envelope, suppress the human summary, but
  // keep the EXACT SAME exit semantics as the human path (a failed/errored child
  // fails the run; under --strict an advisory WARN also fails the EXIT, never `ok`).
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(buildEnvelope(results)) + '\n');
    if (failed.length > 0 || errored.length > 0 || strictWarn) process.exit(1);
    process.exit(0);
  }

  console.log('================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  for (const r of results) {
    const tag =
      r.status === 'passed'
        ? 'PASS'
        : r.status === 'failed'
        ? 'FAIL'
        : r.status === 'errored'
        ? 'ERR '
        : 'SKIP';
    const extra =
      r.status === 'failed'
        ? ` (exit ${r.code})`
        : r.status === 'skipped' || r.status === 'errored'
        ? ` — ${r.reason}`
        : '';
    console.log(`  ${tag}  ${r.file}${extra}`);
  }
  console.log('----------------------------------------------------------------');
  console.log(
    `  ${passed.length} passed, ${failed.length} failed, ${errored.length} errored, ${skipped.length} skipped`
  );
  console.log('================================================================');

  // A failed OR errored validator fails the run. Skipped (not-yet-built) does not.
  // Under --strict, an aggregated advisory WARN also fails the run (the dial).
  if (failed.length > 0 || errored.length > 0 || strictWarn) {
    if (strictWarn && failed.length === 0 && errored.length === 0) {
      console.log(`  (--strict) ${aggregateWarnCount(results)} advisory WARN(s) promoted to failures.`);
    }
    console.log('run-all: FAIL');
    process.exit(1);
  }
  console.log('run-all: PASS');
  process.exit(0);
}

/**
 * Count advisory WARN findings across all children by parsing each child's combined
 * stdout+stderr (the same parse the JSON envelope uses, so the human and --json paths
 * agree on the strict-dial decision). Self-contained; fail-open to 0.
 * @param {Array} results The per-child run records.
 * @returns {number}
 */
function aggregateWarnCount(results) {
  let warnings = 0;
  for (const r of results) {
    if (!r || r.status === 'skipped') continue;
    const combined = (r.stdout || '') + (r.stderr || '');
    for (const f of parseFindings(combined, r.file)) {
      if (f && f.level === 'WARN') warnings++;
    }
  }
  return warnings;
}

main();
