#!/usr/bin/env node
/**
 * validate-workflows — lint Forge's own reusable-workflow assets.
 *
 * A workflow component is a reusable Claude Code workflow: `workflows/<name>.md`
 * (the orchestration narrative) with an OPTIONAL sibling `workflows/<name>.js` (the
 * Workflow-tool script). The `.md` is the component; the `.js`, when present, is the
 * runnable script and is linted here for its SHAPE (its `meta` block) — security
 * (secrets / network / exec / determinism sinks) is `validate-workflow-security`'s job.
 *
 * For each `workflows/*.md` at the plugin root:
 *   - non-empty, readable
 *   - frontmatter present with a non-empty `name`
 *   - frontmatter present with a non-empty `description`
 *   - optional `phases` well-formed: an inline `[...]` list, a block list, or a
 *     comma/space-separated inline scalar — but a value that opens `[` or `{`
 *     without closing is a malformed YAML sequence/mapping (ERROR)
 *
 * For each `workflows/*.js` Workflow script (ADDITIVE — the `.md` checks above are
 * unchanged): the documented Workflow-script SHAPE — an exported `meta` literal (the
 * runtime reads it to register name/params/output). A `.js` with no `export const meta`
 * (or `export {... meta ...}` / `meta:` in a default-export object) is ERROR: the
 * runtime cannot register it.
 *
 * Absence of the workflows/ dir (or no *.md / *.js) is NOT an error.
 *
 * Invocation: node lint/validate-workflows.mjs [--strict] [rootDir]
 * Zero dependencies; self-contained. Mirrors lint/validate-commands.mjs.
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

const WORKFLOWS_DIR = path.join(ROOT, 'workflows');

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

function validateWorkflow(file) {
  const rel = path.join('workflows', file);
  const filePath = path.join(WORKFLOWS_DIR, file);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    err(rel, `unreadable: ${e.message}`);
    return;
  }

  if (content.trim().length === 0) {
    err(rel, 'empty workflow file');
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

  if (!Object.prototype.hasOwnProperty.call(values, 'name')) {
    err(rel, 'frontmatter missing required field: name');
  } else if (values.name === '' || values.name === '|' || values.name === '>') {
    err(locOf(rel, content, 'name'), "frontmatter 'name' is empty");
  }

  if (!Object.prototype.hasOwnProperty.call(values, 'description')) {
    err(rel, 'frontmatter missing required field: description');
  } else if (values.description === '' || values.description === '|' || values.description === '>') {
    err(locOf(rel, content, 'description'), "frontmatter 'description' is empty");
  }

  // phases: optional; inline list, block list, or scalar — but not a half-open
  // [ / { sequence/mapping.
  if (Object.prototype.hasOwnProperty.call(values, 'phases')) {
    const v = values['phases'];
    const isBlockList = blockListKeys.has('phases');
    if (v === '' && !isBlockList) {
      err(locOf(rel, content, 'phases'), "frontmatter 'phases' is present but empty");
    } else if (!isBlockList && !wellFormedScalar(v)) {
      err(locOf(rel, content, 'phases'), `frontmatter 'phases' is a malformed YAML value: ${v}`);
    }
  }
}

/**
 * Lint a `.js` Workflow script's SHAPE: it must export a `meta` literal so the runtime
 * can register it (the documented Workflow-script format). Accepts the three idiomatic
 * forms — `export const meta = {…}`, a named re-export `export { meta }` / `export {
 * meta as … }`, and a `meta:` key inside an `export default {…}` object. Shape only;
 * the security sweep is the sibling validator's job. ADDITIVE: never touches the `.md`
 * path. A comment-only mention does not count (we require an export form, not the bare
 * word).
 */
function validateScript(file) {
  const rel = path.join('workflows', file);
  const filePath = path.join(WORKFLOWS_DIR, file);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    err(rel, `unreadable: ${e.message}`);
    return;
  }
  if (content.trim().length === 0) {
    err(rel, 'empty workflow script file');
    return;
  }
  const hasMetaExport =
    /\bexport\s+(?:const|let|var)\s+meta\b/.test(content) ||
    /\bexport\s*\{[^}]*\bmeta\b[^}]*\}/.test(content) ||
    (/\bexport\s+default\b/.test(content) && /\bmeta\s*[,:}]/.test(content));
  if (!hasMetaExport) {
    err(
      `${rel}:1`,
      "Workflow script missing an exported `meta` literal (export const meta = {…}) — " +
        'the runtime reads it to register the script'
    );
  }
}

function main() {
  if (!fs.existsSync(WORKFLOWS_DIR) || !fs.statSync(WORKFLOWS_DIR).isDirectory()) {
    console.log('no workflows found (workflows/ absent) — nothing to validate');
    process.exit(0);
  }

  const mdFiles = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.md')).sort();
  const jsFiles = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.js')).sort();
  if (mdFiles.length === 0 && jsFiles.length === 0) {
    console.log('no workflows found (workflows/ empty) — nothing to validate');
    process.exit(0);
  }

  for (const file of mdFiles) validateWorkflow(file);
  for (const file of jsFiles) validateScript(file);

  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `validate-workflows: ${mdFiles.length} workflow file(s), ${jsFiles.length} script(s), ${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'PASS'}`
  );
  process.exit(failed ? 1 : 0);
}

main();
