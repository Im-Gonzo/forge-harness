#!/usr/bin/env node
/**
 * findings — unit tests for manager/lib/findings.mjs (the C2 finding + the
 * child-validator parser, ADR-0004 / SPEC-09).
 *
 * Asserts: makeFinding validates level/line and returns the C2 shape;
 * parseFindingLine applies the exact ADR-0004 regex (with and without :line);
 * parseFindings collects matches in order and DROPS banner/summary lines;
 * everything fails open (no throw) on garbage input.
 *
 * Zero deps. node:assert. Exit 1 on any failure.
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(SCRIPT_DIR, '..', '..', 'manager', 'lib', 'findings.mjs');
const { makeFinding, parseFindingLine, parseFindings } = await import(LIB);

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

console.log('\n=== findings: C2 finding + ADR-0004 parser ===\n');

// ---- makeFinding -----------------------------------------------------------

test('makeFinding returns the five-field C2 shape', () => {
  const f = makeFinding({ level: 'ERROR', path: 'a.md', line: 12, message: 'm', source: 's.mjs' });
  assert.deepStrictEqual(Object.keys(f).sort(), ['level', 'line', 'message', 'path', 'source']);
  assert.deepStrictEqual(f, { level: 'ERROR', path: 'a.md', line: 12, message: 'm', source: 's.mjs' });
});

test('makeFinding accepts WARN and INFO', () => {
  assert.strictEqual(makeFinding({ level: 'WARN' }).level, 'WARN');
  assert.strictEqual(makeFinding({ level: 'INFO' }).level, 'INFO');
});

test('makeFinding coerces an unknown level to INFO (fail-open)', () => {
  assert.strictEqual(makeFinding({ level: 'CRITICAL' }).level, 'INFO');
  assert.strictEqual(makeFinding({}).level, 'INFO');
});

test('makeFinding normalises a non-integer/zero/negative line to null', () => {
  assert.strictEqual(makeFinding({ line: 0 }).line, null);
  assert.strictEqual(makeFinding({ line: -3 }).line, null);
  assert.strictEqual(makeFinding({ line: 2.5 }).line, null);
  assert.strictEqual(makeFinding({ line: 'x' }).line, null);
  assert.strictEqual(makeFinding({}).line, null);
});

test('makeFinding keeps a valid integer line', () => {
  assert.strictEqual(makeFinding({ line: 1 }).line, 1);
  assert.strictEqual(makeFinding({ line: 99 }).line, 99);
});

test('makeFinding defaults missing string fields to empty string', () => {
  const f = makeFinding({});
  assert.strictEqual(f.path, '');
  assert.strictEqual(f.message, '');
  assert.strictEqual(f.source, '');
});

test('makeFinding never throws on undefined/garbage args', () => {
  assert.doesNotThrow(() => makeFinding());
  assert.doesNotThrow(() => makeFinding(undefined));
});

// ---- parseFindingLine ------------------------------------------------------

test('parseFindingLine parses LEVEL path:line message', () => {
  const f = parseFindingLine('ERROR agents/code-reviewer.md:12 dangling ref: x', 'validate-xref.mjs');
  assert.deepStrictEqual(f, {
    level: 'ERROR',
    path: 'agents/code-reviewer.md',
    line: 12,
    message: 'dangling ref: x',
    source: 'validate-xref.mjs',
  });
});

test('parseFindingLine parses LEVEL path message (no :line) -> line null', () => {
  const f = parseFindingLine('WARN agents/x.md something is off', 'v.mjs');
  assert.deepStrictEqual(f, {
    level: 'WARN',
    path: 'agents/x.md',
    line: null,
    message: 'something is off',
    source: 'v.mjs',
  });
});

test('parseFindingLine handles INFO level', () => {
  const f = parseFindingLine('INFO skills/run-eval/SKILL.md:3 note', 'v.mjs');
  assert.strictEqual(f.level, 'INFO');
  assert.strictEqual(f.line, 3);
});

test('parseFindingLine does NOT split a colon inside the message', () => {
  // path is non-greedy + the :digits suffix is anchored to the path token, so a
  // "key: value" message stays whole.
  const f = parseFindingLine('ERROR a.md dangling prose ref: react-reviewer', 's');
  assert.strictEqual(f.path, 'a.md');
  assert.strictEqual(f.line, null);
  assert.strictEqual(f.message, 'dangling prose ref: react-reviewer');
});

test('parseFindingLine returns null for banner/summary/blank/garbage', () => {
  assert.strictEqual(parseFindingLine('=== validate-xref ==='), null);
  assert.strictEqual(parseFindingLine('validate-xref: PASS'), null);
  assert.strictEqual(parseFindingLine('validate-xref: FAIL (3 errors)'), null);
  assert.strictEqual(parseFindingLine(''), null);
  assert.strictEqual(parseFindingLine('   '), null);
  assert.strictEqual(parseFindingLine('error lowercase path msg'), null); // level must be upper-case
});

test('parseFindingLine fails open on non-string input', () => {
  assert.strictEqual(parseFindingLine(undefined), null);
  assert.strictEqual(parseFindingLine(null), null);
  assert.strictEqual(parseFindingLine(42), null);
});

test('parseFindingLine defaults source to empty string', () => {
  assert.strictEqual(parseFindingLine('ERROR a.md msg').source, '');
});

// ---- parseFindings ---------------------------------------------------------

test('parseFindings collects matching lines in order and drops the rest', () => {
  const text = [
    '=== validate-xref: cross-reference check ===', // banner -> dropped
    'ERROR agents/a.md:1 first',
    'noise line that is not a finding', // dropped
    'WARN agents/b.md second',
    '',
    'INFO agents/c.md:9 third',
    'validate-xref: FAIL (2 errors, 1 warning)', // summary -> dropped
  ].join('\n');
  const out = parseFindings(text, 'validate-xref.mjs');
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((f) => f.level), ['ERROR', 'WARN', 'INFO']);
  assert.deepStrictEqual(out.map((f) => f.line), [1, null, 9]);
  assert.ok(out.every((f) => f.source === 'validate-xref.mjs'));
});

test('parseFindings handles CRLF line endings', () => {
  const out = parseFindings('ERROR a.md:1 x\r\nWARN b.md y\r\n', 's');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].line, 1);
});

test('parseFindings returns [] for empty / non-string input (fail-open)', () => {
  assert.deepStrictEqual(parseFindings(''), []);
  assert.deepStrictEqual(parseFindings(undefined), []);
  assert.deepStrictEqual(parseFindings(null), []);
  assert.deepStrictEqual(parseFindings(123), []);
});

test('parseFindings returns [] when nothing matches (all banner/summary)', () => {
  const out = parseFindings('=== header ===\nall good\nsomething: PASS', 's');
  assert.deepStrictEqual(out, []);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('findings: FAIL');
  process.exit(1);
}
console.log('findings: PASS');
process.exit(0);
