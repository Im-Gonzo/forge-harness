#!/usr/bin/env node
/**
 * validate-bundles — Forge self-validator (Phase 2).
 *
 * For each forge/bundles/*.md it parses the YAML frontmatter (with a tiny dependency-free
 * reader) and validates it against schemas/bundle.schema.json (structurally, with a
 * hand-rolled draft-07 subset walker — NOT AJV) PLUS the REQUIRED_KEYS / invariant
 * rules (B-1..B-4 style):
 *
 *   B-1  Frontmatter parses and carries every REQUIRED key.
 *   B-2  Pointer keys (skill, agent, reviewer, dod_ref file, adrs[].path,
 *        spec_sections[].path) are present where required (full on-disk pointer
 *        resolution mirrors the v2 linter but is best-effort here since the project
 *        corpus is not part of the Forge repo).
 *   B-3  invariants is a NON-EMPTY subset of 1..10.
 *   B-4  human_gate is a boolean, and true for gated work-types
 *        (tenancy/RLS, core write-path, v1->v2 migration).
 *
 * NOTE: In Phase 2 forge/bundles/ is EMPTY (or absent). Absence of the asset class is
 * NOT an error — the validator passes cleanly. The negative fixture is Phase 3.
 *
 * Usage:
 *   node lint/validate-bundles.mjs [--strict] [rootDir]
 *
 * Exit 0 = pass, exit 1 = fail.
 *
 * Zero dependencies. Self-contained (no shared-lib import).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Args / config
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const positional = argv.filter((a) => !a.startsWith('--'));
const ROOT = positional.length > 0 ? path.resolve(positional[0]) : DEFAULT_ROOT;

const NAME = 'validate-bundles';
const BUNDLES_DIR = path.join(ROOT, 'bundles');
const SCHEMA_PATH = path.join(ROOT, 'schemas', 'bundle.schema.json');

// The 16 REQUIRED frontmatter keys (matches schemas/bundle.schema.json required[]).
const REQUIRED_KEYS = [
  'id', 'title', 'version', 'status', 'work_type',
  'invariants', 'adrs', 'spec_sections', 'br_ids', 'conformance',
  'modules', 'skill', 'agent', 'dod_ref', 'invisible_20', 'human_gate',
];

// ---------------------------------------------------------------------------
// Finding collection
// ---------------------------------------------------------------------------

const findings = []; // { level, path, line, message }
function err(filePath, line, message) {
  findings.push({ level: 'ERROR', path: filePath, line: line || 0, message });
}
function warn(filePath, line, message) {
  findings.push({ level: 'WARN', path: filePath, line: line || 0, message });
}
function rel(p) {
  const r = path.relative(ROOT, p);
  return r === '' ? path.basename(p) : r;
}

// ---------------------------------------------------------------------------
// Tiny dependency-free YAML frontmatter reader (supports scalars, block
// sequences of scalars, block sequences of mappings, inline flow arrays,
// comments).
// ---------------------------------------------------------------------------

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) throw new Error("file does not begin with a YAML frontmatter '---' fence");
  const lines = raw.split(/\r?\n/);
  if (lines[0].trim() !== '---') throw new Error("first line is not a bare '---' fence");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("no closing '---' frontmatter fence found");
  const fm = lines.slice(1, end);

  const obj = {};
  let i = 0;
  while (i < fm.length) {
    const rawLine = fm[i];
    const line = stripComment(rawLine);
    if (line.trim() === '') {
      i++;
      continue;
    }
    const indent = leadingSpaces(rawLine);
    if (indent !== 0) {
      throw new Error(`unexpected indentation at frontmatter line ${i + 2}: "${rawLine}"`);
    }
    const m = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (!m) throw new Error(`cannot parse frontmatter line ${i + 2}: "${rawLine}"`);
    const key = m[1];
    const restRaw = m[2].trim();
    if (restRaw !== '') {
      obj[key] = parseScalar(restRaw);
      i++;
      continue;
    }
    const block = [];
    let j = i + 1;
    while (j < fm.length) {
      const l = fm[j];
      if (stripComment(l).trim() === '') {
        block.push(l);
        j++;
        continue;
      }
      if (leadingSpaces(l) === 0) break;
      block.push(l);
      j++;
    }
    obj[key] = parseBlock(block);
    i = j;
  }
  return obj;
}

function leadingSpaces(s) {
  const m = s.match(/^( *)/);
  return m ? m[1].length : 0;
}

function stripComment(line) {
  let inS = false;
  let inD = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) {
      if (k === 0 || /\s/.test(line[k - 1])) return line.slice(0, k);
    }
  }
  return line;
}

function parseScalar(s) {
  const t = s.trim();
  if (t === '') return '';
  if (t === '[]') return [];
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevelCommas(inner).map((x) => parseScalar(x));
  }
  return unquote(t);
}

function unquote(t) {
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return t.slice(1, -1);
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1);
  return t;
}

function splitTopLevelCommas(s) {
  const out = [];
  let depth = 0;
  let inS = false;
  let inD = false;
  let cur = '';
  for (const c of s) {
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD && (c === '[' || c === '{')) depth++;
    else if (!inS && !inD && (c === ']' || c === '}')) depth--;
    if (c === ',' && depth === 0 && !inS && !inD) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function parseBlock(block) {
  const meaningful = block.filter((l) => stripComment(l).trim() !== '');
  if (meaningful.length === 0) return [];
  const baseIndent = Math.min(...meaningful.map(leadingSpaces));
  const items = [];
  let i = 0;
  while (i < block.length) {
    const l = block[i];
    if (stripComment(l).trim() === '') {
      i++;
      continue;
    }
    const content = stripComment(l).slice(baseIndent);
    if (!content.startsWith('- ')) {
      i++;
      continue;
    }
    const first = content.slice(2);
    const firstMap = first.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (firstMap) {
      const map = {};
      map[firstMap[1]] = parseScalar(firstMap[2].trim());
      const itemIndent = leadingSpaces(l);
      let j = i + 1;
      while (j < block.length) {
        const nl = block[j];
        if (stripComment(nl).trim() === '') {
          j++;
          continue;
        }
        const ind = leadingSpaces(nl);
        if (ind <= itemIndent) break;
        const mm = stripComment(nl).trim().match(/^([A-Za-z_][\w-]*):(.*)$/);
        if (mm) map[mm[1]] = parseScalar(mm[2].trim());
        j++;
      }
      items.push(map);
      i = j;
    } else {
      items.push(parseScalar(first.trim()));
      i++;
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Minimal draft-07 subset schema walker (NOT AJV). Supports the constructs the
// bundle schema uses: type, required, properties, items, pattern, min/max,
// minItems, uniqueItems.
// ---------------------------------------------------------------------------

function jsType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(value, schemaType) {
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  const actual = jsType(value);
  for (const t of types) {
    if (t === 'number' && (actual === 'number' || actual === 'integer')) return true;
    if (t === 'integer' && actual === 'integer') return true;
    if (t === actual) return true;
  }
  return false;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function validateSchema(value, schema, dataPath, out) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    out.push(`${dataPath || '(root)'}: expected type ${JSON.stringify(schema.type)}, got ${jsType(value)}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    out.push(`${dataPath || '(root)'}: value ${JSON.stringify(value)} not in enum`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      out.push(`${dataPath}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.pattern === 'string') {
      let re = null;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        /* ignore */
      }
      if (re && !re.test(value)) out.push(`${dataPath}: ${JSON.stringify(value)} does not match /${schema.pattern}/`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      out.push(`${dataPath}: ${value} below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      out.push(`${dataPath}: ${value} above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push(`${dataPath}: array has ${value.length} items, fewer than minItems ${schema.minItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = [];
      for (const item of value) {
        if (seen.some((s) => deepEqual(s, item))) {
          out.push(`${dataPath}: duplicate array item`);
          break;
        }
        seen.push(item);
      }
    }
    if (schema.items) {
      value.forEach((item, i) => validateSchema(item, schema.items, `${dataPath}[${i}]`, out));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in value)) out.push(`${dataPath || '(root)'}: missing required property '${req}'`);
      }
    }
    const props = schema.properties || {};
    for (const k of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        validateSchema(value[k], props[k], `${dataPath}.${k}`, out);
      } else if (schema.additionalProperties === false) {
        out.push(`${dataPath || '(root)'}: additional property '${k}' not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateSchema(value[k], schema.additionalProperties, `${dataPath}.${k}`, out);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// work-type gate classification for B-4
// ---------------------------------------------------------------------------

function requiresHumanGate(fm) {
  const hay = [String(fm.work_type || ''), String(fm.title || ''), String(fm.id || '')]
    .join(' ')
    .toLowerCase();
  const reasons = [];
  if (/tenan|\brls\b|set local|multi-?tenan|pooler|three-axis|registry|isolation|\broles\b/.test(hay)) {
    reasons.push('tenancy/RLS work-type');
  }
  if (
    /applytransition|apply transition|write path|five-fact|five fact|\btransition\b|transition spine|vertical slice|walking skeleton|claim->submit|hold\/release|routing/.test(
      hay
    )
  ) {
    reasons.push('core write-path work-type');
  }
  if (/migrat|v1\s*to\s*v2|v1->v2|v1→v2|one-shot per-field/.test(hay)) {
    reasons.push('v1->v2 migration work-type');
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Per-bundle lint
// ---------------------------------------------------------------------------

function lintBundle(filePath, schema) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    err(filePath, 0, `B-1: cannot read file: ${e.message}`);
    return;
  }

  let fm;
  try {
    fm = parseFrontmatter(raw);
  } catch (e) {
    err(filePath, 1, `B-1: frontmatter does not parse: ${e.message}`);
    return;
  }

  // Schema check (structural).
  if (schema) {
    const out = [];
    validateSchema(fm, schema, '', out);
    for (const m of out) err(filePath, 0, `schema: ${m}`);
  }

  // B-1: required keys present.
  for (const k of REQUIRED_KEYS) {
    if (!(k in fm)) err(filePath, 0, `B-1: missing required key '${k}'`);
  }

  // B-2: pointer shape checks (presence/type). On-disk resolution against a
  // project corpus is not applicable inside the Forge repo, so we verify the
  // pointer fields are well-formed and non-empty where required.
  if ('adrs' in fm && !Array.isArray(fm.adrs)) err(filePath, 0, 'B-2: adrs must be a list');
  else if (Array.isArray(fm.adrs)) {
    for (const a of fm.adrs) {
      if (a && typeof a === 'object') {
        if (!a.id) err(filePath, 0, 'B-2: adrs[] entry missing id');
        if (!a.path) err(filePath, 0, 'B-2: adrs[] entry missing path');
      }
    }
  }
  if ('spec_sections' in fm && !Array.isArray(fm.spec_sections)) {
    err(filePath, 0, 'B-2: spec_sections must be a list');
  } else if (Array.isArray(fm.spec_sections)) {
    for (const s of fm.spec_sections) {
      if (s && typeof s === 'object' && !s.path) err(filePath, 0, 'B-2: spec_sections[] entry missing path');
    }
  }
  for (const key of ['skill', 'agent']) {
    if (key in fm && (fm[key] == null || fm[key] === '')) {
      err(filePath, 0, `B-2: ${key} must be a non-empty pointer`);
    }
  }
  if ('dod_ref' in fm && (fm.dod_ref == null || fm.dod_ref === '')) {
    err(filePath, 0, 'B-2: dod_ref must be a non-empty reference');
  }
  if ('br_ids' in fm && !Array.isArray(fm.br_ids)) err(filePath, 0, 'B-2: br_ids must be a list');

  // B-3: invariants non-empty subset of 1..10.
  if (!Array.isArray(fm.invariants)) {
    err(filePath, 0, 'B-3: invariants must be a list');
  } else if (fm.invariants.length === 0) {
    err(filePath, 0, 'B-3: invariants must be non-empty');
  } else {
    for (const n of fm.invariants) {
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        err(filePath, 0, `B-3: invariant out of range 1..10: ${JSON.stringify(n)}`);
      }
    }
  }

  // B-4: human_gate boolean + correct for gated work-types.
  if ('human_gate' in fm) {
    if (typeof fm.human_gate !== 'boolean') {
      err(filePath, 0, `B-4: human_gate must be a boolean (got ${JSON.stringify(fm.human_gate)})`);
    } else {
      const reasons = requiresHumanGate(fm);
      if (reasons.length > 0 && fm.human_gate !== true) {
        err(filePath, 0, `B-4: human_gate must be true for this work-type (${reasons.join('; ')})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function collectBundleFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort()
    .map((f) => path.join(dir, f));
}

function main() {
  const files = collectBundleFiles(BUNDLES_DIR);

  // Absence of bundles/ (or an empty bundles/) is NOT an error.
  if (files.length === 0) {
    console.log(`${NAME}: no bundles found under ${rel(BUNDLES_DIR)} (nothing to validate)`);
    console.log(`${NAME}: PASS`);
    process.exit(0);
  }

  // Load schema (best-effort; absence => structural check skipped, B-rules still run).
  let schema = null;
  try {
    schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  } catch (e) {
    warn(SCHEMA_PATH, 0, `could not load bundle schema (structural check skipped): ${e.message}`);
  }

  for (const f of files) lintBundle(f, schema);

  return report(files.length);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(total) {
  const errors = findings.filter((f) => f.level === 'ERROR');
  const warns = findings.filter((f) => f.level === 'WARN');

  const ordered = [...errors, ...warns].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
  for (const f of ordered) console.log(`${f.level} ${rel(f.path)}:${f.line} ${f.message}`);

  const failedBundles = new Set(errors.map((e) => e.path)).size;
  console.log(
    `\n${NAME}: ${total - failedBundles}/${total} bundle(s) passed; ${errors.length} error(s), ${warns.length} warning(s)`
  );

  const fail = errors.length > 0 || (STRICT && warns.length > 0);
  if (fail) {
    console.log(`${NAME}: FAIL`);
    process.exit(1);
  }
  console.log(`${NAME}: PASS`);
  process.exit(0);
}

main();
