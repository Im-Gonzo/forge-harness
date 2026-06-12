#!/usr/bin/env node
/**
 * validate-agents — lint Forge's own agent assets.
 *
 * For each `agents/*.md` at the plugin root:
 *   - valid YAML frontmatter block (--- ... ---)
 *   - required fields `name` and `description` (present + non-empty)
 *   - `tools` if present is a YAML list (inline `[...]` or block `- item`)
 *   - `model` if present ∈ {haiku, sonnet, opus, inherit}
 *   - no duplicate top-level frontmatter keys
 *   - non-empty body (content after the frontmatter)
 *
 * Absence of the agents/ dir (or no *.md in it) is NOT an error.
 *
 * Invocation: node lint/validate-agents.mjs [--strict] [rootDir]
 * Real violations are ERRORS (exit 1). Style nits are WARNINGS
 * (exit 0 unless --strict). Zero dependencies; self-contained.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VALID_MODELS = ['haiku', 'sonnet', 'opus', 'inherit'];

// ---- argument parsing ------------------------------------------------------

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const positional = args.filter(a => !a.startsWith('--'));
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = positional[0]
  ? path.resolve(positional[0])
  : path.resolve(SELF_DIR, '..');

const AGENTS_DIR = path.join(ROOT, 'agents');

// ---- tiny frontmatter parser (self-contained, no shared lib) ---------------

/**
 * Split a markdown document into a leading YAML frontmatter block and body.
 * Tolerant of a UTF-8 BOM and CRLF line endings.
 * @param {string} content
 * @returns {{present: boolean, lines: string[], body: string}}
 */
function splitFrontmatter(content) {
  const clean = content.replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) return { present: false, lines: [], body: clean };
  return {
    present: true,
    lines: match[1].split(/\r?\n/),
    body: match[2] ?? '',
  };
}

/**
 * Parse top-level keys from frontmatter lines, tracking duplicates and
 * whether each key's value is a block list or empty. Indented lines are
 * treated as belonging to the preceding key (nested value / list items).
 * @param {string[]} lines
 */
function parseTopLevel(lines) {
  const values = Object.create(null);
  const duplicates = [];
  const blockListKeys = new Set();
  let lastKey = null;

  for (const rawLine of lines) {
    if (/^\s/.test(rawLine)) {
      // Indented: a block-list item ("  - foo") or nested mapping value.
      if (lastKey !== null && /^\s*-\s/.test(rawLine)) {
        blockListKeys.add(lastKey);
      }
      continue;
    }
    const colonIdx = rawLine.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = rawLine.slice(0, colonIdx).trim();
    let value = rawLine.slice(colonIdx + 1).trim();
    // Strip an unquoted trailing comment for emptiness checks.
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, '').trim();
    if (Object.prototype.hasOwnProperty.call(values, key)) duplicates.push(key);
    values[key] = value;
    lastKey = key;
  }
  return { values, duplicates, blockListKeys };
}

// ---- validation ------------------------------------------------------------

const errors = [];
const warnings = [];

function err(loc, msg) { errors.push(`ERROR  ${loc}  ${msg}`); }
function warn(loc, msg) { warnings.push(`WARN   ${loc}  ${msg}`); }

/**
 * Find the 1-based line number of a top-level key in the file (frontmatter
 * starts at line 2, after the opening `---`). Returns the file path with a
 * line suffix for the finding location.
 */
function locOf(relPath, content, key) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${key}\\s*:`).test(lines[i])) return `${relPath}:${i + 1}`;
  }
  return relPath;
}

function validateAgent(file) {
  const filePath = path.join(AGENTS_DIR, file);
  const rel = path.join('agents', file);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    err(rel, `unreadable: ${e.message}`);
    return;
  }

  const fm = splitFrontmatter(content);
  if (!fm.present) {
    err(`${rel}:1`, 'missing YAML frontmatter (--- ... --- block)');
    return;
  }

  const { values, duplicates, blockListKeys } = parseTopLevel(fm.lines);

  if (duplicates.length > 0) {
    err(rel, `duplicate frontmatter keys: ${[...new Set(duplicates)].join(', ')}`);
  }

  for (const field of ['name', 'description']) {
    if (!Object.prototype.hasOwnProperty.call(values, field)) {
      err(rel, `missing required frontmatter field: ${field}`);
    } else if (values[field] === '' || values[field] === '|' || values[field] === '>') {
      err(locOf(rel, content, field), `frontmatter '${field}' is empty`);
    }
  }

  // tools, if present, must be a list (inline [...] or block "- item").
  if (Object.prototype.hasOwnProperty.call(values, 'tools')) {
    const v = values.tools;
    const isInlineList = v.startsWith('[') && v.endsWith(']');
    const isBlockList = blockListKeys.has('tools');
    // Empty value with following block items => block list; bare empty is not a list.
    if (!isInlineList && !isBlockList) {
      err(locOf(rel, content, 'tools'), `'tools' must be a YAML list (inline [a, b] or block "- a"), got: ${v || '(empty)'}`);
    }
  }

  // model, if present, must be a known value.
  if (Object.prototype.hasOwnProperty.call(values, 'model') && values.model !== '') {
    const m = values.model.replace(/^["']|["']$/g, '');
    if (!VALID_MODELS.includes(m)) {
      err(locOf(rel, content, 'model'), `invalid model '${m}'; must be one of: ${VALID_MODELS.join(', ')}`);
    }
  }

  // Non-empty body.
  if (fm.body.trim().length === 0) {
    err(rel, 'empty body (no content after frontmatter)');
  }
}

function main() {
  if (!fs.existsSync(AGENTS_DIR) || !fs.statSync(AGENTS_DIR).isDirectory()) {
    console.log('no agents found (agents/ absent) — nothing to validate');
    process.exit(0);
  }

  const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) {
    console.log('no agents found (agents/ empty) — nothing to validate');
    process.exit(0);
  }

  for (const file of files) validateAgent(file);

  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `validate-agents: ${files.length} agent file(s), ${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'PASS'}`
  );
  process.exit(failed ? 1 : 0);
}

main();
