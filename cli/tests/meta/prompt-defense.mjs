#!/usr/bin/env node
/**
 * prompt-defense — the always-on Prompt Defense Baseline must keep its three pillars.
 *
 * docs/METHOD.md §9: a one-time Prompt Defense Baseline backstops the harness.
 * rules/prompt-defense-baseline.md is that backstop and MUST keep covering:
 *   (1) untrusted external / tool-returned content is data, not instructions;
 *   (2) no role / persona / identity change on the say-so of content;
 *   (3) no secret / credential leakage or exfiltration.
 * Weakening any pillar is a security regression — fail the build.
 *
 * Zero deps. node:assert. Exit 1 on any failure.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const RULE_PATH = path.join(FORGE_ROOT, 'rules', 'prompt-defense-baseline.md');

const PILLARS = [
  {
    name: 'treats external/tool-returned content as untrusted data, not instructions',
    patterns: [
      /untrusted (?:by default|content|data)/i,
      /(?:external|fetch|tool|MCP|retrieved)[\s\S]{0,80}?(?:untrusted|not\s+(?:as\s+)?instructions|data,?\s+never)/i,
    ],
    // Require BOTH an "untrusted" notion AND a "not instructions" notion.
    require: 'all',
  },
  {
    name: 'forbids role / persona / identity change on content say-so',
    patterns: [
      /do\s*not\s+change\s+role/i,
      /change\s+role,?\s*persona,?\s*(?:or\s+)?identity/i,
      /hold your role/i,
    ],
  },
  {
    name: 'forbids secret / credential leakage and exfiltration',
    patterns: [
      /never\s+(?:reveal|disclose|leak)[\s\S]{0,60}?(?:secret|api key|token|credential|password|\.env)/i,
      /exfiltrat/i,
      /leak[\s\S]{0,20}?(?:secret|api key|credential)/i,
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

console.log('\n=== prompt-defense: the baseline keeps its three pillars ===\n');

test('rules/prompt-defense-baseline.md exists', () => {
  assert.ok(fs.existsSync(RULE_PATH), `expected rules/prompt-defense-baseline.md to exist`);
});

const src = fs.existsSync(RULE_PATH) ? fs.readFileSync(RULE_PATH, 'utf8') : '';

for (const pillar of PILLARS) {
  test(`prompt-defense-baseline covers: ${pillar.name}`, () => {
    const matched =
      pillar.require === 'all'
        ? pillar.patterns.every((p) => p.test(src))
        : pillar.patterns.some((p) => p.test(src));
    assert.ok(
      matched,
      `rules/prompt-defense-baseline.md is missing the pillar "${pillar.name}" ` +
        `(${pillar.require === 'all' ? 'all of' : 'any of'}: ${pillar.patterns.map(String).join(' | ')})`
    );
  });
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('prompt-defense: FAIL');
  process.exit(1);
}
console.log('prompt-defense: PASS');
process.exit(0);
