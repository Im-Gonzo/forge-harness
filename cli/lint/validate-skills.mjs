#!/usr/bin/env node
/**
 * validate-skills — lint Forge's own skill assets.
 *
 * For each sub-directory of `skills/` at the plugin root, its `SKILL.md`:
 *   - exists & is non-empty
 *   - frontmatter declares non-empty `name` and `description`
 *   - `description` is an inline or folded ('>') scalar, NEVER a literal
 *     block scalar (`|` / `|-` / `|+` / `|2` ...), which preserves internal
 *     newlines and breaks flat-table renderers keyed on `description`.
 *
 * Absence of the skills/ dir (or no skill sub-dirs) is NOT an error.
 *
 * Structural findings (missing/empty SKILL.md) are always ERRORS.
 * Frontmatter findings are ERRORS too (real violations), promoted to the
 * same exit-1 path. --strict additionally fails on warnings.
 *
 * Invocation: node lint/validate-skills.mjs [--strict] [rootDir]
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

const SKILLS_DIR = path.join(ROOT, 'skills');

// ---- tiny frontmatter parser (self-contained, no shared lib) ---------------

/**
 * Extract the leading YAML frontmatter lines of a markdown document.
 * Tolerant of a UTF-8 BOM and CRLF line endings.
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
 * Inspect top-level keys and detect the block-scalar indicator (if any) on
 * the `description:` line. Lines continuing a block scalar are skipped so we
 * only consider top-level keys. Block-scalar indicators accept YAML chomp
 * (`-`/`+`) and indent-digit modifiers and trailing comments, e.g.
 * `|`, `|-`, `|+`, `|2`, `>-  # note`.
 * @param {string[]} lines
 * @returns {{values: Record<string,string>, descriptionIndicator: string|null}}
 */
function inspectFrontmatter(lines) {
  const values = Object.create(null);
  let descriptionIndicator = null;
  let inBlockScalar = false;
  let blockScalarIndent = -1;

  for (const rawLine of lines) {
    if (inBlockScalar) {
      const leadingSpaces = rawLine.match(/^(\s*)/)[1].length;
      if (rawLine.trim() === '' || leadingSpaces > blockScalarIndent) continue;
      inBlockScalar = false;
      blockScalarIndent = -1;
    }

    const match = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2];
    const valueNoComment = rawValue
      .replace(/^\s*#.*$/, '')
      .replace(/\s+#.*$/, '')
      .trim();
    values[key] = valueNoComment;

    if (/^[|>](?:[+-]?\d+|\d+[+-]?|[+-])?$/.test(valueNoComment)) {
      if (key === 'description') descriptionIndicator = valueNoComment;
      inBlockScalar = true;
      blockScalarIndent = rawLine.match(/^(\s*)/)[1].length;
    }
  }

  return { values, descriptionIndicator };
}

// ---- validation ------------------------------------------------------------

const errors = [];
const warnings = [];

function err(loc, msg) { errors.push(`ERROR  ${loc}  ${msg}`); }

function validateSkillDir(dir) {
  const rel = path.join('skills', dir, 'SKILL.md');
  const skillMd = path.join(SKILLS_DIR, dir, 'SKILL.md');

  if (!fs.existsSync(skillMd) || !fs.statSync(skillMd).isFile()) {
    err(path.join('skills', dir), 'missing SKILL.md');
    return false;
  }

  let content;
  try {
    content = fs.readFileSync(skillMd, 'utf-8');
  } catch (e) {
    err(rel, `unreadable: ${e.message}`);
    return false;
  }
  if (content.trim().length === 0) {
    err(rel, 'empty SKILL.md');
    return false;
  }

  const fm = extractFrontmatter(content);
  if (!fm.present) {
    err(`${rel}:1`, 'missing YAML frontmatter (--- ... --- block)');
    return false;
  }

  const { values, descriptionIndicator } = inspectFrontmatter(fm.lines);

  for (const field of ['name', 'description']) {
    if (!Object.prototype.hasOwnProperty.call(values, field)) {
      err(rel, `frontmatter missing required field: ${field}`);
    } else if (values[field] === '') {
      err(rel, `frontmatter '${field}' is empty`);
    }
  }

  if (descriptionIndicator && descriptionIndicator.startsWith('|')) {
    err(
      rel,
      `frontmatter description uses literal block scalar '${descriptionIndicator}' ` +
        `which preserves internal newlines; use an inline string or folded '>' scalar instead`
    );
  }

  return true;
}

function main() {
  if (!fs.existsSync(SKILLS_DIR) || !fs.statSync(SKILLS_DIR).isDirectory()) {
    console.log('no skills found (skills/ absent) — nothing to validate');
    process.exit(0);
  }

  const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort();

  if (dirs.length === 0) {
    console.log('no skills found (skills/ empty) — nothing to validate');
    process.exit(0);
  }

  let validCount = 0;
  for (const dir of dirs) {
    if (validateSkillDir(dir)) validCount++;
  }

  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `validate-skills: ${dirs.length} skill dir(s), ${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'PASS'}`
  );
  process.exit(failed ? 1 : 0);
}

main();
