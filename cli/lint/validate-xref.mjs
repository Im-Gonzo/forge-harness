#!/usr/bin/env node
/**
 * validate-xref — the highest-value Forge self-validator.
 *
 * Scans ALL Forge `.md` files (docs/, README, schemas/README, and any
 * agents/skills/commands/rules once populated) and verifies that
 * cross-references resolve to real files:
 *
 *   (a) every relative markdown link  `](./x)` / `](../x)`  resolves to a
 *       real file or directory (relative to the linking file);
 *   (b) every inline `` `/command-name` `` reference resolves to a
 *       `commands/<command-name>.md`  — SKIPPED entirely while commands/ is
 *       empty/absent (Phase 2: these are legitimate forward references);
 *   (c) any `agents/x.md` textual reference resolves to that file, and any
 *       `skills/y/` reference resolves to a skill dir — each SKIPPED while
 *       its asset dir is empty/absent.
 *
 * Fenced code blocks (``` ... ``` and ~~~ ... ~~~) are stripped before
 * scanning to avoid false positives from examples/templates. Inline code
 * spans are preserved because that is where `/command` refs live.
 *
 * This fixes the exact defect class found in the v2 harness: broken
 * cross-references that no linter caught.
 *
 * Invocation: node lint/validate-xref.mjs [--strict] [rootDir]
 * Broken references are ERRORS (exit 1). Zero dependencies; self-contained.
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

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);

// Design-stage spec corpora and synthetic test fixtures that INTENTIONALLY
// reference planned commands / fake agents are excluded by relative path. They
// are not shippable harness assets: the corpus's cross-references are ID-based
// and verified separately, and fixtures are deliberately fake harness trees.
// This is consistent with this validator's existing treatment of not-yet-
// populated asset classes as "legitimate forward references".
const SKIP_RELDIRS = new Set([
  path.join('docs', 'manager'),
  path.join('tests', 'manager', 'fixtures'),
]);

// ---- discovery -------------------------------------------------------------

/** Recursively collect all *.md files under dir (absolute paths), skipping
 *  generated/vendored trees. */
function collectMd(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_RELDIRS.has(path.relative(ROOT, abs))) continue;
      out.push(...collectMd(abs));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(abs);
    }
  }
  return out;
}

/** True if dir exists, is a directory, and contains at least one entry of
 *  interest (so an empty asset class is treated as "not yet populated"). */
function dirHasEntries(dir, predicate) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    return fs.readdirSync(dir, { withFileTypes: true }).some(predicate);
  } catch {
    return false;
  }
}

const COMMANDS_DIR = path.join(ROOT, 'commands');
const AGENTS_DIR = path.join(ROOT, 'agents');
const SKILLS_DIR = path.join(ROOT, 'skills');

const COMMANDS_POPULATED = dirHasEntries(COMMANDS_DIR, e => e.isFile() && e.name.endsWith('.md'));
const AGENTS_POPULATED = dirHasEntries(AGENTS_DIR, e => e.isFile() && e.name.endsWith('.md'));
const SKILLS_POPULATED = dirHasEntries(SKILLS_DIR, e => e.isDirectory() && !e.name.startsWith('.'));

const validCommands = new Set();
if (COMMANDS_POPULATED) {
  for (const f of fs.readdirSync(COMMANDS_DIR)) {
    if (f.endsWith('.md')) validCommands.add(f.replace(/\.md$/, ''));
  }
}
const validAgents = new Set();
if (AGENTS_POPULATED) {
  for (const f of fs.readdirSync(AGENTS_DIR)) {
    if (f.endsWith('.md')) validAgents.add(f.replace(/\.md$/, ''));
  }
}
const validSkills = new Set();
if (SKILLS_POPULATED) {
  for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) validSkills.add(e.name);
  }
}

// ---- text processing -------------------------------------------------------

/**
 * Replace fenced code blocks (``` or ~~~) with blank lines of equal count so
 * that line numbers are preserved for accurate finding locations.
 * Inline code spans (single backticks) are intentionally kept.
 * @param {string} content
 * @returns {string}
 */
function stripFencedCodeBlocks(content) {
  const lines = content.split('\n');
  const out = [];
  let fence = null; // the active fence marker (``` or ~~~)
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      out.push(''); // blanked code-block line
      if (m && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (m) {
      fence = m[1].slice(0, 3); // ``` or ~~~
      out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// ---- validation ------------------------------------------------------------

const errors = [];
const warnings = [];

function err(loc, msg) { errors.push(`ERROR  ${loc}  ${msg}`); }

const files = collectMd(ROOT).sort();

for (const abs of files) {
  const rel = path.relative(ROOT, abs);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf-8');
  } catch (e) {
    err(rel, `unreadable: ${e.message}`);
    continue;
  }
  const content = stripFencedCodeBlocks(raw);
  const docLines = content.split('\n');
  const fileDir = path.dirname(abs);

  for (let i = 0; i < docLines.length; i++) {
    const line = docLines[i];
    const lineNo = i + 1;

    // (a) relative markdown links: ](./x) or ](../x)
    //     Capture target up to ) , ignoring an optional "#anchor" / title.
    const linkRe = /\]\((\.{1,2}\/[^)\s#]+)(?:#[^)\s]*)?(?:\s+["'][^)]*["'])?\)/g;
    let lm;
    while ((lm = linkRe.exec(line)) !== null) {
      const target = decodeURIComponent(lm[1]);
      const resolved = path.resolve(fileDir, target);
      if (!fs.existsSync(resolved)) {
        err(`${rel}:${lineNo}`, `broken relative link -> ${target}`);
      }
    }

    // (b) inline `/command-name` references — only when commands/ populated.
    if (COMMANDS_POPULATED) {
      // skip lines describing hypothetical output (e.g. "Creates: `/new-table`")
      if (!/creates:|would create:/i.test(line)) {
        const cmdRe = /`\/([a-z][-a-z0-9]*)`/g;
        let cm;
        while ((cm = cmdRe.exec(line)) !== null) {
          const name = cm[1];
          if (!validCommands.has(name)) {
            err(`${rel}:${lineNo}`, `references non-existent command /${name}`);
          }
        }
      }
    }

    // (c1) agents/x.md textual references — only when agents/ populated.
    if (AGENTS_POPULATED) {
      const agentRe = /agents\/([a-z][-a-z0-9]*)\.md/g;
      let am;
      while ((am = agentRe.exec(line)) !== null) {
        const name = am[1];
        if (!validAgents.has(name) && !fs.existsSync(path.join(AGENTS_DIR, `${name}.md`))) {
          err(`${rel}:${lineNo}`, `references non-existent agent agents/${name}.md`);
        }
      }
    }

    // (c2) skills/y/ textual references — only when skills/ populated.
    if (SKILLS_POPULATED) {
      const skillRe = /skills\/([a-z][-a-z0-9]*)\//g;
      let sm;
      while ((sm = skillRe.exec(line)) !== null) {
        const name = sm[1];
        if (!validSkills.has(name)) {
          err(`${rel}:${lineNo}`, `references non-existent skill dir skills/${name}/`);
        }
      }
    }
  }
}

for (const line of errors) console.error(line);
for (const line of warnings) console.warn(line);

const skipped = [];
if (!COMMANDS_POPULATED) skipped.push('commands');
if (!AGENTS_POPULATED) skipped.push('agents');
if (!SKILLS_POPULATED) skipped.push('skills');

const failed = errors.length > 0 || (STRICT && warnings.length > 0);
const skipNote = skipped.length ? ` (skipped empty asset classes: ${skipped.join(', ')})` : '';
console.log(
  `validate-xref: scanned ${files.length} markdown file(s), ${errors.length} error(s), ${warnings.length} warning(s)${skipNote} — ${failed ? 'FAIL' : 'PASS'}`
);
process.exit(failed ? 1 : 0);
