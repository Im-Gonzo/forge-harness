// @ts-check
/**
 * findings — the unified finding shape (C2) and the child-validator parser
 * (ADR-0004, SPEC-09 §"The unified finding"). This is the highest-leverage seam
 * in the manager: every check — whether parsed from a child validator's stderr or
 * emitted directly by a manager module — is the SAME five-field record, so the
 * envelope writer (json-out.mjs) and the `status` composer never branch on origin.
 *
 * The finding (C2):
 *   { level: 'ERROR'|'WARN'|'INFO',   // severity
 *     path:  'agents/code-reviewer.md', // repo-relative path the finding concerns
 *     line:  12 | null,               // 1-based line, or null when not line-scoped
 *     message: 'dangling prose ref: react-reviewer',
 *     source:  'validate-xref.mjs' }  // emitter: validator filename or module noun
 *
 * The parser (ADR-0004): child validators print `LEVEL path:line message` lines.
 * The parent runner (lint/run-all.mjs, tests/run-meta.mjs) captures a child's
 * output and feeds each line here. Lines matching the regex become findings;
 * non-matching lines are banner/summary text and are DROPPED from findings[]
 * (the caller may retain them as `raw` under --strict — that is the caller's
 * concern, not ours).
 *
 * IMPORTANT — which stream(s) to parse: child validators in this repo print their
 * findings to STDERR and their `<name>: ... PASS/FAIL` summary line to STDOUT.
 * A caller parsing a child therefore MUST concatenate BOTH streams (stdout AND
 * stderr) and pass the combined text to parseFindings(); parsing stdout alone
 * would miss every finding, and parsing stderr alone would miss the summary line.
 * The summary line itself does not match the finding regex and is simply dropped,
 * which is the intended behaviour.
 *
 * Conventions: Node ESM, ZERO dependencies (node: builtins only). Fail-open at the
 * public boundary: a malformed line yields null / is skipped, never throws.
 */

/** The three permitted finding severities, in descending order. */
const LEVELS = ['ERROR', 'WARN', 'INFO'];
const LEVEL_SET = new Set(LEVELS);

/**
 * The child-validator finding-line grammar (ADR-0004, SPEC-09):
 *   ^(ERROR|WARN|INFO)\s+(\S+?)(?::(\d+))?\s+(.*)$
 *
 * Group 1 = level; group 2 = path (non-greedy, so a trailing `:<line>` is split
 * off rather than swallowed); group 3 = optional 1-based line number; group 4 =
 * the message. The non-greedy path + optional `:digits` suffix is what lets
 * `ERROR agents/x.md:12 msg` and `ERROR agents/x.md msg` both parse correctly.
 */
const FINDING_RE = /^(ERROR|WARN|INFO)\s+(\S+?)(?::(\d+))?\s+(.*)$/;

/**
 * @typedef {Object} Finding
 * @property {'ERROR'|'WARN'|'INFO'} level Severity.
 * @property {string} path Repo-relative path the finding concerns.
 * @property {number|null} line 1-based line number, or null when not line-scoped.
 * @property {string} message Human-readable description.
 * @property {string} source Emitter: validator filename or manager-module noun.
 */

/**
 * Build a C2 finding from explicit fields (used by manager modules that emit
 * findings directly rather than parsing a child).
 *
 * Validation is lenient and fail-open: an unknown `level` falls back to 'INFO';
 * a `line` that is not a positive integer is normalised to null; missing string
 * fields coerce to ''. The function never throws.
 *
 * @param {Object} fields
 * @param {string} [fields.level] One of ERROR|WARN|INFO (defaults to INFO if unknown).
 * @param {string} [fields.path] Repo-relative path (defaults to '').
 * @param {number|null} [fields.line] 1-based line, or null/omitted when not line-scoped.
 * @param {string} [fields.message] The message (defaults to '').
 * @param {string} [fields.source] The emitter (defaults to '').
 * @returns {Finding} The C2 finding object.
 */
export function makeFinding({ level, path, line, message, source } = {}) {
  const lvl = LEVEL_SET.has(/** @type {string} */ (level)) ? /** @type {Finding['level']} */ (level) : 'INFO';
  return {
    level: lvl,
    path: typeof path === 'string' ? path : '',
    line: normalizeLine(line),
    message: typeof message === 'string' ? message : '',
    source: typeof source === 'string' ? source : '',
  };
}

/**
 * Parse a single `LEVEL path:line message` line into a C2 finding.
 *
 * Returns null when the line is not a finding (banner/summary/blank/garbage) —
 * the caller drops it from findings[] (or retains it as `raw` under --strict).
 *
 * @param {string} line The raw output line (already trimmed of its trailing newline).
 * @param {string} [source] The emitter to stamp on the finding (e.g. the child filename).
 * @returns {Finding|null} The finding, or null when the line does not match.
 */
export function parseFindingLine(line, source = '') {
  if (typeof line !== 'string') return null;
  const m = FINDING_RE.exec(line);
  if (!m) return null;
  return {
    level: /** @type {Finding['level']} */ (m[1]),
    path: m[2],
    line: m[3] === undefined ? null : Number.parseInt(m[3], 10),
    message: m[4],
    source: typeof source === 'string' ? source : '',
  };
}

/**
 * Parse a block of text (a captured child's stdout+stderr) into C2 findings.
 *
 * The text is split on newlines; each line is run through {@link parseFindingLine}
 * and matching lines are collected in order. Non-matching lines (banners, the
 * `<name>: PASS/FAIL` summary, blanks) are silently dropped. Fail-open: a
 * non-string input yields [].
 *
 * NOTE on streams (see module header): when the text comes from a child validator,
 * the caller MUST pass stdout and stderr concatenated — findings are printed to
 * stderr while the summary is printed to stdout.
 *
 * @param {string} text The combined child output to scan.
 * @param {string} [source] The emitter stamped on every finding (the child filename).
 * @returns {Finding[]} The findings, in source order (possibly empty).
 */
export function parseFindings(text, source = '') {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const f = parseFindingLine(raw, source);
    if (f) out.push(f);
  }
  return out;
}

/**
 * Normalise a line value to a positive integer or null (fail-open).
 * @param {unknown} line
 * @returns {number|null}
 */
function normalizeLine(line) {
  if (line === null || line === undefined) return null;
  const n = typeof line === 'number' ? line : Number.parseInt(String(line), 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}
