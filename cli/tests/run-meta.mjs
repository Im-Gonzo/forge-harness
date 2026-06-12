#!/usr/bin/env node
/**
 * run-meta — the Forge behavioral meta-test runner.
 *
 * Discovers and runs EVERY `tests/meta/*.mjs` as a child process. Each meta-test
 * is a plain `node:assert` script that asserts a behavioral / governance contract
 * holds against Forge's shipped assets (agents, skills, rules) — e.g. that every
 * reviewer agent still contains its anti-noise scaffolding. A failing meta-test
 * means a prompt regression: load-bearing governance prose was weakened or dropped.
 *
 * These are SEPARATE from `lint/run-all.mjs` (which lints asset *shape*); meta-tests
 * assert asset *behavior/content*. CI runs both.
 *
 * Mirrors run-all's style: prints PASS/FAIL per test, a final summary, and exits 1
 * if any meta-test failed. Robust to a missing tests/meta dir (skips cleanly).
 *
 * Usage:
 *   node tests/run-meta.mjs
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
const META_DIR = path.join(SCRIPT_DIR, 'meta');
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..');

const argv = process.argv.slice(2);
const JSON_MODE = argv.includes('--json');

/** The raw Forge VERSION string (stamped as envelope.forge); fail-open to ''. */
function rawForgeVersion() {
  try {
    return fs.readFileSync(path.join(FORGE_ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '';
  }
}

function discoverMetaTests() {
  let entries;
  try {
    entries = fs.readdirSync(META_DIR);
  } catch {
    return [];
  }
  return entries.filter((n) => n.endsWith('.mjs')).sort();
}

function runMetaTest(file) {
  const abs = path.join(META_DIR, file);
  if (!fs.existsSync(abs)) {
    return { file, status: 'skipped', reason: 'file not found' };
  }
  const res = spawnSync(process.execPath, [abs], {
    cwd: SCRIPT_DIR,
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
 * Synthesize the C3 `--json` envelope (ADR-0004, SPEC-09) for the meta runner by
 * parsing each meta-test's captured stdout+stderr into C2 findings. The meta-tests
 * are UNCHANGED. `findings` aggregates across all tests; `data.tests` carries the
 * per-test run status; `ok` is errors===0 AND no failed/errored test. Command is
 * "meta". Prints exactly ONE envelope and suppresses the human banner/echo.
 *
 * @param {Array} results The per-test run records from runMetaTest.
 * @returns {object} The C3 envelope.
 */
function buildEnvelope(results) {
  const findings = [];
  const tests = [];
  for (const r of results) {
    tests.push({
      file: r.file,
      status: r.status,
      code: typeof r.code === 'number' ? r.code : null,
    });
    if (r.status === 'skipped') continue;
    // Concatenate BOTH streams (SPEC-09 §streams): findings to stderr, summary to
    // stdout. Non-matching lines (banner/summary/assert noise) are dropped.
    const combined = (r.stdout || '') + (r.stderr || '');
    for (const f of parseFindings(combined, r.file)) findings.push(f);
  }

  const errors = findings.filter((f) => f.level === 'ERROR').length;
  const warnings = findings.filter((f) => f.level === 'WARN').length;
  const info = findings.filter((f) => f.level === 'INFO').length;
  const passedCount = results.filter((r) => r.status === 'passed').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;
  const erroredCount = results.filter((r) => r.status === 'errored').length;

  // `ok` (C3, ADR-0004) = errors === 0 AND no failed/errored test; --strict
  // affects the exit code, not the computed `ok`.
  const ok = errors === 0 && failedCount === 0 && erroredCount === 0;

  return envelope({
    command: 'meta',
    ok,
    data: { tests },
    findings,
    summary: { errors, warnings, info, passed: passedCount, failed: failedCount + erroredCount },
    forgeVersion: rawForgeVersion(),
  });
}

function main() {
  const tests = discoverMetaTests();

  if (!JSON_MODE) {
    console.log('================================================================');
    console.log('Forge behavioral meta-tests — run-meta');
    console.log(`  tests dir : ${META_DIR}`);
    console.log(`  meta-tests: ${tests.length} discovered`);
    console.log('================================================================\n');
  }

  if (tests.length === 0) {
    if (JSON_MODE) {
      process.stdout.write(JSON.stringify(buildEnvelope([])) + '\n');
      process.exit(0);
    }
    console.log('run-meta: no meta-tests discovered (tests/meta/ has no *.mjs files).');
    console.log('run-meta: PASS (nothing to run)');
    process.exit(0);
  }

  const results = [];
  for (const file of tests) {
    if (!JSON_MODE) console.log(`---- ${file} ----`);
    const r = runMetaTest(file);
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
    if (r.stdout.trim()) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n');
    if (r.stderr.trim()) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n');
    console.log('');
  }

  const passed = results.filter((r) => r.status === 'passed');
  const failed = results.filter((r) => r.status === 'failed');
  const errored = results.filter((r) => r.status === 'errored');
  const skipped = results.filter((r) => r.status === 'skipped');

  // Under --json: emit exactly one C3 envelope, suppress the human summary, keep
  // the EXACT SAME exit semantics (a failed/errored test fails the run).
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(buildEnvelope(results)) + '\n');
    if (failed.length > 0 || errored.length > 0) process.exit(1);
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

  if (failed.length > 0 || errored.length > 0) {
    console.log('run-meta: FAIL');
    process.exit(1);
  }
  console.log('run-meta: PASS');
  process.exit(0);
}

main();
