#!/usr/bin/env node
/**
 * validate-commands — lint Forge's own slash-command assets.
 *
 * For each `commands/*.md` at the plugin root:
 *   - non-empty, readable
 *   - frontmatter present with a non-empty `description`
 *   - optional `argument-hint` well-formed (non-empty if present)
 *   - optional `allowed-tools` well-formed: inline `[...]`, block list, or a
 *     comma/space-separated inline scalar — but a value that opens `[` or `{`
 *     without closing is a malformed YAML sequence/mapping (ERROR)
 *
 * Absence of the commands/ dir (or no *.md) is NOT an error.
 *
 * Invocation: node lint/validate-commands.mjs [--strict] [rootDir]
 * Zero dependencies; self-contained.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- argument parsing ------------------------------------------------------

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const positional = args.filter(a => !a.startsWith('--'));
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = positional[0]
  ? path.resolve(positional[0])
  : path.resolve(SELF_DIR, '..');

const COMMANDS_DIR = path.join(ROOT, 'commands');

// ---- tiny frontmatter parser (self-contained, no shared lib) ---------------

/**
 * Split a markdown doc into frontmatter lines and body.
 * Tolerant of a UTF-8 BOM and CRLF line endings.
 * @param {string} content
 * @returns {{present: boolean, closed: boolean, lines: string[], body: string}}
 */
function splitFrontmatter(content) {
  const clean = content.replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(clean)) {
    return { present: false, closed: true, lines: [], body: clean };
  }
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    return { present: true, closed: false, lines: [], body: '' };
  }
  return {
    present: true,
    closed: true,
    lines: match[1].split(/\r?\n/),
    body: match[2] ?? '',
  };
}

/**
 * Parse top-level keys from frontmatter lines.
 * @param {string[]} lines
 */
function parseTopLevel(lines) {
  const values = Object.create(null);
  const blockListKeys = new Set();
  let lastKey = null;
  for (const rawLine of lines) {
    if (/^\s/.test(rawLine)) {
      if (lastKey !== null && /^\s*-\s/.test(rawLine)) blockListKeys.add(lastKey);
      continue;
    }
    const m = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, '');
    values[m[1]] = value.trim();
    lastKey = m[1];
  }
  return { values, blockListKeys };
}

// ---- validation ------------------------------------------------------------

const errors = [];
const warnings = [];

function err(loc, msg) { errors.push(`ERROR  ${loc}  ${msg}`); }

function locOf(rel, content, key) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${key}\\s*:`).test(lines[i])) return `${rel}:${i + 1}`;
  }
  return rel;
}

/** A scalar that opens [ or { but does not close it is malformed YAML. */
function wellFormedScalar(value) {
  const v = value.trim();
  const quoted = (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"));
  if (quoted) return true;
  if (v.startsWith('[') && !v.endsWith(']')) return false;
  if (v.startsWith('{') && !v.endsWith('}')) return false;
  return true;
}

function validateCommand(file) {
  const rel = path.join('commands', file);
  const filePath = path.join(COMMANDS_DIR, file);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    err(rel, `unreadable: ${e.message}`);
    return;
  }

  if (content.trim().length === 0) {
    err(rel, 'empty command file');
    return;
  }

  const fm = splitFrontmatter(content);
  if (!fm.present) {
    err(`${rel}:1`, 'missing YAML frontmatter (--- ... --- block)');
    return;
  }
  if (!fm.closed) {
    err(`${rel}:1`, 'frontmatter block is missing a closing --- delimiter');
    return;
  }

  const { values, blockListKeys } = parseTopLevel(fm.lines);

  if (!Object.prototype.hasOwnProperty.call(values, 'description')) {
    err(rel, 'frontmatter missing required field: description');
  } else if (values.description === '' || values.description === '|' || values.description === '>') {
    err(locOf(rel, content, 'description'), "frontmatter 'description' is empty");
  }

  // argument-hint: optional; if present must be non-empty.
  if (Object.prototype.hasOwnProperty.call(values, 'argument-hint')) {
    const v = values['argument-hint'];
    if (v === '' && !blockListKeys.has('argument-hint')) {
      err(locOf(rel, content, 'argument-hint'), "frontmatter 'argument-hint' is present but empty");
    } else if (!wellFormedScalar(v)) {
      err(locOf(rel, content, 'argument-hint'), `frontmatter 'argument-hint' is a malformed YAML value: ${v}`);
    }
  }

  // allowed-tools: optional; inline list, block list, or scalar — but not a
  // half-open [ / { sequence/mapping.
  if (Object.prototype.hasOwnProperty.call(values, 'allowed-tools')) {
    const v = values['allowed-tools'];
    const isBlockList = blockListKeys.has('allowed-tools');
    if (v === '' && !isBlockList) {
      err(locOf(rel, content, 'allowed-tools'), "frontmatter 'allowed-tools' is present but empty");
    } else if (!isBlockList && !wellFormedScalar(v)) {
      err(locOf(rel, content, 'allowed-tools'), `frontmatter 'allowed-tools' is a malformed YAML value: ${v}`);
    }
  }
}

function main() {
  if (!fs.existsSync(COMMANDS_DIR) || !fs.statSync(COMMANDS_DIR).isDirectory()) {
    console.log('no commands found (commands/ absent) — nothing to validate');
    process.exit(0);
  }

  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) {
    console.log('no commands found (commands/ empty) — nothing to validate');
    process.exit(0);
  }

  for (const file of files) validateCommand(file);

  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `validate-commands: ${files.length} command file(s), ${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'PASS'}`
  );
  process.exit(failed ? 1 : 0);
}

main();
