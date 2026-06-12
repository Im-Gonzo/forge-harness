// @ts-check
/**
 * constants — the ONE place the efficiency dimension's tunable numbers live
 * (SPEC-06 §Design "constants.mjs", BR-EFF-001/008, ADR-0013).
 *
 * Two estimator constants and two adequacy thresholds. Keeping them here — and
 * NOWHERE else — is load-bearing: EVAL-EFF-001 proves the estimator reads
 * `CODE_DENSITY` from this module (not an inlined `1.15`), and a meta-test pins the
 * adequacy thresholds so a change is a deliberate, reviewed edit (ADR-0013). Inlining
 * any of these elsewhere is a defect.
 *
 * HARD INVARIANTS: zero runtime deps (this file is pure data — no imports at all);
 * additive-never-destructive (only widen the set, never repurpose a name).
 *
 * @module manager/analyze/constants
 */

/** Characters per token for the char half of the blended estimator (BR-EFF-001). */
export const CHARS_PER_TOKEN = 4;

/** Density multiplier applied to code/JSON-dense artifacts (BR-EFF-001). */
export const CODE_DENSITY = 1.15;

/** Word→token inflation for the word half of the blended estimator (BR-EFF-001). */
export const WORDS_PER_TOKEN = 1.33;

/**
 * Minimum sessions for a *dynamic*-dead verdict to be `prune`-eligible (BR-EFF-008,
 * ADR-0013). Below this, a never-fired `normal` artifact downgrades to `watch`.
 */
export const MIN_SESSIONS = 20;

/**
 * Minimum window (days) for a *dynamic*-dead verdict to be `prune`-eligible
 * (BR-EFF-008, ADR-0013). Below this, downgrade to `watch`.
 */
export const MIN_DAYS = 14;

/**
 * Default activation probability for a CONDITIONAL artifact when telemetry cannot
 * supply a per-artifact rate (SPEC-06 §Open questions). v0.3 uses a fixed default;
 * the conditional-ceiling assumes worst-case (every conditional active), so this is
 * only used where a probabilistic figure is wanted, never for the ceiling itself.
 */
export const DEFAULT_ACTIVATION = 0.5;

/**
 * A named `toString` so the ES module NAMESPACE coerces to a string cleanly. A bare
 * namespace has a null prototype and no `@@toPrimitive`, so `String(ns)` / a template
 * literal `${ns}` throws "Cannot convert object to primitive value" — which a test that
 * embeds the imported namespace in a diagnostic message string (EVAL-EFF-001) trips on
 * during EAGER argument evaluation, before any assertion runs. Exporting `toString`
 * makes `[[Get]](ns, 'toString')` resolve to this function, so the coercion succeeds.
 * Purely additive: it does not shadow any constant and is ignored by every real caller.
 *
 * @returns {string}
 */
export function toString() {
  return `[forge analyze constants CHARS_PER_TOKEN=${CHARS_PER_TOKEN} CODE_DENSITY=${CODE_DENSITY}]`;
}

export default {
  CHARS_PER_TOKEN,
  CODE_DENSITY,
  WORDS_PER_TOKEN,
  MIN_SESSIONS,
  MIN_DAYS,
  DEFAULT_ACTIVATION,
  toString,
};
