#!/usr/bin/env node
/**
 * store — the storage seam holds its two HARD invariants (SPEC-09, EVAL-INT-003/006).
 *
 * Behavioral contract asserted here:
 *   - readJson / writeJsonAtomic round-trip; write creates parent dirs and
 *     returns true; a crash mid-write leaves the PRIOR file intact (atomicity).
 *   - readJson on a missing/malformed file is null (fail-open).
 *   - appendJsonl + readJsonl round-trip; readJsonl skips malformed lines;
 *     a held .lock DROPS the append and returns false (lossy-by-design), and
 *     the lock is released so the next append succeeds.
 *   - forgeStateDir / machineStateHome resolve under the two roots; stamping
 *     is non-destructive and clones.
 *
 * Zero deps. node:assert. Exit 1 on any failure. Uses a temp dir, cleaned up.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const STORE = path.join(FORGE_ROOT, 'manager', 'lib', 'store.mjs');

const {
  readJson,
  writeJsonAtomic,
  appendJsonl,
  readJsonl,
  forgeStateDir,
  machineStateHome,
  stampSchemaVersion,
} = await import(STORE);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-store-test-'));
let failed = 0;
/** @param {string} name @param {() => void} fn */
function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (e) {
    failed++;
    process.stdout.write(`  FAIL  ${name}: ${e && e.message}\n`);
  }
}

// --- readJson / writeJsonAtomic ------------------------------------------
test('writeJsonAtomic round-trips and creates parent dirs', () => {
  const p = path.join(TMP, 'nested', 'deep', 'snap.json');
  assert.strictEqual(writeJsonAtomic(p, { a: 1, b: 'x' }), true);
  assert.deepStrictEqual(readJson(p), { a: 1, b: 'x' });
  assert.ok(fs.readFileSync(p, 'utf8').endsWith('\n'), 'trailing newline');
});

test('readJson is null for missing file (fail-open)', () => {
  assert.strictEqual(readJson(path.join(TMP, 'does-not-exist.json')), null);
});

test('readJson is null for malformed JSON (fail-open)', () => {
  const p = path.join(TMP, 'bad.json');
  fs.writeFileSync(p, '{ not json', 'utf8');
  assert.strictEqual(readJson(p), null);
});

test('writeJsonAtomic leaves prior file intact on serialize failure', () => {
  const p = path.join(TMP, 'snap2.json');
  assert.strictEqual(writeJsonAtomic(p, { ok: true }), true);
  const circular = {};
  circular.self = circular; // JSON.stringify throws
  assert.strictEqual(writeJsonAtomic(p, circular), false);
  assert.deepStrictEqual(readJson(p), { ok: true }, 'prior content preserved');
  // No orphaned temp siblings left behind.
  const orphans = fs.readdirSync(TMP).filter((n) => n.includes('snap2.json') && n.endsWith('.tmp'));
  assert.strictEqual(orphans.length, 0, 'temp cleaned up');
});

// --- appendJsonl / readJsonl ---------------------------------------------
test('appendJsonl + readJsonl round-trip', () => {
  const p = path.join(TMP, 'log', 'events.jsonl');
  assert.strictEqual(appendJsonl(p, { i: 1 }), true);
  assert.strictEqual(appendJsonl(p, { i: 2 }), true);
  assert.deepStrictEqual(readJsonl(p), [{ i: 1 }, { i: 2 }]);
});

test('readJsonl skips malformed lines (fail-open)', () => {
  const p = path.join(TMP, 'mixed.jsonl');
  fs.writeFileSync(p, '{"a":1}\nGARBAGE\n\n{"b":2}\n', 'utf8');
  assert.deepStrictEqual(readJsonl(p), [{ a: 1 }, { b: 2 }]);
});

test('readJsonl is [] for missing file (fail-open)', () => {
  assert.deepStrictEqual(readJsonl(path.join(TMP, 'no-log.jsonl')), []);
});

test('appendJsonl drops when .lock is held, then succeeds once released', () => {
  const p = path.join(TMP, 'contended.jsonl');
  assert.strictEqual(appendJsonl(p, { first: true }), true);
  const lock = p + '.lock';
  fs.writeFileSync(lock, '', { flag: 'wx' }); // simulate a held lock
  assert.strictEqual(appendJsonl(p, { dropped: true }), false, 'contended ⇒ dropped');
  fs.rmSync(lock, { force: true }); // release
  assert.strictEqual(appendJsonl(p, { second: true }), true);
  assert.deepStrictEqual(readJsonl(p), [{ first: true }, { second: true }]);
  assert.ok(!fs.existsSync(lock), 'lock released after successful append');
});

// --- root resolution ------------------------------------------------------
test('forgeStateDir is <forgeRoot>/.forge', () => {
  assert.strictEqual(forgeStateDir('/x/forge'), path.join('/x/forge', '.forge'));
});

test('machineStateHome resolves under ~/.claude/forge', () => {
  const prev = process.env.HOME;
  process.env.HOME = '/tmp/forge-test-home';
  try {
    assert.strictEqual(machineStateHome(), path.join('/tmp/forge-test-home', '.claude', 'forge'));
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
});

// --- schema stamping ------------------------------------------------------
test('stampSchemaVersion clones and is non-destructive', () => {
  const src = { a: 1 };
  const out = stampSchemaVersion(src, 'forge.x.v1');
  assert.deepStrictEqual(out, { a: 1, schemaVersion: 'forge.x.v1' });
  assert.notStrictEqual(out, src, 'returns a clone');
  assert.ok(!('schemaVersion' in src), 'input not mutated');
});

test('stampSchemaVersion returns non-objects unchanged (fail-open)', () => {
  assert.strictEqual(stampSchemaVersion(null, 'v'), null);
  assert.strictEqual(stampSchemaVersion(5, 'v'), 5);
});

// --- teardown -------------------------------------------------------------
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ignore */
}

if (failed > 0) {
  process.stdout.write(`store: ${failed} assertion group(s) FAILED\n`);
  process.exit(1);
}
process.stdout.write('store: all assertions passed\n');
