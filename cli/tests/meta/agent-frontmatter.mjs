#!/usr/bin/env node
/**
 * agent-frontmatter — every agent declares a complete, well-formed contract.
 *
 * Behavioral restatement (belt-and-suspenders over lint/validate-agents.mjs):
 * every agents/*.md MUST carry name + description + tools + model in its
 * frontmatter, and model MUST be one of {haiku, sonnet, opus, inherit}. The
 * linter checks shape on the assets that happen to exist; this asserts the
 * contract as a behavioral guarantee so a new agent that omits a field — or
 * picks an unknown model — fails the build.
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

const REQUIRED_FIELDS = ['name', 'description', 'tools', 'model'];
const VALID_MODELS = ['haiku', 'sonnet', 'opus', 'inherit'];

/** Parse top-level frontmatter keys → trimmed string value. */
function parseFrontmatter(content) {
  const clean = content.replace(/^\uFEFF/, '');
  const fm = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const values = Object.create(null);
  let lastKey = null;
  for (const raw of fm[1].split(/\r?\n/)) {
    if (/^\s/.test(raw)) {
      // Indented line belongs to the preceding key (block list / nested value).
      if (lastKey !== null && /^\s*-\s/.test(raw) && values[lastKey] === '') {
        values[lastKey] = '(block-list)';
      }
      continue;
    }
    const idx = raw.indexOf(':');
    if (idx <= 0) continue;
    const key = raw.slice(0, idx).trim();
    let value = raw.slice(idx + 1).trim();
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, '').trim();
    values[key] = value;
    lastKey = key;
  }
  return values;
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

console.log('\n=== agent-frontmatter: every agent has name+description+tools+model ===\n');

const files = fs.existsSync(AGENTS_DIR)
  ? fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).sort()
  : [];

test('agents/ directory has at least one agent', () => {
  assert.ok(files.length > 0, 'no agents/*.md found — expected the reviewer family to ship');
});

for (const file of files) {
  test(`agents/${file} has a complete frontmatter contract`, () => {
    const src = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    const fm = parseFrontmatter(src);
    assert.ok(fm, `agents/${file} has no YAML frontmatter block`);

    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(fm, field),
        `agents/${file} is missing required frontmatter field: ${field}`
      );
      assert.ok(
        fm[field] !== '' && fm[field] !== '|' && fm[field] !== '>',
        `agents/${file} has an empty frontmatter field: ${field}`
      );
    }

    const model = fm.model.replace(/^["']|["']$/g, '');
    assert.ok(
      VALID_MODELS.includes(model),
      `agents/${file} has invalid model "${model}"; must be one of: ${VALID_MODELS.join(', ')}`
    );
  });
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('agent-frontmatter: FAIL');
  process.exit(1);
}
console.log('agent-frontmatter: PASS');
process.exit(0);
