#!/usr/bin/env node
/**
 * reviewers-read-only — the read-only invariant for every reviewer agent.
 *
 * docs/METHOD.md §3 (autonomy ladder): a reviewer is a T0 read-only role. It
 * diagnoses and reports; it never edits. The mechanical guarantee is that its
 * `tools:` frontmatter grants neither Edit nor Write. This test asserts that
 * invariant for the whole reviewer family — closing a gap from our v2 harness,
 * where the read-only contract lived only in prose and could silently rot.
 *
 * Handles all three `tools:` YAML shapes Forge uses:
 *   - inline list:          tools: [Read, Grep, Glob, Bash]
 *   - quoted inline list:   tools: ["Read", "Grep", "Glob", "Bash"]
 *   - block list:           tools:\n  - Read\n  - Grep ...
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

const REVIEWERS = [
  'code-reviewer.md',
  'diff-reviewer.md',
  'python-reviewer.md',
  'typescript-reviewer.md',
  'database-reviewer.md',
  'security-reviewer.md',
];

const FORBIDDEN = ['Edit', 'Write'];

/** Extract the list of tool names from an agent's frontmatter, any YAML shape. */
function parseTools(content) {
  const clean = content.replace(/^\uFEFF/, '');
  const fm = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) throw new Error('no YAML frontmatter found');
  const lines = fm[1].split(/\r?\n/);

  const tools = [];
  let inBlockList = false;

  for (const raw of lines) {
    if (inBlockList) {
      const item = raw.match(/^\s+-\s*(.+?)\s*$/);
      if (item) {
        tools.push(item[1].replace(/^["']|["']$/g, '').trim());
        continue;
      }
      // A non-indented, non-dash line ends the block list.
      if (!/^\s/.test(raw)) inBlockList = false;
    }

    const m = raw.match(/^tools\s*:\s*(.*)$/);
    if (!m) continue;
    const value = m[1].trim();

    if (value === '' || value === '|' || value === '>') {
      // Block list follows on subsequent indented `- item` lines.
      inBlockList = true;
      continue;
    }

    // Inline list [a, b, c] (quotes optional).
    const inline = value.replace(/^\[|\]$/g, '');
    for (const part of inline.split(',')) {
      const name = part.trim().replace(/^["']|["']$/g, '').trim();
      if (name) tools.push(name);
    }
  }
  return tools;
}

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

console.log('\n=== reviewers-read-only: no reviewer may grant Edit or Write ===\n');

for (const file of REVIEWERS) {
  test(`agents/${file} tools: is read-only (no Edit, no Write)`, () => {
    const src = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    const tools = parseTools(src);
    assert.ok(tools.length > 0, `agents/${file} declares no tools — expected a read-only tool list`);
    const offending = tools.filter((t) => FORBIDDEN.includes(t));
    assert.strictEqual(
      offending.length,
      0,
      `agents/${file} grants forbidden write tool(s): ${offending.join(', ')} ` +
        `(reviewers are read-only T0; tools = [${tools.join(', ')}])`
    );
  });
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('reviewers-read-only: FAIL');
  process.exit(1);
}
console.log('reviewers-read-only: PASS');
process.exit(0);
