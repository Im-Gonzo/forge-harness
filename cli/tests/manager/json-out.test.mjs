#!/usr/bin/env node
/**
 * json-out — unit tests for manager/lib/json-out.mjs (the C3 `--json` envelope,
 * ADR-0004 / SPEC-09).
 *
 * Asserts: envelope() returns the exact C3 field set; `forge` is the passed
 * forgeVersion; `ts` is a valid ISO-8601 string; `ok` is the passed flag (never
 * re-asserted); `summary` is derived by level-count when omitted but passed
 * through verbatim when supplied; everything fails open on bad input.
 *
 * Zero deps. node:assert. Exit 1 on any failure.
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(SCRIPT_DIR, '..', '..', 'manager', 'lib', 'json-out.mjs');
const { envelope, summarizeFindings } = await import(LIB);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

const F = (level) => ({ level, path: 'a.md', line: null, message: 'm', source: 's' });

console.log('\n=== json-out: C3 --json envelope ===\n');

test('envelope returns exactly the C3 field set', () => {
  const e = envelope({ command: 'validate', ok: true, data: { x: 1 }, findings: [], forgeVersion: '0.1.0-design' });
  assert.deepStrictEqual(
    Object.keys(e).sort(),
    ['command', 'data', 'findings', 'forge', 'ok', 'summary', 'ts']
  );
});

test('envelope stamps `forge` from forgeVersion', () => {
  assert.strictEqual(envelope({ forgeVersion: '0.1.0-design' }).forge, '0.1.0-design');
  assert.strictEqual(envelope({}).forge, ''); // fail-open default
});

test('envelope passes command and ok through verbatim', () => {
  const e = envelope({ command: 'registry', ok: true, forgeVersion: 'v' });
  assert.strictEqual(e.command, 'registry');
  assert.strictEqual(e.ok, true);
});

test('envelope `ok` is strictly the passed boolean (never re-asserted)', () => {
  // ok must reflect the caller's computed value even when findings contain ERRORs.
  const e = envelope({ ok: true, findings: [F('ERROR')], forgeVersion: 'v' });
  assert.strictEqual(e.ok, true);
  assert.strictEqual(envelope({ ok: false }).ok, false);
  assert.strictEqual(envelope({}).ok, false); // default
  assert.strictEqual(envelope({ ok: 'truthy' }).ok, false); // only `true` counts
});

test('envelope `ts` is a valid round-trippable ISO-8601 string', () => {
  const e = envelope({ forgeVersion: 'v' });
  assert.strictEqual(typeof e.ts, 'string');
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.ts), `ts not ISO-8601: ${e.ts}`);
  assert.strictEqual(new Date(e.ts).toISOString(), e.ts);
});

test('envelope `data` defaults to null and preserves falsy payloads', () => {
  assert.strictEqual(envelope({}).data, null);
  assert.strictEqual(envelope({ data: 0 }).data, 0);
  assert.strictEqual(envelope({ data: false }).data, false);
  assert.deepStrictEqual(envelope({ data: { a: 1 } }).data, { a: 1 });
});

test('envelope `findings` defaults to [] and passes an array through', () => {
  assert.deepStrictEqual(envelope({}).findings, []);
  const fs = [F('WARN')];
  assert.strictEqual(envelope({ findings: fs }).findings, fs);
  assert.deepStrictEqual(envelope({ findings: 'bad' }).findings, []); // fail-open
});

test('envelope derives summary by level-count when omitted', () => {
  const e = envelope({
    findings: [F('ERROR'), F('ERROR'), F('WARN'), F('INFO')],
    forgeVersion: 'v',
  });
  assert.deepStrictEqual(e.summary, { errors: 2, warnings: 1, info: 1 });
});

test('envelope derives a zeroed summary for no findings', () => {
  assert.deepStrictEqual(envelope({}).summary, { errors: 0, warnings: 0, info: 0 });
});

test('envelope passes a supplied summary through verbatim (allows extra counts)', () => {
  const summary = { errors: 0, warnings: 0, info: 0, artifacts: 7 };
  const e = envelope({ summary, findings: [F('ERROR')], forgeVersion: 'v' });
  assert.strictEqual(e.summary, summary); // not recomputed
  assert.strictEqual(e.summary.artifacts, 7);
});

test('envelope never throws on undefined/garbage args (fail-open)', () => {
  assert.doesNotThrow(() => envelope());
  assert.doesNotThrow(() => envelope(undefined));
});

// ---- summarizeFindings -----------------------------------------------------

test('summarizeFindings counts by level and ignores unknown levels', () => {
  assert.deepStrictEqual(
    summarizeFindings([F('ERROR'), F('WARN'), F('INFO'), { level: 'BOGUS' }, null]),
    { errors: 1, warnings: 1, info: 1 }
  );
});

test('summarizeFindings fails open on non-array input', () => {
  assert.deepStrictEqual(summarizeFindings(undefined), { errors: 0, warnings: 0, info: 0 });
  assert.deepStrictEqual(summarizeFindings('x'), { errors: 0, warnings: 0, info: 0 });
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('json-out: FAIL');
  process.exit(1);
}
console.log('json-out: PASS');
process.exit(0);
