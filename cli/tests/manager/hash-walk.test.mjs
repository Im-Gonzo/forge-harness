#!/usr/bin/env node
// @ts-check
/**
 * hash-walk — behavioral contract for manager/lib/hash.mjs + walk.mjs (SPEC-00, SPEC-01).
 *
 * Asserts:
 *   hash — sha256hex matches bin/forge.mjs's definition for a UTF-8 string, accepts a
 *          Buffer, is stable/lowercase-hex, and never throws on odd input (fail-open).
 *   walk — walkLibrary returns sorted {absPath, relPath} records under the scan surface,
 *          is deterministic across runs, prunes node_modules/.git/.claude/.forge, omits
 *          hooks/ (not a scan dir), and fails open to [] on a bad root.
 *
 * Zero deps. node:assert. Exit 1 on any failure.
 */

import assert from 'node:assert';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { sha256hex } from '../../manager/lib/hash.mjs';
import { walkLibrary } from '../../manager/lib/walk.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

// --- hash -------------------------------------------------------------------
const ref = createHash('sha256').update('forge', 'utf8').digest('hex');
assert.strictEqual(sha256hex('forge'), ref, 'string hash must match forge.mjs definition');
assert.strictEqual(sha256hex('forge'), sha256hex(Buffer.from('forge', 'utf8')), 'string and equivalent Buffer hash identically');
assert.match(sha256hex('x'), /^[0-9a-f]{64}$/, 'lowercase 64-hex digest');
assert.strictEqual(sha256hex(''), createHash('sha256').update('', 'utf8').digest('hex'), 'empty string hashes');
assert.doesNotThrow(() => sha256hex(/** @type {any} */ (123)), 'fail-open on non-string/non-buffer input');

// --- walk -------------------------------------------------------------------
const records = walkLibrary(FORGE_ROOT);
assert.ok(Array.isArray(records) && records.length > 0, 'walkLibrary returns a non-empty array on the real tree');
for (const r of records) {
  assert.ok(typeof r.absPath === 'string' && path.isAbsolute(r.absPath), 'each record has an absolute absPath');
  assert.ok(typeof r.relPath === 'string' && !r.relPath.includes('\\'), 'relPath is POSIX-style');
  assert.ok(!path.isAbsolute(r.relPath), 'relPath is relative');
}

// deterministic + sorted
const rels = records.map((r) => r.relPath);
const sorted = [...rels].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
assert.deepStrictEqual(rels, sorted, 'records are sorted by relPath');
assert.deepStrictEqual(rels, walkLibrary(FORGE_ROOT).map((r) => r.relPath), 'walk is deterministic across runs');
assert.strictEqual(new Set(rels).size, rels.length, 'no duplicate relPaths');

// scan-surface coverage + exclusions
const top = new Set(rels.map((p) => p.split('/')[0]));
assert.ok(top.has('agents') && top.has('skills') && top.has('lint') && top.has('bootstrap'), 'covers core scan dirs');
assert.ok(rels.some((p) => p.startsWith('rules/')), 'rules walked recursively (nested subdirs)');
assert.ok(rels.some((p) => p.startsWith('tests/meta/')), 'tests/meta included');
assert.ok(!rels.some((p) => p.startsWith('hooks/')), 'hooks/ NOT a scan dir (resolved via hooks.json)');
assert.ok(!rels.some((p) => p.split('/').some((seg) => ['node_modules', '.git', '.claude', '.forge'].includes(seg))), 'skip dirs pruned');

// fail-open
assert.deepStrictEqual(walkLibrary(path.join(FORGE_ROOT, 'does-not-exist-xyz')), [], 'missing root → []');
assert.deepStrictEqual(walkLibrary(/** @type {any} */ (null)), [], 'bad root → [] (fail-open)');

console.log(`PASS hash-walk (${records.length} files on scan surface)`);
