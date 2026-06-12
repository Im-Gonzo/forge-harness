#!/usr/bin/env node
/**
 * validate-memory-integrity — guard a project's curated memory vault.
 *
 * Operationalizes docs/METHOD.md §8 (confidence-scored, evidence-backed,
 * curated memory). It validates a populated memory directory's integrity:
 *
 *   - [[wiki links]] in entry bodies resolve to a real entry (by id or path);
 *   - each entry's `type` matches the directory it lives in (decisions/ →
 *     decision, gotchas/ → gotcha, …) — the type<->dir invariant;
 *   - required frontmatter is present & well-formed:
 *       id, title, type, status, created, updated, confidence
 *     plus value sanity (type/status enums, ISO-ish dates, confidence 0–1,
 *     id-prefix matches type);
 *   - the index lists exactly the `active` entries (freshness): every active
 *     entry appears, and no superseded/deprecated entry leaks in.
 *
 * WHAT IT TARGETS — a project's living vault, discovered as (first hit wins):
 *     <root>/.claude/memory/   then   <root>/memory/
 *   It NEVER validates Forge's own `bootstrap/templates/memory/*.tmpl`
 *   (those are the seed schema, not real entries). Absence of a memory dir
 *   is NOT an error: running on the Forge repo (templates only) PASSES.
 *
 * Invocation: node lint/validate-memory-integrity.mjs [--strict] [rootDir]
 *   default rootDir = the Forge repo root (resolved from this file's URL).
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

// ---- domain constants ------------------------------------------------------

// type -> directory it must live in (type<->dir invariant).
const TYPE_TO_DIR = {
  decision: 'decisions',
  glossary: 'glossary',
  gotcha: 'gotchas',
  learning: 'learnings',
  runbook: 'runbooks',
};
const DIR_TO_TYPE = Object.fromEntries(
  Object.entries(TYPE_TO_DIR).map(([t, d]) => [d, t])
);
const MEMORY_DIRS = new Set(Object.values(TYPE_TO_DIR));

// type -> id prefix (advisory: a mismatch is a WARNING, not a hard error,
// because ids are author-assigned and the type<->dir check is the real guard).
const TYPE_TO_PREFIX = {
  decision: 'd-',
  glossary: 'gt-',
  gotcha: 'g-',
  learning: 'l-',
  runbook: 'rb-',
};

const VALID_TYPES = new Set(Object.keys(TYPE_TO_DIR));
const VALID_STATUS = new Set(['active', 'superseded', 'deprecated']);
const REQUIRED_KEYS = ['id', 'title', 'type', 'status', 'created', 'updated', 'confidence'];

const SKIP_DIRS = new Set(['node_modules', '.git']);

// ---- findings --------------------------------------------------------------

const errors = [];
const warnings = [];
function err(loc, msg) { errors.push(`ERROR  ${loc}  ${msg}`); }
function warn(loc, msg) { warnings.push(`WARN   ${loc}  ${msg}`); }

// ---- memory-dir discovery --------------------------------------------------

/** Find the project's living memory dir, or null. Templates are never it. */
function findMemoryDir(root) {
  const candidates = [
    path.join(root, '.claude', 'memory'),
    path.join(root, 'memory'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch { /* not present — try next */ }
  }
  return null;
}

// ---- collection ------------------------------------------------------------

/** Recursively collect *.md entry files under the memory dir (absolute).
 *  Excludes the index file itself and any *.tmpl/templates trees. */
function collectEntries(memDir, indexAbs) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      // Never treat template seed dirs/files as real entries.
      if (e.name === 'templates') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        if (abs === indexAbs) continue;
        out.push(abs);
      }
    }
  }
  walk(memDir);
  return out.sort();
}

// ---- tiny frontmatter parser (self-contained, no shared lib) ---------------

/**
 * Extract leading YAML frontmatter. Tolerant of a BOM and CRLF.
 * @param {string} content
 * @returns {{present: boolean, raw: string, lines: string[]}}
 */
function extractFrontmatter(content) {
  const clean = content.replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { present: false, raw: '', lines: [] };
  return { present: true, raw: match[1], lines: match[1].split(/\r?\n/) };
}

/**
 * Parse top-level scalar keys from frontmatter lines. Nested/indented lines
 * (e.g. under `links:`) are skipped — we only need the scalar required keys.
 * Strips inline `# comments` and surrounding quotes. Block scalars are not
 * expected for these keys; if one appears its body lines are skipped.
 * @param {string[]} lines
 * @returns {Record<string,string>}
 */
function parseScalars(lines) {
  const values = Object.create(null);
  let inBlockScalar = false;
  let blockIndent = -1;

  for (const rawLine of lines) {
    if (inBlockScalar) {
      const lead = rawLine.match(/^(\s*)/)[1].length;
      if (rawLine.trim() === '' || lead > blockIndent) continue;
      inBlockScalar = false;
      blockIndent = -1;
    }
    // Only top-level keys (no leading whitespace).
    if (/^\s/.test(rawLine)) continue;
    const m = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    // strip a trailing inline comment (best-effort; ids/dates have no '#')
    val = val.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
    // block scalar indicator -> capture nothing, skip its body
    if (/^[|>](?:[+-]?\d+|\d+[+-]?|[+-])?$/.test(val)) {
      inBlockScalar = true;
      blockIndent = rawLine.match(/^(\s*)/)[1].length;
      values[key] = '';
      continue;
    }
    val = val.replace(/^["']|["']$/g, '');
    values[key] = val;
  }
  return values;
}

/** Strip fenced code blocks so [[links]] inside examples don't count. */
function stripFences(body) {
  return body
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '');
}

/** Extract [[wiki link]] targets from a body (fences stripped). */
function extractWikiLinks(body) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.push(target);
  }
  return out;
}

// ---- validation ------------------------------------------------------------

function isIsoishDate(s) {
  // Accept YYYY-MM-DD optionally followed by a time component.
  return /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s);
}

function main() {
  const memDir = findMemoryDir(ROOT);

  // Absence of a memory dir is NOT an error (e.g. the Forge repo: templates only).
  if (!memDir) {
    console.log('validate-memory-integrity: no memory dir (.claude/memory or memory/) — nothing to validate — PASS');
    process.exit(0);
  }

  const indexAbs = path.join(memDir, 'index.md');
  const hasIndex = (() => {
    try { return fs.statSync(indexAbs).isFile(); } catch { return false; }
  })();

  const entryFiles = collectEntries(memDir, indexAbs);

  if (entryFiles.length === 0) {
    // A memory dir that holds no entries yet is a valid empty vault.
    console.log(`validate-memory-integrity: ${path.relative(ROOT, memDir) || memDir} present, 0 entries — nothing to validate — PASS`);
    process.exit(0);
  }

  // Parse every entry once; build the id index for link resolution + index check.
  const entries = []; // { rel, abs, fm, body, id, type, status, dirName }
  const idToEntry = new Map();
  const relToEntry = new Map();

  for (const abs of entryFiles) {
    const rel = path.relative(ROOT, abs);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch (e) {
      err(rel, `unreadable: ${e.message}`);
      continue;
    }
    if (content.trim().length === 0) {
      err(rel, 'empty memory entry');
      continue;
    }
    const fmRes = extractFrontmatter(content);
    if (!fmRes.present) {
      err(`${rel}:1`, 'missing YAML frontmatter (--- ... --- block)');
      continue;
    }
    const fm = parseScalars(fmRes.lines);
    const body = stripFences(content.slice(content.indexOf('---', 3) + 3));
    const dirName = path.basename(path.dirname(abs));

    const entry = {
      rel, abs, fm, body,
      id: fm.id || '',
      type: fm.type || '',
      status: fm.status || '',
      dirName,
    };
    entries.push(entry);
    relToEntry.set(rel, entry);

    // ---- required frontmatter keys ----
    for (const key of REQUIRED_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(fm, key)) {
        err(rel, `frontmatter missing required key: ${key}`);
      } else if (fm[key] === '') {
        err(rel, `frontmatter '${key}' is empty`);
      }
    }

    // ---- value sanity ----
    if (fm.type && !VALID_TYPES.has(fm.type)) {
      err(rel, `invalid type '${fm.type}' (expected one of: ${[...VALID_TYPES].join(', ')})`);
    }
    if (fm.status && !VALID_STATUS.has(fm.status)) {
      err(rel, `invalid status '${fm.status}' (expected one of: ${[...VALID_STATUS].join(', ')})`);
    }
    if (fm.created && !isIsoishDate(fm.created)) {
      err(rel, `'created' is not an ISO date (YYYY-MM-DD): ${fm.created}`);
    }
    if (fm.updated && !isIsoishDate(fm.updated)) {
      err(rel, `'updated' is not an ISO date (YYYY-MM-DD): ${fm.updated}`);
    }
    if (fm.confidence !== undefined && fm.confidence !== '') {
      const c = Number(fm.confidence);
      if (!Number.isFinite(c) || c < 0 || c > 1) {
        err(rel, `'confidence' must be a number in [0, 1]: ${fm.confidence}`);
      }
    }

    // ---- type <-> dir invariant ----
    if (fm.type && VALID_TYPES.has(fm.type)) {
      const expectedDir = TYPE_TO_DIR[fm.type];
      if (MEMORY_DIRS.has(dirName)) {
        if (dirName !== expectedDir) {
          err(rel, `type '${fm.type}' must live in '${expectedDir}/', but file is in '${dirName}/'`);
        }
      } else if (DIR_TO_TYPE[dirName] === undefined) {
        // entry sits in a non-type dir (e.g. memory/ root) — warn, don't fail.
        warn(rel, `entry is not under a recognized type dir (${[...MEMORY_DIRS].join('/')}); type<->dir not enforced`);
      }
    }
    // dir that maps to a type but holds a mismatching/absent type
    if (DIR_TO_TYPE[dirName] !== undefined && fm.type && fm.type !== DIR_TO_TYPE[dirName]) {
      // already reported above via expectedDir check unless type invalid; guard dup
      if (VALID_TYPES.has(fm.type) && TYPE_TO_DIR[fm.type] === dirName) {
        /* consistent */
      }
    }

    // ---- id prefix advisory ----
    if (fm.id && fm.type && TYPE_TO_PREFIX[fm.type]) {
      const pfx = TYPE_TO_PREFIX[fm.type];
      if (!fm.id.startsWith(pfx)) {
        warn(rel, `id '${fm.id}' does not use the '${pfx}' prefix conventional for type '${fm.type}'`);
      }
    }

    // ---- dated Evidence section (METHOD §4/§8) ----
    if (!/(^|\n)\s*#{1,6}\s+Evidence\b/i.test(body)) {
      warn(rel, "no '## Evidence' section — entries should carry dated proof (docs/METHOD.md §4, §8)");
    }

    // ---- register id ----
    if (fm.id) {
      if (idToEntry.has(fm.id)) {
        err(rel, `duplicate id '${fm.id}' (also in ${idToEntry.get(fm.id).rel})`);
      } else {
        idToEntry.set(fm.id, entry);
      }
    }
  }

  // ---- [[link]] resolution ----
  // A link resolves if it matches an entry id, or a path (with/without .md)
  // relative to the linking file or to the memory dir.
  const knownBasenames = new Map(); // basename(no ext) -> entry
  for (const e of entries) {
    knownBasenames.set(path.basename(e.abs, '.md'), e);
  }
  for (const e of entries) {
    const links = extractWikiLinks(e.body);
    for (const target of links) {
      if (idToEntry.has(target)) continue;
      // try as a path
      const noExt = target.replace(/\.md$/, '');
      const base = path.basename(noExt);
      if (knownBasenames.has(base)) continue;
      const candidates = [
        path.resolve(path.dirname(e.abs), `${noExt}.md`),
        path.resolve(memDir, `${noExt}.md`),
      ];
      const resolved = candidates.some(c => {
        try { return fs.statSync(c).isFile(); } catch { return false; }
      });
      if (!resolved) {
        err(e.rel, `unresolved [[link]] '${target}' (no entry id, file, or basename match)`);
      }
    }
  }

  // ---- index freshness ----
  const activeEntries = entries.filter(e => e.status === 'active');
  if (!hasIndex) {
    if (activeEntries.length > 0) {
      err(path.relative(ROOT, memDir) || memDir, `index.md is missing but ${activeEntries.length} active entr${activeEntries.length === 1 ? 'y exists' : 'ies exist'} — the recall index must exist and be fresh`);
    }
  } else {
    let indexContent = '';
    try {
      indexContent = fs.readFileSync(indexAbs, 'utf-8');
    } catch (e) {
      err(path.relative(ROOT, indexAbs), `unreadable index: ${e.message}`);
    }
    if (indexContent) {
      const indexRel = path.relative(ROOT, indexAbs);
      // Every active entry's id must appear in the index.
      for (const e of activeEntries) {
        if (e.id && !indexContent.includes(e.id)) {
          err(indexRel, `active entry '${e.id}' (${e.rel}) is missing from the index — regenerate it (curate-memory)`);
        }
      }
      // No retired entry's id should appear in the index.
      for (const e of entries) {
        if (e.status && e.status !== 'active' && e.id && indexContent.includes(e.id)) {
          err(indexRel, `${e.status} entry '${e.id}' still listed in the index — only 'active' entries belong (curate-memory)`);
        }
      }
    }
  }

  // ---- report ----
  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  const where = path.relative(ROOT, memDir) || memDir;
  console.log(
    `validate-memory-integrity: ${where} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ` +
    `${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'PASS'}`
  );
  process.exit(failed ? 1 : 0);
}

main();
