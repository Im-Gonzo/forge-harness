// @ts-check
/**
 * residency — classify each artifact into a residency class and compute its
 * model-context token cost per class (SPEC-06 §"Residency classes", BR-EFF-002).
 *
 *   ALWAYS-ON  — always-on rule **bodies** (no `paths:`); agent/skill/command
 *                **descriptions**; a hook's **description + injection literal**. Full estimate.
 *   CONDITIONAL — path-scoped rule bodies (`paths:` present); agent/skill bodies; bundles.
 *   ON-DEMAND  — validators; engine scripts. Cost **0** (source never enters context).
 *
 * The single subtlety is the HOOK: its `.mjs` source is NEVER counted. A hook costs
 * its `hooks.json` description PLUS the estimated injection it writes to stdout,
 * obtained by extracting the `permissionDecisionReason` / `additionalContext` string
 * literals out of the `.mjs` and estimating those (SPEC-06 §Residency, the secret-scan
 * example). A rule's "has `paths:`" is read directly from its frontmatter fence (the
 * shared frontmatter parser intentionally ignores `paths:`, so we detect it here).
 *
 * HARD INVARIANTS: zero runtime deps (node builtins + relative imports); fail-open —
 * a missing/unreadable artifact degrades to a 0-cost record, never throws. PURE per
 * artifact: the caller passes the already-read text; this module does no disk I/O
 * except the hook-source read it is explicitly handed a path for.
 *
 * @module manager/analyze/residency
 */

import fs from 'node:fs';

import { estimate } from './estimate.mjs';

/** Residency class tokens (SPEC-06). */
export const ALWAYS_ON = 'always-on';
export const CONDITIONAL = 'conditional';
export const ON_DEMAND = 'on-demand';

/** Registry kinds whose source never enters model context (cost 0). */
const ON_DEMAND_KINDS = new Set(['validator', 'meta-test', 'engine']);

/** Registry kinds that are code/JSON-dense (estimate with CODE_DENSITY). */
const DENSE_KINDS = new Set(['validator', 'meta-test', 'engine']);

/**
 * Does a markdown artifact's frontmatter declare a non-empty `paths:` scope?
 * Read straight off the leading `--- … ---` fence (the shared parser drops `paths:`).
 * Recognises both inline (`paths: ["**\/*.ts"]`) and block-list forms. Fail-open: a
 * malformed/absent fence yields false (→ always-on).
 *
 * @param {string} text raw artifact text
 * @returns {boolean}
 */
export function hasPathsScope(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const clean = text.replace(/^\uFEFF/, '');
  const m = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return false;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const km = line.match(/^paths\s*:(.*)$/);
    if (!km) continue;
    const rest = km[1].trim();
    // Inline list with at least one entry: paths: ["a", "b"] or paths: [a].
    if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\]\s*$/, '').trim();
      return inner.length > 0;
    }
    // Inline scalar (rare): paths: "**/*.ts"
    if (rest.length > 0) return true;
    // Empty value → a block list may follow on indented `- …` lines.
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*-\s+\S/.test(lines[j])) return true;
      if (/^\S/.test(lines[j])) break; // next top-level key ends the block
    }
    return false;
  }
  return false;
}

/**
 * Extract the glob patterns from a rule's `paths:` frontmatter as a string[] (used by
 * D5 vacuous-rule detection). Returns [] when there is no `paths:` scope. Tolerant of
 * inline and block-list forms; strips surrounding quotes. Fail-open.
 *
 * @param {string} text raw rule text
 * @returns {string[]}
 */
export function extractPathGlobs(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const clean = text.replace(/^\uFEFF/, '');
  const m = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = lines[i].match(/^paths\s*:(.*)$/);
    if (!km) continue;
    const rest = km[1].trim();
    if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\]\s*$/, '').trim();
      if (inner === '') return [];
      return inner
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
    }
    if (rest.length > 0) return [unquote(rest)];
    // Block list.
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s*-\s+(.*)$/);
      if (item) {
        const v = unquote(item[1].trim());
        if (v) out.push(v);
        continue;
      }
      if (/^\S/.test(lines[j])) break;
    }
    return out;
  }
  return [];
}

/** Strip one layer of surrounding single/double quotes. @param {string} s */
function unquote(s) {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Pull the always-on injection literals out of a hook's `.mjs` source: the
 * `permissionDecisionReason` and `additionalContext` string literals it writes to
 * stdout (SPEC-06 §Residency). Returns the concatenated literal text (estimated by
 * the caller). Fail-open: an unreadable source yields ''.
 *
 * @param {string} source hook `.mjs` source text
 * @returns {string}
 */
export function extractInjectionText(source) {
  if (typeof source !== 'string' || source.length === 0) return '';
  const out = [];
  // Match `permissionDecisionReason: "…"` / `additionalContext: "…"` (single or double
  // quoted). Non-greedy, allows escaped quotes inside the literal.
  const re = /(?:permissionDecisionReason|additionalContext)\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push(m[2]);
  }
  return out.join(' ');
}

/**
 * Classify one artifact and compute its residency + estimated cost.
 *
 * @param {Object} a
 * @param {string} a.kind registry kind (singular: rule/agent/skill/command/bundle/validator/engine/meta-test/hook)
 * @param {string} [a.text] the artifact's raw text (markdown source) — required for rules/agents/skills/commands/bundles
 * @param {string} [a.description] the artifact's description (from frontmatter or hooks.json) — for agent/skill/command/hook
 * @param {string} [a.hookSource] the hook's `.mjs` source path OR text — for hooks (injection extraction)
 * @returns {{residency:string, estTokens:number, costBreakdown?:Object}}
 */
export function classify(a) {
  const kind = a && typeof a.kind === 'string' ? a.kind : '';
  const text = typeof a.text === 'string' ? a.text : '';
  const description = typeof a.description === 'string' ? a.description : '';

  // ON-DEMAND: validators, engine, meta-tests never enter context.
  if (ON_DEMAND_KINDS.has(kind)) {
    return { residency: ON_DEMAND, estTokens: 0 };
  }

  // HOOK: always-on = description + injection literal. The .mjs source is NEVER counted.
  if (kind === 'hook') {
    const descCost = estimate(description, false);
    let injectionText = '';
    if (typeof a.hookSource === 'string' && a.hookSource.length > 0) {
      injectionText = extractInjectionText(readMaybeFile(a.hookSource));
    }
    const injectionCost = estimate(injectionText, false);
    return {
      residency: ALWAYS_ON,
      estTokens: descCost + injectionCost,
      costBreakdown: { description: descCost, injection: injectionCost },
    };
  }

  // RULE: no `paths:` → always-on (full body); `paths:` present → conditional (full body).
  if (kind === 'rule') {
    const conditional = hasPathsScope(text);
    return {
      residency: conditional ? CONDITIONAL : ALWAYS_ON,
      estTokens: estimate(bodyOf(text), false),
    };
  }

  // AGENT / SKILL / COMMAND: description is ALWAYS-ON; the body is CONDITIONAL.
  // The always-on figure (what is resident every turn) is the DESCRIPTION cost.
  if (kind === 'agent' || kind === 'skill' || kind === 'command') {
    const descCost = estimate(description, false);
    return {
      residency: ALWAYS_ON,
      estTokens: descCost,
      costBreakdown: { description: descCost, body: estimate(bodyOf(text), false) },
    };
  }

  // BUNDLE: conditional (loaded on demand into context when its skill runs).
  if (kind === 'bundle') {
    const dense = DENSE_KINDS.has(kind);
    return { residency: CONDITIONAL, estTokens: estimate(bodyOf(text), dense) };
  }

  // Fallback: treat unknown kinds as conditional bodies (fail-open, never 0-silently).
  return { residency: CONDITIONAL, estTokens: estimate(text, DENSE_KINDS.has(kind)) };
}

/** Strip the leading frontmatter fence, returning the body (fail-open to full text). */
function bodyOf(text) {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/^\uFEFF/, '');
  const m = clean.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n([\s\S]*))?$/);
  return m ? m[1] ?? '' : clean;
}

/**
 * If `s` is a path to an existing file, return its contents; otherwise return `s`
 * verbatim (so a caller can pass either a path or already-read text). Fail-open.
 * @param {string} s
 * @returns {string}
 */
function readMaybeFile(s) {
  try {
    if (fs.existsSync(s) && fs.statSync(s).isFile()) {
      return fs.readFileSync(s, 'utf8');
    }
  } catch {
    /* fall through */
  }
  return s;
}

export default { classify, hasPathsScope, extractPathGlobs, extractInjectionText, ALWAYS_ON, CONDITIONAL, ON_DEMAND };
