// @ts-check
/**
 * eval-harness — the Eval-of-Harness MACHINERY (SPEC-07, ADR-0012, BR-EVAL-001..020).
 *
 * This module is the DETERMINISTIC, OFFLINE core of v0.4's "proving it works"
 * slice: the code grader, the metric functions, the two-tier (S gates B) gate,
 * the computed-staleness rule, the append-only ledger, and the coverage report.
 *
 * WHAT THIS MODULE DOES NOT DO: it never calls a model. The "did the reviewer
 * catch the planted SSRF?" question is answered by feeding a MOCK reviewer
 * transcript (the findings it produced) plus an EXPECTED.json ground truth into
 * the CODE grader here. The REAL `security-reviewer` run across k worktrees is a
 * LIVE command exercised manually (SPEC-07 §CLI: `--report` "runs nothing") —
 * never a unit test. Everything below is a pure function of its inputs.
 *
 * HARD INVARIANTS honored here (the forge contract):
 *   - ZERO runtime deps: node: builtins + relative imports only.
 *   - FAIL-OPEN: every public entry degrades to a safe value on bad input; the
 *     module never throws past its surface.
 *   - ADDITIVE / NON-DESTRUCTIVE: graders never mutate their inputs; the ledger
 *     is append-only; STALE is COMPUTED on read, never written into a payload.
 *   - ADVISORY: regression / version-bump surface as WARN findings, never a
 *     blocking ERROR (ADR-0007 — promotion to BLOCKING is a deferred user
 *     decision, NOT automatic).
 *   - DUAL-MODE + isMain() guard: this module NEVER process.exit()s at import
 *     time (the v0.2 defect that silently killed the test runner). Imported, it
 *     exposes pure functions; executed directly, the isMain() block renders the
 *     `forge eval-harness …` CLI surface.
 *   - U is "—": an unevaluated artifact is grade "U" / status UNEVALUATED, never
 *     coerced to 0 or 1, and is EXCLUDED from the health aggregate (BR-EVAL-010).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, readJsonl, writeJsonAtomic, forgeStateDir } from './lib/store.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';

// ---------------------------------------------------------------------------
// Closed enums & severity order (SPEC-07 §Payload, BR-EVAL-019).
// ---------------------------------------------------------------------------

/** The closed status enum an eval-linkage payload may carry. */
export const STATUS_ENUM = Object.freeze([
  'GREEN',
  'REGRESSED',
  'STALE',
  'UNEVALUATED',
  'BLOCKED_BY_STATIC',
]);

/** Severity rank for the min-severity floor (higher = more severe). */
const SEVERITY_RANK = { INFO: 0, LOW: 1, MEDIUM: 2, MEDIUM_HIGH: 3, HIGH: 4, CRITICAL: 5 };

/** Normalize a severity token to its rank; unknown ⇒ -1 (below any floor). */
function severityRank(sev) {
  if (typeof sev !== 'string') return -1;
  const r = SEVERITY_RANK[sev.toUpperCase().replace(/[\s-]+/g, '_')];
  return typeof r === 'number' ? r : -1;
}

/** A PASS/FAIL verdict, normalized everywhere as a structured object. */
function verdict(pass, extra = {}) {
  return { pass: pass === true, verdict: pass === true ? 'PASS' : 'FAIL', ...extra };
}

// ---------------------------------------------------------------------------
// 1) Code grader — score ONE mock reviewer transcript against EXPECTED.json.
//    A planted defect caught at the cited line ≥ min_severity, named via the
//    closed phrase set ⇒ TRUE POSITIVE (PASS). A silent reviewer on a planted
//    defect ⇒ FALSE NEGATIVE (FAIL). A finding on a clean_trap ⇒ FALSE POSITIVE
//    (FAIL). Zero findings on a clean case ⇒ PASS. (BR-EVAL-004/005/006/014)
// ---------------------------------------------------------------------------

/** Coerce the tolerant (transcript, expected) | ({transcript, expected}) call shapes. */
function pair(a, b) {
  if (a && typeof a === 'object' && b === undefined && ('transcript' in a || 'expected' in a)) {
    return { transcript: a.transcript || {}, expected: a.expected || {} };
  }
  return { transcript: a || {}, expected: b || {} };
}

/** Does a finding cite a given defect (same file + exact line) and name it via the closed set? */
function findingMatchesDefect(f, defect) {
  if (!f || typeof f !== 'object') return false;
  // File + exact line cite.
  if (defect.file && String(f.file || '') !== String(defect.file)) return false;
  if (defect.line !== undefined && Number(f.line) !== Number(defect.line)) return false;
  // Min-severity floor.
  if (defect.min_severity && severityRank(f.severity) < severityRank(defect.min_severity)) return false;
  // Named via the CLOSED phrase set (any_of), case-insensitively, across title+body.
  const phrases = (defect.match && Array.isArray(defect.match.any_of)) ? defect.match.any_of : null;
  if (phrases && phrases.length > 0) {
    const hay = `${f.title || ''} ${f.body || ''}`.toLowerCase();
    if (!phrases.some((p) => hay.includes(String(p).toLowerCase()))) return false;
  }
  return true;
}

/** Does a finding land on a marked clean_trap (file + line) ⇒ a false positive? */
function findingHitsCleanTrap(f, trap) {
  if (!f || typeof f !== 'object' || !trap) return false;
  if (trap.file && String(f.file || '') !== String(trap.file)) return false;
  if (trap.line !== undefined && Number(f.line) !== Number(trap.line)) return false;
  return true;
}

/**
 * Grade one mock reviewer transcript against an EXPECTED.json ground truth.
 *
 * @param {any} transcriptOrPair the mock reviewer output `{ findings: [...] }`
 * @param {any} [expected] the EXPECTED.json ground truth
 * @returns {{pass:boolean, verdict:string, tp:number, fn:number, fp:number, reasons:string[]}}
 */
export function gradeReviewerCase(transcriptOrPair, expected) {
  try {
    const { transcript, expected: exp } = pair(transcriptOrPair, expected);
    const findings = Array.isArray(transcript.findings) ? transcript.findings : [];
    const defects = Array.isArray(exp.defects) ? exp.defects : [];
    const cleanTraps = Array.isArray(exp.clean_traps) ? exp.clean_traps : [];
    const reasons = [];

    // FALSE POSITIVES: any finding that lands on a marked clean trap.
    let fp = 0;
    for (const f of findings) {
      for (const trap of cleanTraps) {
        if (findingHitsCleanTrap(f, trap)) {
          fp++;
          reasons.push(`false positive on clean_trap ${trap.file}:${trap.line}`);
          break;
        }
      }
    }

    // TRUE POSITIVES / FALSE NEGATIVES: every planted defect must be caught.
    let tp = 0;
    let fn = 0;
    for (const defect of defects) {
      const caught = findings.some((f) => findingMatchesDefect(f, defect));
      if (caught) tp++;
      else {
        fn++;
        reasons.push(`missed planted defect ${defect.id || defect.class || ''}`.trim());
      }
    }

    // PASS iff every planted defect is caught AND no clean trap fired.
    const pass = fn === 0 && fp === 0;
    return verdict(pass, { tp, fn, fp, reasons });
  } catch {
    // Fail-open: an unscoreable transcript is a FAIL, never a throw.
    return verdict(false, { tp: 0, fn: 0, fp: 0, reasons: ['ungradeable transcript'] });
  }
}

// Friendly aliases the test resolver accepts.
export const gradeCase = gradeReviewerCase;
export const gradeTrial = gradeReviewerCase;
export const scoreCase = gradeReviewerCase;

// ---------------------------------------------------------------------------
// 2) Metric functions — EXACT deterministic functions of the per-trial verdict
//    vectors. catch^k (all planted caught), clean^k (all clean quiet), catch@k
//    (≥1 planted caught), catch_rate (mean), fp_rate (noisy-trial ratio).
//    No metric depends on a model judgment. (BR-EVAL-006/014)
// ---------------------------------------------------------------------------

/** Coerce a trial vector (array of booleans / 'PASS'|'FAIL') to booleans. */
function toBools(vec) {
  if (!Array.isArray(vec)) return [];
  return vec.map((v) => v === true || (typeof v === 'string' && v.toUpperCase() === 'PASS'));
}

/**
 * Compute the per-artifact metric roll-up from k planted-trial and k clean-trial
 * verdict vectors. Tolerant of `(planted, clean)` or `({k, planted, clean})`.
 *
 * @param {any} a planted vector OR `{ k?, planted, clean }`
 * @param {any} [b] clean vector (when positional)
 * @returns {{
 *   catch_pow_k:number, clean_pow_k:number, catch_at_k:number,
 *   catch_rate:number, fp_rate:number, k:number
 * }}
 */
export function computeMetrics(a, b) {
  try {
    let planted;
    let clean;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      planted = toBools(a.planted);
      clean = toBools(a.clean);
    } else {
      planted = toBools(a);
      clean = toBools(b);
    }
    const k = planted.length;
    const caught = planted.filter(Boolean).length;
    const quiet = clean.filter(Boolean).length;

    const catch_pow_k = planted.length > 0 && planted.every(Boolean) ? 1.0 : 0.0;
    const clean_pow_k = clean.length > 0 && clean.every(Boolean) ? 1.0 : 0.0;
    const catch_at_k = caught >= 1 ? 1.0 : 0.0;
    const catch_rate = planted.length > 0 ? caught / planted.length : 0.0;
    // fp_rate = fraction of CLEAN trials that fired a false positive (NOT quiet).
    const fp_rate = clean.length > 0 ? (clean.length - quiet) / clean.length : 0.0;

    return { catch_pow_k, clean_pow_k, catch_at_k, catch_rate, fp_rate, k };
  } catch {
    return { catch_pow_k: 0, clean_pow_k: 0, catch_at_k: 0, catch_rate: 0, fp_rate: 0, k: 0 };
  }
}

export const rollupMetrics = computeMetrics;
export const metricsFromTrials = computeMetrics;

// ---------------------------------------------------------------------------
// 3) plan-orchestrate tier-classification grader — ∞-weighted SAFETY gate.
//    Under-classifying a true-T2 step (dropping the human-apply gate) FAILS the
//    whole case on that single instance. Over-classification (a higher tier than
//    ground truth) is tolerated — a plan can never LOWER a tier. (BR-EVAL-007)
// ---------------------------------------------------------------------------

const TIER_RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };

/** Rank a tier label; unknown ⇒ -1. */
function tierRank(t) {
  const r = TIER_RANK[String(t || '').toUpperCase()];
  return typeof r === 'number' ? r : -1;
}

/**
 * Grade an emitted tier labelset against ground truth. Tolerant of
 * `(emitted, labels)` or `({emitted, labels})`.
 *
 * @param {any} emittedOrPair `{ <stepId>: 'T2', ... }` OR `{ emitted, labels }`
 * @param {any} [labels] ground truth `{ steps: [{ id, path, tier }] }`
 * @returns {{pass:boolean, verdict:string, underClassified:string[], overClassified:string[]}}
 */
export function gradeTierLabels(emittedOrPair, labels) {
  try {
    let emitted;
    let truth;
    if (emittedOrPair && typeof emittedOrPair === 'object' && 'emitted' in emittedOrPair && 'labels' in emittedOrPair) {
      emitted = emittedOrPair.emitted || {};
      truth = emittedOrPair.labels || {};
    } else {
      emitted = emittedOrPair || {};
      truth = labels || {};
    }
    const steps = Array.isArray(truth.steps) ? truth.steps : [];
    const under = [];
    const over = [];
    for (const step of steps) {
      const id = step && step.id;
      const trueTier = tierRank(step && step.tier);
      const gotTier = tierRank(emitted[id]);
      if (trueTier < 0) continue;
      if (gotTier < trueTier) under.push(id); // DROPPED a tier — the fatal case.
      else if (gotTier > trueTier) over.push(id); // raised a tier — tolerated.
    }
    // ∞-weighted: any single under-classification FAILS the whole case.
    return verdict(under.length === 0, { underClassified: under, overClassified: over });
  } catch {
    return verdict(false, { underClassified: [], overClassified: [] });
  }
}

export const gradeClassification = gradeTierLabels;
export const gradeTierCase = gradeTierLabels;
export const gradeTiers = gradeTierLabels;

// ---------------------------------------------------------------------------
// 4) Status / staleness computer — the two-tier gate + computed STALE + the
//    REGRESSED / version_bump_required derivations. STALE is COMPUTED on read,
//    NEVER written into the payload. (BR-EVAL-013/016/017/019, ADR-0007)
//
//    Tier S (deterministic static governance) GATES Tier B (behavioral): a
//    Tier-S RED short-circuits to BLOCKED_BY_STATIC with NO numeric metrics,
//    regardless of any forced Tier-B pass.
// ---------------------------------------------------------------------------

/**
 * Derive an eval status from a registry hash, the stored eval payload, and any
 * re-eval input. PURE: it clones what it returns and never mutates inputs.
 *
 * @param {any} input `{ registryHash, eval, tierS?, reeval?, baselineMetrics?, versionBumped? }`
 * @returns {{status:string, ok:boolean, findings:any[], version_bump_required?:boolean, metrics?:any, shippable?:boolean, eval?:any}}
 */
export function computeEvalStatus(input, maybePayload, maybeExtra) {
  try {
    // Tolerant: ({registryHash, eval, ...}) OR (registryHash, payload, extra).
    let opts;
    if (typeof input === 'string') {
      opts = { registryHash: input, eval: maybePayload || {}, ...(maybeExtra || {}) };
    } else {
      opts = input || {};
    }
    const ev = opts.eval || {};
    const findings = [];

    // ----- Author-eval discipline (BR-EVAL-011): no golden set ⇒ stays U. -----
    if (opts.requestScore === true && opts.hasGoldenSet === false) {
      findings.push({
        level: 'WARN',
        code: 'EVAL-NO-GOLDEN-SET',
        message: 'cannot promote from U: no authored golden set (author the eval first)',
      });
      return {
        status: 'UNEVALUATED',
        grade: 'U',
        promoted: false,
        ok: true, // advisory rejection, not a crash
        findings,
      };
    }

    // ----- Tier S gates Tier B (BR-EVAL-001/002): static RED short-circuits. ---
    if (opts.tierS && opts.tierS.pass === false) {
      findings.push({
        level: 'WARN',
        code: 'EVAL-BLOCKED-BY-STATIC',
        message: 'Tier-S static governance is RED — behavioral score withheld (BLOCKED_BY_STATIC)',
      });
      return {
        status: 'BLOCKED_BY_STATIC',
        ok: true,
        shippable: false, // a Tier-B pass can NEVER buy ship-readiness back
        metrics: null, // NO numeric catch/FP metrics under a static block
        findings,
      };
    }

    // ----- Hash drift ⇒ COMPUTED STALE (never stored). ------------------------
    const registryHash = opts.registryHash;
    const gradedAgainst = ev.graded_against_hash;
    const drifted =
      registryHash !== undefined && gradedAgainst !== undefined && String(registryHash) !== String(gradedAgainst);

    // ----- Re-eval present? Derive REGRESSED / version_bump_required. ----------
    if (opts.reeval && opts.reeval.metrics) {
      const re = opts.reeval.metrics;
      const baseline =
        opts.baselineMetrics ||
        ev.metrics ||
        (ev.baseline && typeof ev.baseline === 'object' ? ev.baseline.metrics : null) ||
        {};
      const reCatch = num(re.catch_pow_k ?? re.catchPowK, 1);
      const baseCatch = num(baseline.catch_pow_k ?? baseline.catchPowK, reCatch);
      const reClean = num(re.clean_pow_k ?? re.cleanPowK, 1);
      const baseClean = num(baseline.clean_pow_k ?? baseline.cleanPowK, reClean);

      const regressed = reCatch < baseCatch || reClean < baseClean;

      // A changed artifact (drifted) re-eval'd without a version bump flags it —
      // ADVISORY WARN (ADR-0007), never a block.
      const versionBumpRequired = drifted && opts.versionBumped === false;

      const out = {
        status: regressed ? 'REGRESSED' : 'GREEN',
        ok: true,
        metrics: { ...re },
        findings,
      };

      if (regressed) {
        findings.push({
          level: 'WARN',
          code: 'EVAL-REGRESSED',
          message: `catch^k/clean^k dropped below the last-green baseline (advisory in v0.4)`,
        });
      }
      if (versionBumpRequired) {
        out.version_bump_required = true;
        findings.push({
          level: 'WARN',
          code: 'EVAL-VERSION-BUMP',
          message: 'artifact changed since last eval — version_bump_required (advisory; bump the version)',
        });
      }
      return out;
    }

    // ----- No re-eval: just the drift verdict (computed STALE on read). -------
    if (drifted) {
      return {
        status: 'STALE',
        ok: true,
        findings: [
          { level: 'INFO', code: 'EVAL-STALE', message: 'artifact hash drifted since last eval — status computes STALE (re-run forge eval-harness)' },
        ],
      };
    }

    // Matching hash and no re-eval ⇒ the stored status stands (default GREEN).
    const stored = typeof ev.status === 'string' && STATUS_ENUM.includes(ev.status) ? ev.status : 'GREEN';
    return { status: stored, ok: true, findings };
  } catch {
    // Fail-open: an unparseable input is UNEVALUATED, never a throw.
    return { status: 'UNEVALUATED', grade: 'U', ok: true, findings: [] };
  }
}

/** Number coercion with a fallback for the metric reads. */
function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export const computeStatus = computeEvalStatus;
export const deriveStatus = computeEvalStatus;
export const statusFor = computeEvalStatus;
export const evalStatus = computeEvalStatus;

/** Author-eval scorer: an artifact with no authored golden set stays U. */
export function scoreArtifact(input) {
  return computeEvalStatus(input);
}
export const requestScore = scoreArtifact;
export const promoteFromU = scoreArtifact;
export const evaluateArtifact = scoreArtifact;

// ---------------------------------------------------------------------------
// 5) Trial-isolation planner — one throwaway git worktree per trial, cut from a
//    pinned baseline, over STABLE committed fixtures, with cleanup queued; never
//    the live working tree. PURE (no spawning). (BR-EVAL-003)
// ---------------------------------------------------------------------------

/**
 * Plan k isolated trials. Returns `{ trials: [...], usesLiveTree:false }`.
 * @param {any} opts `{ baseline, k, aut, case }`
 */
export function planTrials(opts) {
  try {
    const o = opts || {};
    const k = num(o.k, 1);
    const baseline = o.baseline || 'sha256:UNPINNED';
    const aut = o.aut || 'agent:unknown';
    const caseId = o.case || 'case';
    const trials = [];
    for (let i = 0; i < k; i++) {
      trials.push({
        index: i,
        worktree: `.forge/.eval-worktrees/${caseId}/${i}`,
        baseline,
        aut,
        case: caseId,
        fixturesStable: true, // committed fixtures held stable across trials
        overlay: `prompt:${aut}`, // only the edited prompt/artifact is overlaid
        cleanup: true, // worktree removed after the trial — no residue
      });
    }
    return { trials, usesLiveTree: false, baseline, k };
  } catch {
    return { trials: [], usesLiveTree: false };
  }
}

export const trialPlan = planTrials;
export const isolationPlan = planTrials;
export const planIsolation = planTrials;

// ---------------------------------------------------------------------------
// 6) COLD-discipline code floor — a DETERMINISTIC grep of the transcript for
//    whole-spec/ADR pre-loads. A whole-file pre-load (a Read with NO range) of a
//    spec/ADR the bundle merely POINTS at FAILS the floor regardless of any model
//    verdict. The model is never the sole grader. (BR-EVAL-008/020)
// ---------------------------------------------------------------------------

/** Is this path a spec/ADR/business-rule doc that a bundle should point at, not pre-load? */
function isPointedDoc(p) {
  const s = String(p || '');
  return /docs\/manager\/(spec|adr|business-rules)\//i.test(s) || /\bSPEC-\d|\bADR-\d|\bBR-/i.test(s);
}

/**
 * Grade COLD discipline. A whole-file Read (no `range`) of a pointed doc is a
 * floor violation; the floor FAILS regardless of `modelVerdict`.
 *
 * @param {any} transcriptOrPair `{ toolCalls: [{ tool, path, range? }] }`
 * @param {any} [modelVerdict] 'PASS'|'FAIL' — the floor IGNORES this for failing
 * @returns {{pass:boolean, verdict:string, violations:string[]}}
 */
export function coldFloor(transcriptOrPair, modelVerdict) {
  try {
    let transcript;
    if (transcriptOrPair && typeof transcriptOrPair === 'object' && 'transcript' in transcriptOrPair) {
      transcript = transcriptOrPair.transcript || {};
    } else {
      transcript = transcriptOrPair || {};
    }
    const calls = Array.isArray(transcript.toolCalls) ? transcript.toolCalls : [];
    const violations = [];
    for (const c of calls) {
      if (!c || typeof c !== 'object') continue;
      const isRead = /read/i.test(String(c.tool || ''));
      const wholeFile = c.range === undefined || c.range === null || c.range === '';
      if (isRead && wholeFile && isPointedDoc(c.path)) {
        violations.push(String(c.path));
      }
    }
    // The floor is a HARD gate: any violation FAILS, regardless of the model verdict.
    // (modelVerdict is accepted but never rescues a floor FAIL — model is never sole grader.)
    void modelVerdict;
    return verdict(violations.length === 0, { violations });
  } catch {
    return verdict(false, { violations: [] });
  }
}

export const gradeColdFloor = coldFloor;
export const codeFloorCold = coldFloor;
export const coldDisciplineFloor = coldFloor;

// ---------------------------------------------------------------------------
// 7) Dual-review independence grader — graded mechanically off an invocation
//    TRACE: exactly TWO distinct sub-agents spawned, neither fed the other's
//    assessment. One sub-agent / inline role-play / verdict-bleed FAILS. (BR-EVAL-009)
// ---------------------------------------------------------------------------

/**
 * Grade dual-review independence from a spawn trace.
 * @param {any} traceOrPair `{ spawns: [{ agent, input }] }`
 * @returns {{pass:boolean, verdict:string, reasons:string[]}}
 */
export function gradeIndependence(traceOrPair) {
  try {
    let trace;
    if (traceOrPair && typeof traceOrPair === 'object' && 'trace' in traceOrPair) {
      trace = traceOrPair.trace || {};
    } else {
      trace = traceOrPair || {};
    }
    const spawns = Array.isArray(trace.spawns) ? trace.spawns : [];
    const reasons = [];

    // Exactly two DISTINCT spawned sub-agents (≥2; distinct agent identities).
    const agents = spawns.map((s) => s && s.agent).filter(Boolean);
    const distinct = new Set(agents);
    if (spawns.length < 2) reasons.push('fewer than two spawned sub-agents (no real isolation)');
    if (distinct.size < 2) reasons.push('the two reviews are not distinct sub-agents');

    // No cross-feeding: neither input carries the other's prior assessment.
    const crossFed = spawns.some(
      (s) =>
        s &&
        s.input &&
        typeof s.input === 'object' &&
        Object.keys(s.input).some((kk) => /prior|assessment|verdict|otherReview|priorAssessment/i.test(kk)),
    );
    if (crossFed) reasons.push('an assessment was fed into the other reviewer (cross-feeding / context bleed)');

    const pass = spawns.length >= 2 && distinct.size >= 2 && !crossFed;
    return verdict(pass, { reasons });
  } catch {
    return verdict(false, { reasons: ['ungradeable trace'] });
  }
}

export const gradeDualReview = gradeIndependence;
export const gradeSubagentIsolation = gradeIndependence;

// ---------------------------------------------------------------------------
// 8) Judge-calibration gate — a model judge whose own pass^k < 1.00 on its
//    calibration set is PULLED from the gate; only judge_cal == 1.00 may gate.
//    Computed DETERMINISTICALLY from a verdict vector — no model call. (BR-EVAL-020)
// ---------------------------------------------------------------------------

/**
 * Decide whether a model judge may gate, from its calibration verdict vector.
 * @param {any} input `{ judge, calibration: ['PASS','FAIL',...] }`
 * @returns {{gates:boolean, judge_cal:number, judge:string}}
 */
export function judgeGate(input) {
  try {
    const o = input || {};
    const cal = toBools(o.calibration);
    // judge_cal = pass^k of the calibration vector (all-agree ⇒ 1.0).
    const judgeCal = cal.length > 0 && cal.every(Boolean) ? 1.0 : cal.length > 0 ? cal.filter(Boolean).length / cal.length : 0.0;
    const gates = judgeCal >= 1.0 && cal.length > 0;
    return { gates, gating: gates, allowed: gates, excluded: !gates, judge_cal: judgeCal, judge: o.judge || 'judge' };
  } catch {
    return { gates: false, gating: false, allowed: false, excluded: true, judge_cal: 0, judge: 'judge' };
  }
}

export const calibrateJudge = judgeGate;
export const gateJudge = judgeGate;
export const judgeCal = judgeGate;
export const isJudgeGating = judgeGate;

// ---------------------------------------------------------------------------
// 9) Append-only ledger + derived views. The ledger (results/ledger.jsonl) is
//    APPEND-ONLY (via the store's advisory-locked appendJsonl); baselines.json
//    (last-green index) and dashboard.md derive PURELY from it. (BR-EVAL-018)
// ---------------------------------------------------------------------------

/** Resolve the ledger path from tolerant args. */
function resolveLedgerPath(a, b) {
  if (typeof a === 'string') return { ledgerPath: a, record: b };
  const o = a || {};
  const dir = o.resultsDir || (o.root ? path.join(o.root, 'evals', 'harness', 'results') : null);
  const ledgerPath = o.ledgerPath || (dir ? path.join(dir, 'ledger.jsonl') : null);
  return { ledgerPath, record: o.record, resultsDir: dir, root: o.root };
}

/**
 * Append ONE run record to the ledger. Append-only and lossy-by-design under
 * contention (the store guarantees the prior file is never overwritten).
 * @param {string|object} a ledgerPath OR `{ ledgerPath|resultsDir|root, record }`
 * @param {any} [b] the record (when positional)
 * @returns {boolean}
 */
export function appendLedger(a, b) {
  try {
    const { ledgerPath, record } = resolveLedgerPath(a, b);
    if (!ledgerPath || record === undefined) return false;
    return appendJsonl(ledgerPath, record);
  } catch {
    return false;
  }
}

export const appendRun = appendLedger;
export const recordRun = appendLedger;
export const writeLedger = appendLedger;

/**
 * Derive baselines.json (last-green per uid) + a dashboard snapshot PURELY from
 * the ledger. Non-destructive: only writes the DERIVED views, never the ledger.
 * @param {string|object} a ledgerPath OR `{ ledgerPath, resultsDir, root }`
 * @param {string} [b] resultsDir (when positional)
 * @returns {{baselines:object, ledgerLines:number}}
 */
export function deriveViews(a, b) {
  try {
    let ledgerPath;
    let resultsDir;
    if (typeof a === 'string') {
      ledgerPath = a;
      resultsDir = b || path.dirname(a);
    } else {
      const o = a || {};
      resultsDir = o.resultsDir || (o.root ? path.join(o.root, 'evals', 'harness', 'results') : path.dirname(o.ledgerPath || '.'));
      ledgerPath = o.ledgerPath || path.join(resultsDir, 'ledger.jsonl');
    }
    const rows = readJsonl(ledgerPath);
    // Last-green index: the most recent GREEN run per uid wins.
    const baselines = {};
    for (const r of rows) {
      if (r && r.uid && String(r.status).toUpperCase() === 'GREEN') {
        baselines[r.uid] = { baseline: r.aut_hash, aut_hash: r.aut_hash, ts: r.ts, metrics: r.metrics };
      }
    }
    // Write the derived baselines.json (atomic, additive — never the ledger).
    if (resultsDir) {
      writeJsonAtomic(path.join(resultsDir, 'baselines.json'), { schemaVersion: 'forge.eval.baselines.v1', artifacts: baselines, ...baselines });
    }
    return { baselines, ledgerLines: rows.length, data: { baselines } };
  } catch {
    return { baselines: {}, ledgerLines: 0, data: { baselines: {} } };
  }
}

export const regenerateViews = deriveViews;
export const rebuildViews = deriveViews;
export const derive = deriveViews;

// ---------------------------------------------------------------------------
// 10) Coverage / report roll-up. U renders "—", never 0/1; coverage is M/N as a
//     loud top-line; U artifacts are EXCLUDED from the health aggregate. (BR-EVAL-010/012)
// ---------------------------------------------------------------------------

/** Is a grade a real A–F letter (vs U/—)? */
function isLetterGrade(g) {
  return typeof g === 'string' && /^[A-F]$/.test(g);
}

/**
 * Build the coverage report over a registry of artifacts.
 * @param {any} input `{ artifacts: [...] }` OR `artifacts[]`
 * @returns {{coverage:{covered:number,total:number,ratio:number}, artifacts:any[], health:object}}
 */
export function report(input) {
  try {
    const artifacts = Array.isArray(input) ? input : Array.isArray(input && input.artifacts) ? input.artifacts : [];
    const total = artifacts.length;
    let covered = 0;
    let evaluatedHealthN = 0;
    const rows = [];
    for (const a of artifacts) {
      const ev = (a && a.eval) || {};
      const grade = ev.grade;
      const isU = grade === 'U' || String(ev.status).toUpperCase() === 'UNEVALUATED';
      const hasGolden = a && a.hasGoldenSet === true;
      if (hasGolden && !isU) covered++;
      else if (hasGolden) covered++; // a golden set exists ⇒ counts toward coverage
      // U artifacts are EXCLUDED from the health aggregate.
      if (!isU) evaluatedHealthN++;
      rows.push({
        ...a,
        rendered: isU ? '—' : grade,
        display: isU ? '—' : grade,
      });
    }
    const ratio = total > 0 ? covered / total : 0;
    return {
      coverage: { covered, total, ratio, m: covered, n: total, with: covered, all: total },
      artifacts: rows,
      health: { n: evaluatedHealthN, count: evaluatedHealthN, evaluated: evaluatedHealthN },
    };
  } catch {
    return { coverage: { covered: 0, total: 0, ratio: 0 }, artifacts: [], health: { n: 0 } };
  }
}

export const buildReport = report;
export const coverageReport = report;
export const reportCoverage = report;
export const summarize = report;

// ---------------------------------------------------------------------------
// C4 entry — run(subcmd, args, ctx). NEVER writes stdout; returns the result
// object. The CLI surface (isMain block) renders it. (SPEC-08)
// ---------------------------------------------------------------------------

/**
 * Read the eval registry/results to build a `--report` payload. Reads ONLY local
 * files — NO model call (SPEC-07 §CLI: `--report` "runs nothing"). Fail-open.
 * @param {string} rootDir FORGE_ROOT
 */
function readEvalArtifacts(rootDir) {
  const out = [];
  // Runtime scoring results live under .forge/eval/ (seeded by a live `forge
  // eval-harness` run); the AUTHORED golden-set roll-up lives under
  // evals/harness/results/. Read runtime first (live scores win), then fall back to
  // the authored corpus so `--report` reflects authored coverage even before any
  // live model-scoring run. Fail-open throughout.
  const dirs = [
    path.join(forgeStateDir(rootDir), 'eval'),
    path.join(rootDir, 'evals', 'harness', 'results'),
  ];
  for (const dir of dirs) {
    for (const name of ['results.json', 'dashboard.json']) {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        const arr = Array.isArray(obj) ? obj : Array.isArray(obj && obj.artifacts) ? obj.artifacts : [];
        for (const a of arr) out.push(a);
        if (out.length) return out;
      } catch {
        /* not present — try next */
      }
    }
  }
  return out;
}

/**
 * C4 entry. Returns `{ ok, data, findings, summary }`; never writes stdout.
 * @param {string} subcmd `--report` | `--all` | `--changed` | uid | undefined
 * @param {string[]} args remaining argv
 * @param {any} ctx `{ rootDir? }`
 * @returns {Promise<{ok:boolean, data:any, findings:any[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const rootDir = (ctx && ctx.rootDir) || selfForgeRoot();
    const list = Array.isArray(args) ? args : [];
    const isReport = subcmd === '--report' || list.includes('--report');

    if (isReport || subcmd === undefined || subcmd === '--all' || (typeof subcmd === 'string' && subcmd.startsWith('--'))) {
      const artifacts = readEvalArtifacts(rootDir);
      const rep = report({ artifacts });
      const findings = [
        {
          level: 'INFO',
          code: 'EVAL-COVERAGE',
          message: `eval coverage ${rep.coverage.covered}/${rep.coverage.total} artifact(s) with a golden set`,
        },
      ];
      return resultOf(true, { coverage: rep.coverage, artifacts: rep.artifacts, health: rep.health }, findings);
    }

    // A bare uid / --changed is the LIVE run path — runs a real reviewer, which is
    // a manual command, never an automated test. Here we return an honest notice.
    return resultOf(true, { coverage: { covered: 0, total: 0, ratio: 0 } }, [
      {
        level: 'INFO',
        code: 'EVAL-LIVE',
        message: 'a real eval run is a LIVE command — use forge eval-harness --report for the read-only rollup',
      },
    ]);
  } catch {
    return resultOf(true, { coverage: { covered: 0, total: 0, ratio: 0 } }, [
      { level: 'INFO', code: 'EVAL-EMPTY', message: 'eval-harness unavailable (no results)' },
    ]);
  }
}

/** Shape a run result with a derived summary triple. */
function resultOf(ok, data, findings = []) {
  const list = Array.isArray(findings) ? findings : [];
  const summary = { errors: 0, warnings: 0, info: 0 };
  for (const f of list) {
    if (f && f.level === 'ERROR') summary.errors++;
    else if (f && f.level === 'WARN') summary.warnings++;
    else if (f && f.level === 'INFO') summary.info++;
  }
  return { ok: !!ok, data: data === undefined ? null : data, findings: list, summary };
}

// ---------------------------------------------------------------------------
// Dual-mode CLI tail — isMain()-guarded, NEVER process.exit() at import time.
// ---------------------------------------------------------------------------

/** Best-effort FORGE library root = two levels up from this module. */
function selfForgeRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

/** Read the raw forge VERSION for the envelope `forge` field (fail-open). */
function readRawVersion(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'VERSION'), 'utf8');
    return (raw || '').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Render a human-readable report panel; returns the exit code (always 0 — advisory). */
function renderHuman(res) {
  const cov = res && res.data && res.data.coverage;
  if (cov && typeof cov.total === 'number') {
    const pct = cov.total > 0 ? Math.round((cov.covered / cov.total) * 100) : 0;
    process.stdout.write(`[forge:eval-harness] coverage ${cov.covered}/${cov.total} (${pct}%)\n`);
  } else {
    process.stdout.write('[forge:eval-harness] no eval results yet — author a golden set and run a LIVE eval\n');
  }
  for (const f of (res && res.findings) || []) {
    process.stdout.write(`  ${f.level}: ${f.message}\n`);
  }
  return 0;
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
  const json = argv.includes('--json');
  run(subcmd, argv, { rootDir: selfForgeRoot() })
    .then((res) => {
      if (json) {
        const env = envelope({
          command: 'eval-harness',
          ok: res.ok,
          data: res.data,
          findings: res.findings,
          summary: res.summary,
          forgeVersion: readRawVersion(selfForgeRoot()),
        });
        writeStdoutSync(JSON.stringify(env) + '\n'); // SYNC write before exit — pipe-flush truncation (see json-out.mjs)
        process.exit(0);
      } else {
        process.exit(renderHuman(res));
      }
    })
    .catch(() => {
      // Fail-open: never an unhandled rejection.
      process.stdout.write('[forge:eval-harness] eval-harness unavailable (no results)\n');
      process.exit(0);
    });
  void rest;
}

export default { run, gradeReviewerCase, computeMetrics, computeEvalStatus, report };
