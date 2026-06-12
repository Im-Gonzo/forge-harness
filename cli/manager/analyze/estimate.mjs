// @ts-check
/**
 * estimate — the zero-dependency token estimator (SPEC-06 §"Token estimator",
 * BR-EFF-001). A blended char/word heuristic that RANKS and TOTALS; it never claims
 * tokenizer accuracy, so every figure it feeds a human is rendered with a leading `~`.
 *
 * Formula (read its two tunables from `constants.mjs`, never inlined):
 *   base  = round( 0.5 * ceil(chars / CHARS_PER_TOKEN) + 0.5 * ceil(words * WORDS_PER_TOKEN) )
 *   value = dense ? round(base * CODE_DENSITY) : base
 *
 * `dense = true` for code/JSON-dense artifacts (validators, engine, `*.json`,
 * fenced-code-heavy bodies). `chars` is the raw character count; `words` is the
 * whitespace-split token count (0 for empty/whitespace-only text).
 *
 * HARD INVARIANTS: zero runtime deps (node builtins + the relative constants import);
 * fail-open — a non-string input estimates to 0, never throws. PURE: same input →
 * same output, no I/O.
 *
 * @module manager/analyze/estimate
 */

import { CHARS_PER_TOKEN, CODE_DENSITY, WORDS_PER_TOKEN } from './constants.mjs';

/**
 * Count whitespace-delimited words in `text` (0 for empty/whitespace-only).
 * @param {string} text
 * @returns {number}
 */
function wordCount(text) {
  const t = text.trim();
  if (t.length === 0) return 0;
  return t.split(/\s+/).length;
}

/**
 * Estimate the token cost of `text`. Applies CODE_DENSITY when `dense` is true.
 * Fail-open: a non-string input returns 0. Always a non-negative integer.
 *
 * @param {string} text the artifact text (body, description, or injection literal)
 * @param {boolean} [dense=false] true for code/JSON-dense artifacts
 * @returns {number} the estimated token count (a non-negative integer)
 */
export function estimate(text, dense = false) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const chars = text.length;
  const words = wordCount(text);
  const base = Math.round(
    0.5 * Math.ceil(chars / CHARS_PER_TOKEN) + 0.5 * Math.ceil(words * WORDS_PER_TOKEN),
  );
  const value = dense ? Math.round(base * CODE_DENSITY) : base;
  return value >= 0 ? value : 0;
}

/** Alias kept for callers that probe `estimateTokens` (resolveExport tolerance). */
export const estimateTokens = estimate;

export default { estimate, estimateTokens };
