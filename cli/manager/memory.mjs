// @ts-check
/**
 * memory — the manager's curated-memory-vault operator (docs/METHOD.md §8).
 *
 * A project's living memory vault is a set of confidence-scored, evidence-backed
 * markdown entries under `<project>/.claude/memory/` (or `<project>/memory/`),
 * grouped into type dirs (decisions/ glossary/ gotchas/ learnings/ runbooks/),
 * recalled through a single `index.md`. This module READS, VALIDATES, REINDEXES,
 * and IMPORTS that vault — it never spends a model call and never mutates outside
 * the discovered memory dir.
 *
 * The contracts this module is glued to (and MUST keep producing/accepting):
 *   - lint/validate-memory-integrity.mjs — the TYPE_TO_DIR map, the frontmatter
 *     scalar shape, the [[wiki link]] edge model, and the index-freshness rule
 *     (every `active` id appears in index.md; no retired id does). `reindex`
 *     GENERATES an index this validator accepts; `validate` re-runs its checks.
 *   - bootstrap/templates/memory/index.md.tmpl — the EXACT index layout reindex
 *     emits (title, blockquote preamble, the five `## <type>` sections, one
 *     `- id — title — hook` line per active entry id-ordered, or the
 *     `*(none yet — …)*` placeholder when a section is empty).
 *   - bootstrap/templates/memory/entry.md.tmpl — the entry frontmatter schema an
 *     `import` writes (id/title/type/status/created/updated/confidence/tags/…).
 *
 * THE BODY IS THE SINGLE EDGE SOURCE (per decision): inter-entry edges live ONLY
 * as `[[wiki links]]` in entry bodies. An `import` therefore PRESERVES body wiki
 * links and DROPS any foreign frontmatter `links:` map — never re-encoding edges
 * into frontmatter.
 *
 * DETERMINISM: every write this module performs is a pure function of its inputs.
 * Timestamps come from an explicit `--now <iso>` flag or a fixed placeholder
 * string — NEVER `Date.now()`/`new Date()`/`Math.random()`. Given the same source
 * vault and the same flags, `reindex`/`import` produce byte-identical output (so
 * the eval oracle can recompute them). This intentionally departs from fleet.mjs'
 * `nowIso()` clock: the memory writers are content generators, not observers.
 *
 * HARD INVARIANTS (the plugin payload contract): zero runtime deps (node:
 * builtins + relative imports only); additive-never-destructive (`import` NEVER
 * overwrites an existing entry); writers DRY-RUN by default (`reindex`/`import`
 * preview unless `--write`/`--apply`); fail-open (no public entry throws past its
 * surface — it degrades to a safe `{ok,data,findings,summary}` envelope). Dual-
 * mode with an `isMain()` guard — NEVER process.exit() at import time.
 *
 * Subcommands (C4 `run(subcmd, args, ctx)`):
 *   - `list`              — enumerate vault entries → data.entries[].
 *   - `validate`          — run the memory-integrity checks → findings.
 *   - `reindex [--write]` — GENERATE index.md from active entries; default
 *                           previews into data.index, --write persists it.
 *   - `import <srcDir> [--apply]` — map a foreign vault (e.g. Claude Code auto-
 *                           memory) into forge-schema entries; default previews
 *                           data.plan, --apply writes the new files (additive).
 *
 * @module manager/memory
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeFinding, parseFindings } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';

// ---------------------------------------------------------------------------
// Constants — mirrors lint/validate-memory-integrity.mjs (the contract source)
// ---------------------------------------------------------------------------

/** The emitter stamped on findings this module raises (C2 `source`). */
const SOURCE = 'memory';

/** type -> directory it must live in (the type<->dir invariant). */
const TYPE_TO_DIR = {
  decision: 'decisions',
  glossary: 'glossary',
  gotcha: 'gotchas',
  learning: 'learnings',
  runbook: 'runbooks',
};
/** Ordered type list (the order reindex emits its `## <type>` sections in). */
const TYPE_ORDER = ['decision', 'glossary', 'gotcha', 'learning', 'runbook'];
/** dir name -> type (reverse of TYPE_TO_DIR). */
const DIR_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_DIR).map(([t, d]) => [d, t]));
/** type -> conventional id prefix (used to mint ids on import). */
const TYPE_TO_PREFIX = {
  decision: 'd-',
  glossary: 'gt-',
  gotcha: 'g-',
  learning: 'l-',
  runbook: 'rb-',
};
const VALID_TYPES = new Set(Object.keys(TYPE_TO_DIR));

/** Per-type "*(none yet — …)*" placeholder lines (verbatim from index.md.tmpl). */
const NONE_PLACEHOLDER = {
  decision: '*(none yet — record in-practice choices here; entry type `decision`, dir `decisions/`)*',
  glossary: '*(none yet — durable domain vocabulary; entry type `glossary`, dir `glossary/`)*',
  gotcha: '*(none yet — sharp edges that bit us and how we guard them; entry type `gotcha`, dir `gotchas/`)*',
  learning: '*(none yet — distilled insights worth keeping; entry type `learning`, dir `learnings/`)*',
  runbook: '*(none yet — machine/operational procedures; entry type `runbook`, dir `runbooks/`)*',
};

/** Directory names entry collection never descends into. */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** The fixed, deterministic timestamp placeholder when no `--now` is given. */
const DEFAULT_NOW = '1970-01-01';

/** Default confidence stamped on an imported entry (matches entry.md.tmpl). */
const DEFAULT_CONFIDENCE = 0.5;

// ---------------------------------------------------------------------------
// Memory-dir discovery (mirrors validate-memory-integrity.mjs#findMemoryDir)
// ---------------------------------------------------------------------------

/**
 * Find a project's living memory dir — `<root>/.claude/memory` then `<root>/memory`
 * (first hit wins). Returns null when neither exists. Fail-open. Templates are never it.
 * @param {string} root @returns {string|null}
 */
function findMemoryDir(root) {
  const candidates = [path.join(root, '.claude', 'memory'), path.join(root, 'memory')];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* not present — try next */
    }
  }
  return null;
}

/** The directory `reindex --write` / `import --apply` would CREATE when none exists yet. */
function defaultMemoryDir(root) {
  return path.join(root, '.claude', 'memory');
}

// ---------------------------------------------------------------------------
// Entry collection + frontmatter parsing (mirrors the validator's tolerance)
// ---------------------------------------------------------------------------

/**
 * Recursively collect `*.md` entry files under the memory dir (absolute), excluding
 * index.md, any `templates` tree, and node_modules/.git. Sorted for determinism.
 * @param {string} memDir @param {string} indexAbs @returns {string[]}
 */
function collectEntryFiles(memDir, indexAbs) {
  const out = [];
  walk(memDir);
  return out.sort();
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
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
}

/**
 * Extract leading YAML frontmatter. Tolerant of a BOM and CRLF. Returns the raw
 * block + its split lines (mirrors validate-memory-integrity.mjs).
 * @param {string} content @returns {{present:boolean, raw:string, lines:string[], body:string}}
 */
function extractFrontmatter(content) {
  const clean = content.replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { present: false, raw: '', lines: [], body: clean };
  const body = clean.slice(match[0].length);
  return { present: true, raw: match[1], lines: match[1].split(/\r?\n/), body };
}

/**
 * Parse top-level scalar frontmatter keys (skips nested/indented lines — e.g. a
 * `links:` map — and block scalars). Strips inline comments + surrounding quotes.
 * Byte-for-byte the validator's parser so a stamp here passes a check there.
 * @param {string[]} lines @returns {Record<string,string>}
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
    if (/^\s/.test(rawLine)) continue; // only top-level keys
    const m = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    val = val.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
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

/**
 * Parse one entry file into a normalized record (fail-open: an unreadable/torn file
 * degrades to a record with empty fields, never a throw).
 * @param {string} abs @param {string} memDir @returns {object}
 */
function parseEntry(abs, memDir) {
  const rel = path.relative(memDir, abs);
  let content = '';
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    content = '';
  }
  const fmRes = extractFrontmatter(content);
  const fm = fmRes.present ? parseScalars(fmRes.lines) : Object.create(null);
  const dirName = path.basename(path.dirname(abs));
  return {
    abs,
    rel,
    dirName,
    body: fmRes.body,
    fm,
    id: typeof fm.id === 'string' ? fm.id : '',
    title: typeof fm.title === 'string' ? fm.title : '',
    type: typeof fm.type === 'string' ? fm.type : DIR_TO_TYPE[dirName] || '',
    status: typeof fm.status === 'string' ? fm.status : '',
    confidence: fm.confidence !== undefined && fm.confidence !== '' ? Number(fm.confidence) : null,
  };
}

/** Load + parse every entry under a memory dir (sorted). */
function loadEntries(memDir) {
  const indexAbs = path.join(memDir, 'index.md');
  return collectEntryFiles(memDir, indexAbs).map((abs) => parseEntry(abs, memDir));
}

// ---------------------------------------------------------------------------
// Hook extraction (the index's third column) + the index generator
// ---------------------------------------------------------------------------

/**
 * Derive the one-line "hook" for an entry's index line: the first non-blank prose
 * line of its `## Summary` section, else the first non-blank, non-heading,
 * non-HTML-comment prose line of the body. Collapsed to a single line. Empty when
 * the body has no prose. Pure + deterministic.
 * @param {string} body @returns {string}
 */
function deriveHook(body) {
  const lines = String(body || '').split(/\r?\n/);
  // Prefer the first prose line under a `## Summary` heading.
  let inSummary = false;
  for (const raw of lines) {
    const line = raw.trim();
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      inSummary = /^summary\b/i.test(h[1].trim());
      continue;
    }
    if (inSummary) {
      if (!line || line.startsWith('<!--')) continue;
      return collapse(line);
    }
  }
  // Fallback: first prose line anywhere in the body.
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) continue; // heading
    if (line.startsWith('<!--')) continue; // HTML comment
    if (line.startsWith('---')) continue; // stray rule
    return collapse(line);
  }
  return '';
}

/** Collapse internal whitespace to single spaces and trim (single-line hook). */
function collapse(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * GENERATE the index.md content from the vault's ACTIVE entries, in the EXACT
 * layout of bootstrap/templates/memory/index.md.tmpl: the title, the blockquote
 * preamble, then the five `## <type>` sections (TYPE_ORDER), each listing its
 * active entries as `- id — title — hook` ordered by id ascending, or the
 * per-type `*(none yet — …)*` placeholder when empty.
 *
 * The generated index MUST satisfy validate-memory-integrity's freshness rule:
 * every active id appears; no retired id appears (retired entries are filtered
 * out here, so their ids can never leak in).
 *
 * Pure: same entries + same `projectName` ⇒ byte-identical output.
 *
 * @param {object[]} entries parsed entry records.
 * @param {{projectName?:string}} [opts]
 * @returns {string} the full index.md text (trailing newline).
 */
function generateIndex(entries, opts = {}) {
  const projectName = typeof opts.projectName === 'string' && opts.projectName ? opts.projectName : 'project';
  const active = entries.filter((e) => e.status === 'active');

  const out = [];
  out.push(`# Memory Vault Index — ${projectName}`);
  out.push('');
  out.push(
    '> The **only** file loaded to decide what to recall. One line per `active` entry: `id — title — hook`. Grouped by type, ordered by id ascending. Match a task by module / rule family / invariant / work-type tags + a keyword grep, then open the 1–4 hit files — never bulk-load. Superseded/deprecated entries drop out of this index but stay on disk. Generated from entry frontmatter (`memory/<type>/*.md`); do not hand-edit drift in.',
  );
  out.push('>');
  out.push(
    "> **Recall trust rule (`docs/METHOD.md` §4, §8):** an entry reflects when it was *written* (`created` in its frontmatter) and carries a `confidence` (0–1) + a dated `## Evidence` section. It is a **pointer to verify against live code**, never authoritative on its own. Confidence rises on recurrence without correction, falls on contradiction. Prefer a small set of accurate entries over bulk-generated, duplicated, or contradictory ones.",
  );
  out.push('>');
  out.push('> Generated by `forge memory reindex` from entry frontmatter. New entries use `memory/entry.md` as the schema.');

  for (const type of TYPE_ORDER) {
    const dir = TYPE_TO_DIR[type];
    out.push('');
    out.push(`## ${dir}`);
    out.push('');
    const ofType = active
      .filter((e) => e.type === type)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (ofType.length === 0) {
      out.push(NONE_PLACEHOLDER[type]);
      continue;
    }
    for (const e of ofType) {
      const title = e.title || '(untitled)';
      const hook = deriveHook(e.body);
      out.push(hook ? `- ${e.id} — ${title} — ${hook}` : `- ${e.id} — ${title}`);
    }
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Import: map a foreign vault into forge-schema entries
// ---------------------------------------------------------------------------

/**
 * Extract `[[wiki link]]` targets from a body (so a preview can report preserved
 * edges). Bodies are copied VERBATIM on import — this is reporting only.
 * @param {string} body @returns {string[]}
 */
function extractWikiLinks(body) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(String(body || ''))) !== null) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.push(target);
  }
  return out;
}

/** Slugify a title into a filename-safe slug (deterministic; ascii-ish). */
function slugify(s) {
  const base = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'entry';
}

/** YAML-safe single-line scalar (quote when it could be mis-parsed). */
function yamlScalar(s) {
  const v = String(s == null ? '' : s);
  if (v === '') return "''";
  if (/^[A-Za-z0-9 _.\-/§()]+$/.test(v) && !/^\s|\s$/.test(v)) return v;
  return JSON.stringify(v); // double-quoted form is valid YAML for our subset
}

/**
 * Render one forge-schema entry file (frontmatter + preserved body) for an import.
 * DROPS any foreign frontmatter `links:` map — body `[[wiki links]]` are the only
 * edge source. Deterministic given its inputs.
 *
 * @param {{id:string,title:string,type:string,confidence:number,created:string,updated:string,source:string,body:string}} e
 * @returns {string}
 */
function renderEntryFile(e) {
  const fm = [
    '---',
    `id: ${yamlScalar(e.id)}`,
    `title: ${yamlScalar(e.title)}`,
    `type: ${e.type}`,
    'status: active',
    `created: ${yamlScalar(e.created)}`,
    `updated: ${yamlScalar(e.updated)}`,
    `confidence: ${e.confidence}`,
    'tags: []',
    `source: ${yamlScalar(e.source)}`,
    '---',
  ].join('\n');
  // Preserve the foreign body verbatim; ensure a separating blank line.
  const body = String(e.body || '').replace(/^\n+/, '');
  return `${fm}\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

/**
 * Read a foreign vault's entries (e.g. Claude Code auto-memory whose frontmatter is
 * `{name, description, metadata.type}`). We reuse our tolerant scalar parser, so
 * `name`/`description` come through as scalars; `metadata.type` (nested) is read
 * with a targeted scan since parseScalars skips indented lines.
 *
 * @param {string} srcDir @returns {object[]} foreign entry records (sorted by abs).
 */
function loadForeignEntries(srcDir) {
  const out = [];
  walk(srcDir);
  return out.sort((a, b) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0));
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        if (e.name === 'index.md') continue;
        out.push(readForeign(abs, dir));
      }
    }
  }
  function readForeign(abs, dir) {
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      content = '';
    }
    const fmRes = extractFrontmatter(content);
    const fm = fmRes.present ? parseScalars(fmRes.lines) : Object.create(null);
    return {
      abs,
      dir,
      base: path.basename(abs, '.md'),
      fm,
      body: fmRes.body,
      name: typeof fm.name === 'string' ? fm.name : '',
      description: typeof fm.description === 'string' ? fm.description : '',
      metaType: readMetadataType(fmRes.lines),
    };
  }
}

/**
 * Read a nested `metadata: { type: <t> }` from frontmatter lines (parseScalars
 * skips indented lines, so a targeted scan is needed). Also accepts a flat
 * `metadata.type: <t>`. Returns '' when absent.
 * @param {string[]} lines @returns {string}
 */
function readMetadataType(lines) {
  let inMetadata = false;
  for (const raw of lines) {
    const flat = raw.match(/^metadata\.type:\s*(.*)$/);
    if (flat) return cleanScalar(flat[1]);
    if (/^metadata:\s*$/.test(raw)) {
      inMetadata = true;
      continue;
    }
    if (inMetadata) {
      if (/^\S/.test(raw)) {
        inMetadata = false; // dedented out of the metadata block
        continue;
      }
      const m = raw.match(/^\s+type:\s*(.*)$/);
      if (m) return cleanScalar(m[1]);
    }
  }
  return '';
}

/** Trim inline comment + surrounding quotes from a raw scalar value. */
function cleanScalar(v) {
  return String(v)
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

/**
 * Build the import PLAN: map every foreign entry to a forge-schema entry record +
 * its destination path under TYPE_TO_DIR. Infers type from `metadata.type` (when a
 * valid type) else defaults to `learning`. Mints an id deterministically from the
 * type prefix + a zero-padded ordinal within its type, skipping past any id ALREADY
 * present in the destination vault (`takenIds`) so an import never collides with an
 * existing entry's id. NEVER overwrites an existing destination file (additive): a
 * path collision is recorded as `skipped`.
 *
 * Deterministic: given the same `foreign`, `memDir`, `now`, and `takenIds`, the plan
 * is byte-identical (ordinals are assigned in sorted source order).
 *
 * @param {object[]} foreign @param {string} memDir @param {string} now @param {Set<string>} [takenIds]
 * @returns {{create:object[], skipped:object[]}}
 */
function buildImportPlan(foreign, memDir, now, takenIds = new Set()) {
  const create = [];
  const skipped = [];
  /** @type {Record<string, number>} */
  const counters = {};
  // Ids already minted in THIS plan + ids already in the destination vault — both
  // are off-limits, so ordinals advance until a free id is found (deterministic).
  const used = new Set(takenIds);
  for (const f of foreign) {
    const type = VALID_TYPES.has(f.metaType) ? f.metaType : 'learning';
    const dir = TYPE_TO_DIR[type];
    let id;
    do {
      const n = (counters[type] = (counters[type] || 0) + 1);
      id = `${TYPE_TO_PREFIX[type]}${String(n).padStart(4, '0')}`;
    } while (used.has(id));
    used.add(id);
    const title = f.name || f.base;
    const slug = slugify(title);
    const fileName = `${id}-${slug}.md`;
    const destAbs = path.join(memDir, dir, fileName);
    const destRel = path.join(dir, fileName);

    let exists = false;
    try {
      exists = fs.existsSync(destAbs);
    } catch {
      exists = false;
    }
    const record = {
      sourceFile: f.abs,
      destRel,
      destAbs,
      id,
      type,
      title,
      confidence: DEFAULT_CONFIDENCE,
      created: now,
      updated: now,
      source: `imported from ${path.basename(f.abs)}`,
      // Preserve the foreign body verbatim; description seeds a Summary if no body.
      body: composeImportBody(f),
      wikiLinks: extractWikiLinks(f.body),
      droppedFrontmatterLinks: hadFrontmatterLinks(f.fm),
    };
    if (exists) {
      skipped.push({ ...record, reason: 'destination exists (additive: never overwrite)' });
    } else {
      create.push(record);
    }
  }
  return { create, skipped };
}

/** True when the foreign frontmatter carried a `links:` key we are dropping. */
function hadFrontmatterLinks(fm) {
  return Object.prototype.hasOwnProperty.call(fm, 'links');
}

/**
 * Compose the body for an imported entry. We PRESERVE the foreign body verbatim;
 * when there is no body but a `description` exists, seed a minimal `## Summary`
 * from it so the entry is non-empty and yields an index hook. Deterministic.
 * @param {object} f @returns {string}
 */
function composeImportBody(f) {
  const body = String(f.body || '').trim();
  if (body) return f.body;
  if (f.description) return `## Summary\n\n${f.description}\n`;
  return `## Summary\n\n${f.name || f.base}\n`;
}

// ---------------------------------------------------------------------------
// Project name (for the index title)
// ---------------------------------------------------------------------------

/** Best-effort project name: package.json#name, else the rootDir basename. */
function projectName(rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.name === 'string' && pkg.name) return pkg.name;
  } catch {
    /* no package.json — fall through */
  }
  return path.basename(rootDir) || 'project';
}

// ---------------------------------------------------------------------------
// normalize — mirrors fleet.mjs#normalize
// ---------------------------------------------------------------------------

/** Normalise `ctx`/`args` to { rootDir, srcDir, write, now, positional, flags }. */
function normalize(args, ctx) {
  const flags = new Set();
  const positional = [];
  /** @type {Record<string,string>} */
  const opts = {};
  const argList = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  const VALUE_OPTS = new Set(['now', 'project']);
  for (let i = 0; i < argList.length; i++) {
    const a = argList[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      flags.add(name);
      if (eq >= 0) {
        opts[name] = body.slice(eq + 1);
      } else if (VALUE_OPTS.has(name) && i + 1 < argList.length && !String(argList[i + 1]).startsWith('--')) {
        opts[name] = String(argList[i + 1]);
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  if (ctx && ctx.flags instanceof Set) for (const f of ctx.flags) flags.add(f);

  // rootDir = the TARGET project (where the vault lives): an explicit positional
  // is treated as the project dir for `list`/`validate`/`reindex`; for `import`
  // the FIRST positional is the source vault and the project is cwd. The caller
  // (the bin) runs us in the project cwd, so cwd is the default.
  const rootDir = (ctx && (ctx.cwd || ctx.root)) || process.cwd();
  const srcDir = positional.length ? positional[0] : null;
  const write = flags.has('write') || flags.has('apply') || (ctx && (ctx.write === true || ctx.apply === true));
  const now = opts.now || (ctx && ctx.opts && ctx.opts.now) || DEFAULT_NOW;
  const project = opts.project || (ctx && ctx.opts && ctx.opts.project) || null;
  return { rootDir, srcDir, write: !!write, now, project, positional, flags };
}

/** Best-effort FORGE library root = two levels up from this module (manager/..). */
function selfForgeRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr. Returns `{ ok, data, findings, summary }`.
 * Fail-open: any internal failure degrades to an ok-ish empty result, never a throw.
 *
 * Read verbs (`list`, `validate`) write NOTHING. `reindex --write` writes ONLY
 * `<memDir>/index.md`; `import --apply` CREATES new entry files (additive, never
 * overwrites). Default (no `--write`/`--apply`) is always a preview.
 *
 * @param {string} subcmd list | validate | reindex | import
 * @param {any} args string[] | { positional, flags, opts }
 * @param {any} ctx { cwd?, root?, flags?, opts?, write?, apply? }
 * @returns {Promise<{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const n = normalize(args, ctx);
    switch (subcmd) {
      case 'list':
        return doList(n.rootDir);
      case 'validate':
        return doValidate(n.rootDir);
      case 'reindex':
        return doReindex(n.rootDir, n.write, n.project);
      case 'import':
        return doImport(n.rootDir, n.srcDir, n.write, n.now);
      default:
        return result(false, { usage: usageText() }, [
          finding('ERROR', 'memory', `unknown memory subcommand: ${subcmd || '(none)'}`),
        ]);
    }
  } catch (e) {
    return result(false, null, [
      finding('ERROR', 'memory', `memory error: ${e && e.message ? e.message : String(e)}`),
    ]);
  }
}

/** `list` — enumerate vault entries → data.entries[]. Read-only, fail-open. */
function doList(rootDir) {
  const memDir = findMemoryDir(rootDir);
  if (!memDir) {
    return result(true, { memDir: null, entries: [] }, [finding('INFO', 'memory', 'no memory vault found (.claude/memory or memory/)')], {
      entries: 0,
    });
  }
  const entries = loadEntries(memDir).map((e) => ({
    id: e.id,
    type: e.type,
    status: e.status,
    title: e.title,
    confidence: e.confidence,
    rel: e.rel,
  }));
  return result(true, { memDir, entries }, [], { entries: entries.length });
}

/**
 * `validate` — run the memory-integrity checks as findings. We delegate to the
 * canonical validator (lint/validate-memory-integrity.mjs) for an authoritative
 * pass/fail, then surface its emitted ERROR/WARN/INFO lines as C2 findings via the
 * shared `parseFindings` parser (the validator prints findings to stderr + a
 * PASS/FAIL summary to stdout, so BOTH streams are concatenated — findings.mjs
 * §"which stream"). The validator is a process-exit script, so we run it across a
 * process boundary so its top-level process.exit() never tears down our caller.
 * Fail-open: a spawn failure degrades to a single WARN, never a throw.
 */
function doValidate(rootDir) {
  const findings = [];
  try {
    const cp = process.getBuiltinModule('node:child_process');
    const script = path.join(selfForgeRoot(), 'lint', 'validate-memory-integrity.mjs');
    const res = cp.spawnSync(process.execPath, [script, rootDir], { encoding: 'utf8' });
    const text = `${res.stderr || ''}\n${res.stdout || ''}`;
    for (const f of parseFindings(text, 'validate-memory-integrity.mjs')) findings.push(f);
    const failed = res.status !== 0;
    return result(!failed, { rootDir, passed: !failed }, findings, { passed: !failed });
  } catch (e) {
    findings.push(finding('WARN', 'memory', `could not run validator: ${e && e.message ? e.message : String(e)}`));
    return result(true, { rootDir, passed: null }, findings, { passed: null });
  }
}

/**
 * `reindex [--write]` — GENERATE index.md from active entries; default returns the
 * preview in data.index, --write persists it to <memDir>/index.md. The generated
 * index is byte-identical given the same vault + project name (deterministic), and
 * passes validate-memory-integrity's freshness rule by construction.
 */
function doReindex(rootDir, write, projectArg) {
  let memDir = findMemoryDir(rootDir);
  const findings = [];
  if (!memDir) {
    // No vault yet: --write would create the default location; preview still works
    // (an empty vault yields the all-placeholder index).
    memDir = defaultMemoryDir(rootDir);
    findings.push(finding('INFO', 'memory', `no memory vault found; using default ${path.relative(rootDir, memDir) || memDir}`));
  }
  const entries = (() => {
    try {
      return loadEntries(memDir);
    } catch {
      return [];
    }
  })();
  const name = projectArg || projectName(rootDir);
  const index = generateIndex(entries, { projectName: name });
  const indexAbs = path.join(memDir, 'index.md');

  let wrote = false;
  if (write) {
    wrote = writeFileAtomic(indexAbs, index);
    if (!wrote) findings.push(finding('WARN', 'memory', `could not write ${path.relative(rootDir, indexAbs) || indexAbs}`));
  }
  const active = entries.filter((e) => e.status === 'active').length;
  return result(true, { memDir, indexPath: indexAbs, index, written: wrote, activeEntries: active }, findings, {
    activeEntries: active,
    written: wrote,
  });
}

/**
 * `import <srcDir> [--apply]` — map a foreign vault into forge-schema entries.
 * Default returns the plan in data.plan; --apply writes the new files (additive:
 * NEVER overwrites an existing entry). Deterministic given (srcDir, now).
 */
function doImport(rootDir, srcDir, apply, now) {
  const findings = [];
  if (!srcDir) {
    return result(false, { usage: usageText() }, [finding('ERROR', 'memory', 'import requires a <srcDir> argument')]);
  }
  const srcAbs = path.isAbsolute(srcDir) ? srcDir : path.resolve(rootDir, srcDir);
  let srcOk = false;
  try {
    srcOk = fs.statSync(srcAbs).isDirectory();
  } catch {
    srcOk = false;
  }
  if (!srcOk) {
    return result(false, { srcDir: srcAbs }, [finding('ERROR', 'memory', `source vault not found: ${srcAbs}`)]);
  }

  // Destination vault: an existing one wins, else the default location.
  const memDir = findMemoryDir(rootDir) || defaultMemoryDir(rootDir);
  // Ids already present in the destination vault are off-limits for minting (so an
  // import never collides with an existing entry's id). Empty when the vault is new.
  const taken = new Set();
  try {
    for (const e of loadEntries(memDir)) if (e.id) taken.add(e.id);
  } catch {
    /* no existing vault — nothing taken */
  }
  const foreign = loadForeignEntries(srcAbs);
  const plan = buildImportPlan(foreign, memDir, now, taken);

  // Surface dropped frontmatter `links:` maps as INFO (the decision in action).
  for (const rec of plan.create) {
    if (rec.droppedFrontmatterLinks) {
      findings.push(finding('INFO', rec.sourceFile, `dropped frontmatter links: (body [[wiki links]] are the single edge source)`));
    }
  }
  for (const rec of plan.skipped) {
    findings.push(finding('WARN', rec.destRel, rec.reason));
  }

  let written = 0;
  if (apply) {
    for (const rec of plan.create) {
      // Re-check existence at write time (additive guarantee under concurrency).
      let exists = false;
      try {
        exists = fs.existsSync(rec.destAbs);
      } catch {
        exists = false;
      }
      if (exists) {
        findings.push(finding('WARN', rec.destRel, 'destination appeared before write — skipped (never overwrite)'));
        continue;
      }
      if (writeFileAtomic(rec.destAbs, renderEntryFile(rec))) written += 1;
      else findings.push(finding('WARN', rec.destRel, 'could not write entry'));
    }
  }

  const planView = {
    create: plan.create.map((r) => ({
      sourceFile: r.sourceFile,
      destRel: r.destRel,
      id: r.id,
      type: r.type,
      title: r.title,
      confidence: r.confidence,
      wikiLinks: r.wikiLinks,
      droppedFrontmatterLinks: r.droppedFrontmatterLinks,
    })),
    skipped: plan.skipped.map((r) => ({ sourceFile: r.sourceFile, destRel: r.destRel, reason: r.reason })),
  };
  return result(true, { srcDir: srcAbs, memDir, applied: !!apply, written, plan: planView }, findings, {
    create: plan.create.length,
    skipped: plan.skipped.length,
    written,
  });
}

/**
 * C4 `summarize(state)` — pure; map a run-state to a one-panel summary. Returns a
 * `(no data)` panel when no vault/entries are present (fail-open).
 * @param {any} state @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  const entries =
    state && typeof state === 'object' && Array.isArray(state.entries) ? state.entries : null;
  if (!entries) {
    return makePanel({ panel: 'memory', ok: false, lines: ['(no data)'], hint: 'forge memory list' });
  }
  const active = entries.filter((e) => e && e.status === 'active').length;
  return makePanel({ panel: 'memory', ok: true, lines: [`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`, `${active} active`] });
}

/** Build a Panel with a non-enumerable toString (mirrors fleet.mjs#makePanel). */
function makePanel(p) {
  Object.defineProperty(p, 'toString', {
    value() {
      const body = Array.isArray(p.lines) ? p.lines.join(' ') : '';
      return `[${p.panel}] ${body}${p.hint ? ` (${p.hint})` : ''}`;
    },
    enumerable: false,
  });
  return p;
}

// ---------------------------------------------------------------------------
// run() helpers
// ---------------------------------------------------------------------------

/** Stamp a C2 finding from this module (source pre-filled). */
function finding(level, p, message) {
  return makeFinding({ level, path: p, line: null, message, source: SOURCE });
}

/**
 * Assemble a ModuleResult `{ ok, data, findings, summary }` (the C4 contract).
 * @param {boolean} ok @param {any} data @param {import('./lib/findings.mjs').Finding[]} [findings] @param {object} [summary]
 */
function result(ok, data, findings = [], summary = undefined) {
  const list = Array.isArray(findings) ? findings : [];
  const sum = summary !== undefined ? { ...levelCounts(list), ...summary } : levelCounts(list);
  return { ok: !!ok, data: data === undefined ? null : data, findings: list, summary: sum };
}

/** Count findings by level into the uniform triple. */
function levelCounts(findings) {
  const s = { errors: 0, warnings: 0, info: 0 };
  for (const f of findings) {
    if (f && f.level === 'ERROR') s.errors++;
    else if (f && f.level === 'WARN') s.warnings++;
    else if (f && f.level === 'INFO') s.info++;
  }
  return s;
}

/** Static usage banner for an unknown subcommand. */
function usageText() {
  return [
    'forge memory list',
    'forge memory validate',
    'forge memory reindex [--write] [--project <name>]',
    'forge memory import <srcDir> [--apply] [--now <iso>]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Deterministic file write (mirrors store.mjs#writeJsonAtomic for text)
// ---------------------------------------------------------------------------

/**
 * Write text ATOMICALLY: serialize to a unique temp sibling, then renameSync into
 * place. Parent dirs are created. Deterministic CONTENT (the temp name uses a
 * counter, not random bytes, so a sandbox can predict nothing about it but the
 * destination content is purely a function of `text`). Fail-open: false on error.
 * @param {string} absPath @param {string} text @returns {boolean}
 */
let __tmpCounter = 0;
function writeFileAtomic(absPath, text) {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${__tmpCounter++}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, absPath);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Human render (print side)
// ---------------------------------------------------------------------------

/**
 * Render a ModuleResult as human text (print side). Returns the exit code. PRINT
 * happens ONLY in the script entry; run() never writes stdout.
 * @param {string} subcmd @param {{ok:boolean,data:any,findings:any[],summary:any}} res @returns {number}
 */
function renderHuman(subcmd, res) {
  const out = [];
  const data = res.data || {};
  if (subcmd === 'list') {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.length === 0) out.push('memory: no entries');
    for (const e of entries) {
      out.push(`${e.id || '(no-id)'}\t${e.type || '?'}\t${e.status || '?'}\t${e.title || ''}`);
    }
  } else if (subcmd === 'validate') {
    out.push(`memory validate: ${data.passed === true ? 'PASS' : data.passed === false ? 'FAIL' : 'UNKNOWN'}`);
  } else if (subcmd === 'reindex') {
    if (data.written) out.push(`memory reindex: wrote ${data.indexPath} (${data.activeEntries} active)`);
    else process.stdout.write(String(data.index || ''));
  } else if (subcmd === 'import') {
    const plan = data.plan || { create: [], skipped: [] };
    out.push(`memory import: ${plan.create.length} to create, ${plan.skipped.length} skipped${data.applied ? `, ${data.written} written` : ' (preview — pass --apply)'}`);
    for (const r of plan.create) out.push(`  + ${r.destRel}\t${r.id}\t${r.type}\t${r.title}`);
    for (const r of plan.skipped) out.push(`  - ${r.destRel}\t(skip: ${r.reason})`);
  } else if (data.usage) {
    out.push(data.usage);
  }
  for (const f of res.findings || []) {
    const loc = f.line ? `${f.path}:${f.line}` : f.path;
    process.stderr.write(`${f.level} ${loc} ${f.message}\n`);
  }
  if (out.length) process.stdout.write(out.join('\n') + '\n');
  return res.ok ? 0 : (res.findings || []).some((f) => f.level === 'ERROR') ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Dual-mode: direct script entry
//   node manager/memory.mjs <subcmd> [flags] [dir]
// Renders human text, or the C3 --json envelope under --json. PRINT happens ONLY
// here. NEVER process.exit() at import time — the isMain() guard protects the
// node:test runner.
// ---------------------------------------------------------------------------

/** Read the running forge VERSION at the library root (fail-open to '0.0.0'). */
function readRunningVersion(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'VERSION'), 'utf8').trim();
    return raw || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** True when this module is executed directly (not imported). */
function isMain() {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const subcmd = argv[0];
  const rest = argv.slice(1);
  const json = rest.includes('--json');
  run(subcmd, rest, {})
    .then((res) => {
      if (json) {
        const env = envelope({
          command: `memory ${subcmd || ''}`.trim(),
          ok: res.ok,
          data: res.data,
          findings: res.findings,
          summary: res.summary,
          forgeVersion: readRunningVersion(selfForgeRoot()),
        });
        writeStdoutSync(JSON.stringify(env) + '\n'); // SYNC write before exit — pipe-flush truncation (see json-out.mjs)
        process.exit(res.ok ? 0 : (res.findings || []).some((f) => f.level === 'ERROR') ? 1 : 0);
      } else {
        process.exit(renderHuman(subcmd, res));
      }
    })
    .catch(() => process.exit(1)); // fail-open: never an unhandled rejection
}

export default { run, summarize, generateIndex };
