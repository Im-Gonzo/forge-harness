#!/usr/bin/env node
/**
 * validate-rules — lint Forge's own rule assets (the template library).
 *
 * Recursive over `rules/**\/*.md`:
 *   - non-empty, readable
 *   - if a `paths:` frontmatter key exists, it must be a non-empty list of
 *     glob strings (inline `[a, b]` or a YAML block list of `- glob`)
 *
 * Absence of the rules/ dir (or no *.md) is NOT an error.
 *
 * Invocation: node lint/validate-rules.mjs [--strict] [rootDir]
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

const RULES_DIR = path.join(ROOT, 'rules');
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);

// ---- recursive collection --------------------------------------------------

/** Recursively collect *.md files under dir, returning absolute paths. */
function collectMd(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...collectMd(abs));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(abs);
    }
  }
  return out;
}

// ---- tiny frontmatter parser (self-contained, no shared lib) ---------------

/**
 * Extract leading YAML frontmatter lines.
 * @param {string} content
 * @returns {{present: boolean, lines: string[]}}
 */
function extractFrontmatter(content) {
  const clean = content.replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { present: false, lines: [] };
  return { present: true, lines: match[1].split(/\r?\n/) };
}

/**
 * Resolve the `paths:` key from frontmatter lines.
 * Returns { present, items } where items is the parsed glob list (best-effort)
 * and the inline raw string is recorded for inline-list validation.
 * @param {string[]} lines
 */
function parsePaths(lines) {
  let present = false;
  let inlineRaw = null;
  let isBlock = false;
  const items = [];
  let capturing = false;

  for (const rawLine of lines) {
    const topMatch = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (topMatch && !/^\s/.test(rawLine)) {
      // A new top-level key ends any in-progress block capture.
      if (capturing && topMatch[1] !== 'paths') capturing = false;
      if (topMatch[1] === 'paths') {
        present = true;
        const v = topMatch[2].replace(/\s+#.*$/, '').trim();
        if (v !== '') {
          inlineRaw = v;
        } else {
          isBlock = true;
          capturing = true;
        }
      }
      continue;
    }
    if (capturing) {
      const item = rawLine.match(/^\s*-\s*(.+?)\s*$/);
      if (item) {
        let val = item[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
        if (val !== '') items.push(val);
      } else if (rawLine.trim() === '') {
        // blank line inside block list — tolerate
      } else if (!/^\s/.test(rawLine)) {
        capturing = false;
      }
    }
  }

  // Parse inline list form: [a, b, c]
  if (inlineRaw && inlineRaw.startsWith('[') && inlineRaw.endsWith(']')) {
    const inner = inlineRaw.slice(1, -1).trim();
    if (inner !== '') {
      for (const part of inner.split(',')) {
        const p = part.trim().replace(/^["']|["']$/g, '');
        if (p !== '') items.push(p);
      }
    }
  }

  return { present, inlineRaw, isBlock, items };
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

function validateRule(abs) {
  const rel = path.relative(ROOT, abs);
  let content;
  try {
    content = fs.readFileSync(abs, 'utf-8');
  } catch (e) {
    err(rel, `unreadable: ${e.message}`);
    return;
  }
  if (content.trim().length === 0) {
    err(rel, 'empty rule file');
    return;
  }

  const fm = extractFrontmatter(content);
  if (!fm.present) return; // frontmatter is optional for rules

  const { present, inlineRaw, isBlock, items } = parsePaths(fm.lines);
  if (!present) return;

  const loc = locOf(rel, content, 'paths');

  // inline scalar that isn't a list (e.g. `paths: "*.py"`) is not a list.
  if (inlineRaw !== null && !(inlineRaw.startsWith('[') && inlineRaw.endsWith(']'))) {
    err(loc, `'paths' must be a list of globs (inline [a, b] or block "- glob"), got scalar: ${inlineRaw}`);
    return;
  }
  // inline list that opens [ but never closes ]
  if (inlineRaw !== null && inlineRaw.startsWith('[') && !inlineRaw.endsWith(']')) {
    err(loc, `'paths' is a malformed inline list (missing closing ]): ${inlineRaw}`);
    return;
  }

  if (items.length === 0) {
    err(loc, `'paths' is present but empty; must be a non-empty list of globs`);
  }
}

function main() {
  if (!fs.existsSync(RULES_DIR) || !fs.statSync(RULES_DIR).isDirectory()) {
    console.log('no rules found (rules/ absent) — nothing to validate');
    process.exit(0);
  }

  const files = collectMd(RULES_DIR).sort();
  if (files.length === 0) {
    console.log('no rules found (rules/ empty) — nothing to validate');
    process.exit(0);
  }

  for (const abs of files) validateRule(abs);

  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `validate-rules: ${files.length} rule file(s), ${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'PASS'}`
  );
  process.exit(failed ? 1 : 0);
}

main();
