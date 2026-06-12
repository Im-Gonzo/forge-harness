#!/usr/bin/env node
/**
 * skill-governance — the load-bearing governance prose in key skills must persist.
 *
 * docs/METHOD.md §5 (EDD: pass@k AND pass^k), §6 (dual-review = two INDEPENDENT
 * reviewers), §8 (memory is confidence-scored AND evidence-backed). These are the
 * distinctive quality mechanisms; a prompt edit that drops them silently is a
 * regression. This test asserts the prose is PRESENT in the shipped skills.
 *
 * Zero deps. node:assert. Exit 1 on any failure.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const SKILLS_DIR = path.join(FORGE_ROOT, 'skills');

// skill-dir -> the concepts its SKILL.md must contain (each = accepted phrasings).
const CONTRACTS = [
  {
    skill: 'dual-review',
    concepts: [
      {
        name: 'two INDEPENDENT reviewers',
        patterns: [
          /two\s+\*?\*?independent\*?\*?\s+reviewers/i,
          /two\s+reviewers[\s\S]{0,40}?independent/i,
        ],
      },
      {
        name: 'both must pass / approve',
        patterns: [/both must (?:pass|approve)/i],
      },
    ],
  },
  {
    skill: 'run-eval',
    concepts: [
      { name: 'pass@k', patterns: [/pass@k/i] },
      { name: 'pass^k', patterns: [/pass\^k/i] },
    ],
  },
  {
    skill: 'capture-learning',
    concepts: [
      { name: 'confidence', patterns: [/confidence/i] },
      { name: 'evidence', patterns: [/evidence/i] },
    ],
  },
  {
    skill: 'curate-memory',
    concepts: [
      { name: 'confidence', patterns: [/confidence/i] },
      { name: 'evidence', patterns: [/evidence/i] },
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

console.log('\n=== skill-governance: key skills retain their governance prose ===\n');

for (const { skill, concepts } of CONTRACTS) {
  const skillPath = path.join(SKILLS_DIR, skill, 'SKILL.md');
  test(`skills/${skill}/SKILL.md exists`, () => {
    assert.ok(fs.existsSync(skillPath), `expected skills/${skill}/SKILL.md to exist`);
  });

  if (!fs.existsSync(skillPath)) continue;
  const src = fs.readFileSync(skillPath, 'utf8');

  for (const concept of concepts) {
    test(`skills/${skill}/SKILL.md mentions: ${concept.name}`, () => {
      const matched = concept.patterns.some((p) => p.test(src));
      assert.ok(
        matched,
        `skills/${skill}/SKILL.md is missing governance prose "${concept.name}" ` +
          `(none of: ${concept.patterns.map(String).join(' | ')})`
      );
    });
  }
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('skill-governance: FAIL');
  process.exit(1);
}
console.log('skill-governance: PASS');
process.exit(0);
