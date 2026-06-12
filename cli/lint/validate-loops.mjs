#!/usr/bin/env node
/**
 * validate-loops — lint Forge loop definitions (the loops module, D1/D2).
 *
 * A loop definition (`loops/<name>.md` in the Forge library, or
 * `<project>/.claude/loops/<name>.md` in a target) is YAML frontmatter + a body
 * with `## Body` and `## Verification` sections. This validator enforces the D2
 * rule table verbatim:
 *
 *   R1  frontmatter parses; all REQUIRED keys present
 *   R2  `name` kebab-case AND == filename (minus .md)
 *   R3  `tier` in {T0,T1,T2}; `apply` in {auto,draft}; `runtime` in enum
 *   R4  `tier: T2` => `apply: draft`        (autonomy-ladder: T2 may not auto-apply)
 *   R5  maker ref != verifier ref           (no self-verification)
 *   R6  maker/verifier refs resolve         (agents/<n>.md or skills/<n>/SKILL.md)
 *   R7  >=1 exit key; if only `queue-dry`, also require `cap` or `budget`
 *   R8  `escalation` non-empty list of non-empty strings
 *   R9  `ledger` path under `.claude/memory/`
 *   R10 `model` (if present) in {haiku,sonnet,opus,inherit}
 *   R11 body has `## Body` and `## Verification` sections
 *   R12a `done_eval` present + non-empty (the eval the verifier grades done against)
 *   R12b when an evals dir is found near the loop, `done_eval` resolves to
 *        `<evals>/<done_eval>.md` (the loop's done-criteria must exist on disk)
 *
 * Invocation:
 *   node lint/validate-loops.mjs [--strict] [file ...]
 *   node lint/validate-loops.mjs [--strict] [rootDir]
 *
 *   - With markdown FILE args, validate exactly those files (negative-fixture
 *     and grader use). A lone non-.md positional is treated as a rootDir.
 *   - With no file args, scan `<root>/loops/*.md` if the dir exists (absence is a
 *     clean exit 0) AND always validate `lint/fixtures/loops/good-*.md` as a
 *     self-check, so the positive fixture is guarded on every run.
 *
 * Exit 0 = pass, exit 1 = findings. Same reporting shape as the sibling
 * validators (validate-rules / validate-skills): findings to stderr as
 * `ERROR  <loc>  <msg>`, summary `<name>: ... — PASS/FAIL` to stdout. Each
 * finding message names the rule (Rn) that fired.
 *
 * Zero dependencies; self-contained (no shared-lib import).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- argument parsing ------------------------------------------------------

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const positional = args.filter((a) => !a.startsWith('--'));
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

// A positional ending in .md is a file to validate; anything else is a rootDir.
const fileArgs = positional.filter((p) => p.endsWith('.md'));
const dirArgs = positional.filter((p) => !p.endsWith('.md'));
const ROOT = dirArgs[0] ? path.resolve(dirArgs[0]) : path.resolve(SELF_DIR, '..');

const NAME = 'validate-loops';
const LOOPS_DIR = path.join(ROOT, 'loops');
const FIXTURE_DIR = path.join(ROOT, 'lint', 'fixtures', 'loops');
const AGENTS_DIR = path.join(ROOT, 'agents');
const SKILLS_DIR = path.join(ROOT, 'skills');

const REQUIRED_KEYS = [
  'name', 'description', 'intake', 'intake_cmd', 'tier', 'apply',
  'maker', 'verifier', 'exit', 'escalation', 'ledger', 'runtime',
  'runtime_invocation', 'done_eval',
];

const TIERS = new Set(['T0', 'T1', 'T2']);
const APPLY = new Set(['auto', 'draft']);
const RUNTIMES = new Set(['claude-loop', 'cron', 'gh-actions', 'headless']);
const MODELS = new Set(['haiku', 'sonnet', 'opus', 'inherit']);

// ---- findings (validate-rules / validate-skills shape) ---------------------

const errors = [];
const warnings = [];

function err(loc, msg) { errors.push(`ERROR  ${loc}  ${msg}`); }

/** Locate a frontmatter key's 1-based line for a precise `rel:line` loc. */
function locOf(rel, content, key) {
  const lines = content.replace(/^/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${key}\\s*:`).test(lines[i])) return `${rel}:${i + 1}`;
  }
  return rel;
}

// ---- tiny dependency-free YAML frontmatter reader --------------------------
// Supports scalars, block sequences of scalars, inline flow arrays [a, b], and
// inline flow maps { k: v, k2: v2 } (the maker/verifier shape). No nesting beyond
// what D1 uses.

function extractFrontmatterBlock(raw) {
  const clean = raw.replace(/^/, '');
  if (!clean.startsWith('---')) return null;
  const lines = clean.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return null;
  return lines.slice(1, end);
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
    if (c === ',' && depth === 0 && !inS && !inD) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function parseScalar(s) {
  const t = s.trim();
  if (t === '') return '';
  if (t === '[]') return [];
  if (t === '{}') return {};
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
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim();
    const map = {};
    if (inner === '') return map;
    for (const pair of splitTopLevelCommas(inner)) {
      const idx = pair.indexOf(':');
      if (idx === -1) continue;
      const k = unquote(pair.slice(0, idx).trim());
      map[k] = parseScalar(pair.slice(idx + 1).trim());
    }
    return map;
  }
  return unquote(t);
}

function parseBlock(block) {
  const meaningful = block.filter((l) => stripComment(l).trim() !== '');
  if (meaningful.length === 0) return [];
  // Detect block sequence (`- item`) vs block mapping (`key: value`).
  const baseIndent = Math.min(...meaningful.map(leadingSpaces));
  const firstContent = stripComment(meaningful[0]).slice(baseIndent);
  if (firstContent.startsWith('- ') || firstContent.trim() === '-') {
    const items = [];
    for (const l of meaningful) {
      const content = stripComment(l).slice(baseIndent);
      if (content.startsWith('- ')) items.push(parseScalar(content.slice(2).trim()));
      else if (content.trim() === '-') items.push('');
    }
    return items;
  }
  // Block mapping (e.g. the `exit:` sub-keys).
  const map = {};
  for (const l of meaningful) {
    const content = stripComment(l).slice(baseIndent);
    const m = content.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (m) map[m[1]] = parseScalar(m[2].trim());
  }
  return map;
}

/** Parse frontmatter to an object, or throw on a structural problem (R1). */
function parseFrontmatter(raw) {
  const fm = extractFrontmatterBlock(raw);
  if (fm === null) throw new Error('no YAML frontmatter (--- ... --- block) found');
  const obj = {};
  let i = 0;
  while (i < fm.length) {
    const rawLine = fm[i];
    const line = stripComment(rawLine);
    if (line.trim() === '') { i++; continue; }
    if (leadingSpaces(rawLine) !== 0) {
      throw new Error(`unexpected indentation at frontmatter line ${i + 2}`);
    }
    const m = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (!m) throw new Error(`cannot parse frontmatter line ${i + 2}: "${rawLine}"`);
    const key = m[1];
    const rest = m[2].trim();
    if (rest !== '') { obj[key] = parseScalar(rest); i++; continue; }
    // Indented block follows.
    const block = [];
    let j = i + 1;
    while (j < fm.length) {
      const l = fm[j];
      if (stripComment(l).trim() === '') { block.push(l); j++; continue; }
      if (leadingSpaces(l) === 0) break;
      block.push(l);
      j++;
    }
    obj[key] = parseBlock(block);
    i = j;
  }
  return obj;
}

// ---- ref resolution (R6, xref style) ---------------------------------------

/** Extract the ref name from a maker/verifier value: {skill|agent: <name>, ...}. */
function refName(val) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    if (typeof val.skill === 'string' && val.skill !== '') return val.skill;
    if (typeof val.agent === 'string' && val.agent !== '') return val.agent;
  }
  return null;
}

/** A ref resolves if agents/<name>.md or skills/<name>/SKILL.md exists. */
function refResolves(name) {
  if (!name) return false;
  const asAgent = path.join(AGENTS_DIR, `${name}.md`);
  const asSkill = path.join(SKILLS_DIR, name, 'SKILL.md');
  return (fs.existsSync(asAgent) && fs.statSync(asAgent).isFile()) ||
    (fs.existsSync(asSkill) && fs.statSync(asSkill).isFile());
}

/** The model hint on a maker/verifier value, or undefined if absent. */
function modelHint(val) {
  if (val && typeof val === 'object' && !Array.isArray(val) && 'model' in val) {
    return val.model;
  }
  return undefined;
}

/**
 * Locate the evals directory governing a loop file, or null if none is present
 * (R12b). The evals dir is the loop's `done_eval` home and sits as a SIBLING of the
 * `loops/` dir, under the same project root:
 *   - project loop `<proj>/.claude/loops/foo.md` → `<proj>/.claude/evals/`
 *   - library loop `<root>/loops/foo.md`         → `<root>/evals/` or `<root>/.claude/evals/`
 * We look only at the loops-dir's PARENT for a `.claude/evals/` or `evals/` sibling;
 * we deliberately do NOT walk further up, so a distant unrelated `evals/` (e.g. the
 * forge library's own delta-harness `evals/`) never gets pulled in for a fixture two
 * dirs below it. Absence is intentional (the lint fixtures carry no sibling evals
 * dir) — R12b only fires when an evals dir actually exists beside the loops dir.
 */
function findEvalsDir(loopAbs) {
  const loopsParent = path.dirname(path.dirname(loopAbs)); // parent of the loops/ dir
  const candidates = [
    path.join(loopsParent, '.claude', 'evals'),
    path.join(loopsParent, 'evals'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  return null;
}

// ---- per-loop validation ---------------------------------------------------

function validateLoop(abs) {
  const rel = path.relative(ROOT, abs) || path.basename(abs);
  let content;
  try {
    content = fs.readFileSync(abs, 'utf-8');
  } catch (e) {
    err(rel, `R1: unreadable: ${e.message}`);
    return;
  }
  if (content.trim().length === 0) {
    err(rel, 'R1: empty loop file');
    return;
  }

  let fm;
  try {
    fm = parseFrontmatter(content);
  } catch (e) {
    err(`${rel}:1`, `R1: frontmatter does not parse: ${e.message}`);
    return;
  }

  // R1 — all REQUIRED keys present.
  for (const k of REQUIRED_KEYS) {
    if (!(k in fm)) err(rel, `R1: missing key ${k}`);
  }

  // R2 — name kebab-case AND == filename (minus .md).
  if ('name' in fm) {
    const base = path.basename(abs, '.md');
    const name = String(fm.name);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      err(locOf(rel, content, 'name'), `R2: name not kebab-case: ${JSON.stringify(fm.name)}`);
    }
    if (name !== base) {
      err(locOf(rel, content, 'name'), `R2: name/filename mismatch (name=${name}, file=${base})`);
    }
  }

  // R3 — enums.
  if ('tier' in fm && !TIERS.has(String(fm.tier))) {
    err(locOf(rel, content, 'tier'), `R3: invalid enum tier: ${JSON.stringify(fm.tier)} (expected T0|T1|T2)`);
  }
  if ('apply' in fm && !APPLY.has(String(fm.apply))) {
    err(locOf(rel, content, 'apply'), `R3: invalid enum apply: ${JSON.stringify(fm.apply)} (expected auto|draft)`);
  }
  if ('runtime' in fm && !RUNTIMES.has(String(fm.runtime))) {
    err(locOf(rel, content, 'runtime'), `R3: invalid enum runtime: ${JSON.stringify(fm.runtime)} (expected claude-loop|cron|gh-actions|headless)`);
  }

  // R4 — tier T2 => apply draft (a T2 loop may never auto-apply).
  if (String(fm.tier) === 'T2' && String(fm.apply) === 'auto') {
    err(locOf(rel, content, 'apply'), 'R4: T2 loop may not auto-apply (autonomy-ladder); tier T2 requires apply: draft');
  }

  // R5 / R6 — maker / verifier refs.
  const makerRef = refName(fm.maker);
  const verifierRef = refName(fm.verifier);
  if ('maker' in fm && makerRef === null) {
    err(locOf(rel, content, 'maker'), 'R6: unresolvable ref maker (expected { skill|agent: <name> })');
  }
  if ('verifier' in fm && verifierRef === null) {
    err(locOf(rel, content, 'verifier'), 'R6: unresolvable ref verifier (expected { skill|agent: <name> })');
  }
  // R5 — self-verification.
  if (makerRef !== null && verifierRef !== null && makerRef === verifierRef) {
    err(locOf(rel, content, 'verifier'), `R5: self-verification: maker == verifier (${makerRef})`);
  }
  // R6 — refs resolve against the catalog.
  if (makerRef !== null && !refResolves(makerRef)) {
    err(locOf(rel, content, 'maker'), `R6: unresolvable ref ${makerRef} (no agents/${makerRef}.md or skills/${makerRef}/SKILL.md)`);
  }
  if (verifierRef !== null && !refResolves(verifierRef)) {
    err(locOf(rel, content, 'verifier'), `R6: unresolvable ref ${verifierRef} (no agents/${verifierRef}.md or skills/${verifierRef}/SKILL.md)`);
  }

  // R10 — model hints (on maker / verifier).
  for (const role of ['maker', 'verifier']) {
    const hint = modelHint(fm[role]);
    if (hint !== undefined && !MODELS.has(String(hint))) {
      err(locOf(rel, content, role), `R10: invalid model hint on ${role}: ${JSON.stringify(hint)} (expected haiku|sonnet|opus|inherit)`);
    }
  }

  // R7 — exit keys.
  if ('exit' in fm) {
    const exit = fm.exit;
    if (!exit || typeof exit !== 'object' || Array.isArray(exit)) {
      err(locOf(rel, content, 'exit'), 'R7: exit must be a mapping with at least one exit key (queue-dry|cap|budget)');
    } else {
      const keys = Object.keys(exit);
      if (keys.length === 0) {
        err(locOf(rel, content, 'exit'), 'R7: unbounded loop — no exit keys');
      } else {
        const hasCap = 'cap' in exit && Number.isInteger(exit.cap) && exit.cap > 0;
        const hasBudget = 'budget' in exit && Number.isInteger(exit.budget) && exit.budget > 0;
        const hasQueueDry = 'queue-dry' in exit;
        // cap/budget present but non-positive-int is itself a finding.
        if ('cap' in exit && !hasCap) {
          err(locOf(rel, content, 'exit'), `R7: cap must be a positive integer (got ${JSON.stringify(exit.cap)})`);
        }
        if ('budget' in exit && !hasBudget) {
          err(locOf(rel, content, 'exit'), `R7: budget must be a positive integer (got ${JSON.stringify(exit.budget)})`);
        }
        // If queue-dry is the ONLY exit, require cap or budget too.
        if (hasQueueDry && keys.length === 1 && !hasCap && !hasBudget) {
          err(locOf(rel, content, 'exit'), 'R7: unbounded loop — queue-dry-only exit requires cap or budget');
        }
      }
    }
  }

  // R8 — escalation non-empty list of non-empty strings.
  if ('escalation' in fm) {
    const esc = fm.escalation;
    if (!Array.isArray(esc) || esc.length === 0) {
      err(locOf(rel, content, 'escalation'), 'R8: no human decision points — escalation must be a non-empty list');
    } else if (!esc.every((s) => typeof s === 'string' && s.trim() !== '')) {
      err(locOf(rel, content, 'escalation'), 'R8: no human decision points — escalation entries must be non-empty strings');
    }
  }

  // R9 — ledger under .claude/memory/.
  if ('ledger' in fm) {
    const ledger = String(fm.ledger);
    if (!ledger.includes('.claude/memory/')) {
      err(locOf(rel, content, 'ledger'), `R9: ledger outside memory vault — must be under .claude/memory/ (got ${ledger})`);
    }
  }

  // R11 — body sections.
  const body = content.replace(/^/, '');
  if (!/^##\s+Body\s*$/m.test(body)) {
    err(rel, 'R11: missing section ## Body');
  }
  if (!/^##\s+Verification\s*$/m.test(body)) {
    err(rel, 'R11: missing section ## Verification');
  }

  // R12 — done_eval names the eval the verifier grades "done" against.
  // R12a: the key is present and non-empty (the loop's done-criteria binding).
  // (Absence is already counted by R1's REQUIRED_KEYS sweep above; R12a covers the
  // present-but-empty case and re-states the contract by name for the operator.)
  const doneEval = 'done_eval' in fm ? String(fm.done_eval).trim() : '';
  if (!('done_eval' in fm) || doneEval === '') {
    err(locOf(rel, content, 'done_eval'), 'R12a: done_eval missing or empty — the loop must name the eval its verifier grades "done" against');
  } else {
    // R12b: when an evals dir exists beside the loop, done_eval must resolve to a
    // real `<evals>/<done_eval>.md`. No evals dir (fixtures) ⇒ R12b is skipped.
    const evalsDir = findEvalsDir(abs);
    if (evalsDir !== null) {
      const evalFile = path.join(evalsDir, `${doneEval}.md`);
      if (!(fs.existsSync(evalFile) && fs.statSync(evalFile).isFile())) {
        const relEval = path.relative(ROOT, evalFile) || evalFile;
        err(locOf(rel, content, 'done_eval'), `R12b: done_eval does not resolve — no eval at ${relEval} (expected <evals>/${doneEval}.md)`);
      }
    }
  }
}

// ---- collection ------------------------------------------------------------

function collectLoopFiles(dir) {
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

function collectGoodFixtures(dir) {
  if (!fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.startsWith('good-') && f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
}

// ---- main ------------------------------------------------------------------

function main() {
  let targets;

  if (fileArgs.length > 0) {
    // Explicit file mode (negative-fixture + grader use).
    targets = fileArgs.map((f) => path.resolve(f));
  } else {
    // Library scan + always-on positive-fixture self-check.
    const lib = collectLoopFiles(LOOPS_DIR);
    const good = collectGoodFixtures(FIXTURE_DIR);
    targets = [...lib, ...good];

    if (targets.length === 0) {
      // No loops/ dir, no fixtures — clean.
      console.log(`${NAME}: no loops found (loops/ absent) — nothing to validate`);
      console.log(`${NAME}: PASS`);
      process.exit(0);
    }
  }

  for (const abs of targets) validateLoop(abs);

  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `${NAME}: ${targets.length} loop file(s), ${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'PASS'}`
  );
  process.exit(failed ? 1 : 0);
}

main();
