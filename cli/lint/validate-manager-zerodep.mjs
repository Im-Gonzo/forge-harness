#!/usr/bin/env node
/**
 * validate-manager-zerodep — mechanically enforce the manager's zero-dependency
 * invariant (BR-INT-002, EVAL-INT-001).
 *
 * Recursively scans every `*.mjs` under `forge/manager/` (manager/lib/*, the
 * dimension modules like manager/registry.mjs, etc.) and parses every module
 * specifier it imports:
 *
 *   - static  `import ... from 'X'`   and bare `import 'X'`
 *   - re-export `export ... from 'X'`
 *   - dynamic  `import('X')`          (string-literal argument only)
 *   - CommonJS `require('X')`         (string-literal argument only)
 *
 * Any specifier that is NOT `node:`-prefixed and NOT a relative path
 * (`./` or `../`) is an ERROR — it would pull a third-party / bare runtime
 * dependency into the manager, which invariant 1 forbids (ADR-0014). A bare
 * `import _ from 'lodash'` planted in a manager file MUST fail the run; an
 * all-`node:`/relative tree MUST pass.
 *
 * Comments and string literals are stripped before scanning so that JSDoc
 * type references (`@typedef {import('./x.mjs').T}`) and specifier-shaped text
 * inside strings/comments never produce false positives.
 *
 * Auto-discovered by `run-all.mjs` (filename matches `validate-*.mjs`) with no
 * runner edit. Absence of the manager/ dir (or no *.mjs in it) is NOT an error.
 *
 * Invocation: node lint/validate-manager-zerodep.mjs [--strict] [rootDir]
 * Real violations are ERRORS (exit 1). Zero dependencies; self-contained;
 * fail-open (an unreadable file is reported, not thrown).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- argument parsing ------------------------------------------------------

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const positional = args.filter((a) => !a.startsWith('--'));
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = positional[0] ? path.resolve(positional[0]) : path.resolve(SELF_DIR, '..');

const MANAGER_DIR = path.join(ROOT, 'manager');
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);

// ---- findings --------------------------------------------------------------

const errors = [];
const warnings = [];

// `LEVEL path:line message` — parseable by manager/lib/findings.mjs FINDING_RE.
function err(loc, msg) { errors.push(`ERROR  ${loc}  ${msg}`); }
function warn(loc, msg) { warnings.push(`WARN   ${loc}  ${msg}`); }

// ---- discovery -------------------------------------------------------------

/** Recursively collect all *.mjs files under dir (absolute paths). */
function collectMjs(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // fail-open: unreadable dir contributes nothing
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.isDirectory()) continue;
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...collectMjs(abs));
    } else if (ent.isFile() && ent.name.endsWith('.mjs')) {
      out.push(abs);
    }
  }
  return out;
}

// ---- comment / string stripping --------------------------------------------

/**
 * Replace the contents of line comments, block comments, and string/template
 * literals with same-length runs of spaces — preserving newlines so that line
 * numbers stay accurate. This neutralises specifier-shaped text inside comments
 * (JSDoc `import('./x')` type refs) and strings, while keeping every real
 * `import`/`export`/`require` token and the quotes that delimit its specifier.
 *
 * We blank only the *interior* of string literals (not the delimiting quotes),
 * so the specifier-extraction regexes below still see `'<spaces>'` and can tell
 * "had a string here" — but the spaces never match a bare-specifier pattern.
 *
 * @param {string} src
 * @returns {string}
 */
function maskCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // states: 0 code, 1 line comment, 2 block comment,
  //         3 '..'  4 ".."  5 `..` (template)
  let state = 0;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (state === 0) {
      if (c === '/' && c2 === '/') { out += '  '; i += 2; state = 1; continue; }
      if (c === '/' && c2 === '*') { out += '  '; i += 2; state = 2; continue; }
      if (c === "'") { out += c; i += 1; state = 3; continue; }
      if (c === '"') { out += c; i += 1; state = 4; continue; }
      if (c === '`') { out += c; i += 1; state = 5; continue; }
      out += c; i += 1; continue;
    }
    if (state === 1) { // line comment
      if (c === '\n') { out += '\n'; i += 1; state = 0; continue; }
      out += ' '; i += 1; continue;
    }
    if (state === 2) { // block comment
      if (c === '*' && c2 === '/') { out += '  '; i += 2; state = 0; continue; }
      out += (c === '\n' ? '\n' : ' '); i += 1; continue;
    }
    // string / template literal interiors (states 3,4,5)
    const quote = state === 3 ? "'" : state === 4 ? '"' : '`';
    if (c === '\\') { out += '  '; i += 2; continue; } // escape: blank both chars
    if (c === quote) { out += c; i += 1; state = 0; continue; } // closing delimiter
    out += (c === '\n' ? '\n' : ' '); i += 1; continue;
  }
  return out;
}

// ---- specifier extraction --------------------------------------------------

/**
 * After masking, string interiors are spaces, so we cannot read the literal
 * text from the masked source. We instead locate import/export/require call
 * sites in the masked source (where comment/string noise is gone) and read the
 * specifier back from the ORIGINAL source at the same offsets.
 *
 * Returns a list of { spec, index } where index is the char offset (in the
 * original source) of the opening quote of the specifier.
 */
function extractSpecifiers(original, masked) {
  /** @type {{spec: string, index: number}[]} */
  const found = [];

  // A quoted string literal, captured by position. We scan the MASKED source
  // for the syntactic context (import/from/require/import-call), then read the
  // actual specifier from ORIGINAL using the matched quote offsets.
  // The masked source still contains the delimiting quotes, so this regex finds
  // every string-literal slot; the surrounding keyword decides if it's a spec.
  const STR = /(['"`])[\s\S]*?\1/g; // greedy-safe via masked spaces (no escapes)

  // Helper: given the masked match for a string slot, read original spec text.
  function readSpec(m) {
    const start = m.index;            // position of opening quote in masked
    const end = m.index + m[0].length; // one past closing quote
    // original has identical length & quote positions (mask is length-preserving)
    const raw = original.slice(start + 1, end - 1);
    return { raw, start };
  }

  // Patterns that precede a module specifier string. We test the masked text
  // immediately before each string slot.
  //   ... from <str>      (static import / re-export)
  //   import <str>         (bare side-effect import)
  //   import( <str>        (dynamic import)
  //   require( <str>       (CommonJS)
  const FROM_RE = /\bfrom\s*$/;
  const BARE_IMPORT_RE = /\bimport\s*$/;
  const DYN_IMPORT_RE = /\bimport\s*\(\s*$/;
  const REQUIRE_RE = /\brequire\s*\(\s*$/;

  let m;
  while ((m = STR.exec(masked)) !== null) {
    const before = masked.slice(Math.max(0, m.index - 64), m.index);
    const isFrom = FROM_RE.test(before);
    const isBare = !isFrom && BARE_IMPORT_RE.test(before);
    const isDyn = DYN_IMPORT_RE.test(before);
    const isReq = REQUIRE_RE.test(before);
    if (!isFrom && !isBare && !isDyn && !isReq) continue;
    const { raw, start } = readSpec(m);
    found.push({ spec: raw, index: start });
  }
  return found;
}

// ---- classification --------------------------------------------------------

function isAllowed(spec) {
  if (spec.startsWith('node:')) return true;
  if (spec.startsWith('./') || spec.startsWith('../')) return true;
  return false;
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

// ---- validation ------------------------------------------------------------

function validateFile(abs) {
  const rel = path.relative(ROOT, abs);
  let content;
  try {
    content = fs.readFileSync(abs, 'utf-8');
  } catch (e) {
    // fail-open: a single unreadable file is reported as a WARN, never a throw.
    warn(rel, `unreadable: ${e.message}`);
    return;
  }
  content = content.replace(/^\uFEFF/, '');
  const masked = maskCommentsAndStrings(content);
  const specs = extractSpecifiers(content, masked);

  for (const { spec, index } of specs) {
    if (spec === '') continue; // empty specifier — not our concern
    if (isAllowed(spec)) continue;
    const loc = `${rel}:${lineOf(content, index)}`;
    err(loc, `non-zero-dep import specifier '${spec}' (must be node: builtin or relative ./ ../)`);
  }
}

function main() {
  if (!fs.existsSync(MANAGER_DIR) || !fs.statSync(MANAGER_DIR).isDirectory()) {
    console.log('validate-manager-zerodep: manager/ absent — nothing to validate (PASS)');
    process.exit(0);
  }

  const files = collectMjs(MANAGER_DIR).sort();
  if (files.length === 0) {
    console.log('validate-manager-zerodep: no *.mjs under manager/ — nothing to validate (PASS)');
    process.exit(0);
  }

  for (const abs of files) validateFile(abs);

  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `validate-manager-zerodep: ${files.length} manager *.mjs file(s), ${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'PASS'}`
  );
  process.exit(failed ? 1 : 0);
}

/**
 * True only when this module is the process entry point (run directly), NOT when
 * it is `import()`-ed (e.g. by a test that probes its existence). Without this
 * guard, importing the validator would run main() and call process.exit(),
 * terminating the importing process (it was silently killing the EVAL-INT test
 * suite, making every EVAL-INT case vacuously "pass"). Mirrors the dual-mode
 * guard the manager modules use.
 */
function isMain() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main();
}
