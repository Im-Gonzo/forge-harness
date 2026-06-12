#!/usr/bin/env node
/**
 * reviewer-anti-noise — every reviewer agent must retain its anti-noise scaffolding.
 *
 * Encodes docs/METHOD.md §6 ("anti-noise review") and §10 ("Forge validates Forge")
 * as a behavioral contract: a prompt regression that drops the Pre-Report Gate,
 * the zero-findings-is-valid clause, or the HIGH/CRITICAL-require-proof rule from
 * ANY reviewer is a FAILING build, not silent drift.
 *
 * PRESENCE is asserted across the WHOLE reviewer family, naming the offending file on failure.
 *
 * Zero deps. node:assert. Exit 1 on any failure.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const AGENTS_DIR = path.join(FORGE_ROOT, 'agents');

// The reviewer family that must all carry the anti-noise discipline.
const REVIEWERS = [
  'code-reviewer.md',
  'diff-reviewer.md',
  'python-reviewer.md',
  'typescript-reviewer.md',
  'database-reviewer.md',
  'security-reviewer.md',
];

// Each load-bearing concept, expressed as one or more accepted phrasings.
// A reviewer passes the concept if ANY of its patterns matches (reviewers vary
// in heading style: "### HIGH / CRITICAL Require Proof" vs inline
// "**HIGH/CRITICAL require proof**" vs "## HIGH / CRITICAL require proof").
const CONCEPTS = [
  {
    name: 'Pre-Report Gate',
    patterns: [/Pre-Report Gate/i],
  },
  {
    name: 'a clean review is a valid review (zero findings is legitimate)',
    patterns: [
      /a clean (?:review|diff|pass) is a valid review/i,
      /zero findings is (?:a )?(?:legitimate|valid|expected)/i,
      /return(?:ing)? zero findings/i,
    ],
  },
  {
    // The proof discipline ties HIGH/CRITICAL to evidence-or-demote. Accept the
    // explicit named clause ("HIGH / CRITICAL require proof", used by
    // code/diff/python/typescript reviewers) AND the equivalent inline phrasing
    // ("HIGH/CRITICAL needs proof: ... → demote to MEDIUM or drop", used by the
    // database/security reviewers). Both encode the same rule; deleting the rule
    // entirely still fails. We do NOT match a bare "HIGH"/"proof" mention alone.
    name: 'HIGH/CRITICAL require proof (evidence-or-demote)',
    patterns: [
      /HIGH\s*\/?\s*CRITICAL\s+(?:require[s]?|needs?)\s+proof/i,
      /(?:any\s+)?HIGH\s+(?:or|\/)\s+CRITICAL[\s\S]{0,120}?(?:include all three|require[s]? proof|needs? proof|or demote|demote\b)/i,
    ],
  },
];

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

function read(file) {
  return fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
}

console.log('\n=== reviewer-anti-noise: every reviewer keeps its anti-noise scaffolding ===\n');

for (const file of REVIEWERS) {
  test(`${file} exists`, () => {
    assert.ok(
      fs.existsSync(path.join(AGENTS_DIR, file)),
      `expected reviewer agent agents/${file} to exist`
    );
  });
}

for (const file of REVIEWERS) {
  const src = read(file);
  for (const concept of CONCEPTS) {
    test(`agents/${file} contains: ${concept.name}`, () => {
      const matched = concept.patterns.some((p) => p.test(src));
      assert.ok(
        matched,
        `agents/${file} is missing the anti-noise scaffolding "${concept.name}" ` +
          `(none of: ${concept.patterns.map(String).join(' | ')})`
      );
    });
  }
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('reviewer-anti-noise: FAIL');
  process.exit(1);
}
console.log('reviewer-anti-noise: PASS');
process.exit(0);
