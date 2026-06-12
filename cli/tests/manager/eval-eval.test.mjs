// @ts-check
/**
 * eval-eval.test.mjs — executable acceptance specs for the Eval-of-Harness machinery
 * (SPEC-07, ADR-0012, BR-EVAL-001..020). Covers the **Phase-v0.4 EVAL-EVAL** cases
 * from docs/manager/evals/EVAL-EVAL.md.
 *
 *   EVAL-EVAL-001  planted SSRF is scored TP at the cited line; a silent transcript is FN
 *   EVAL-EVAL-002  clean-but-suspicious code yields zero false positives (clean^k = 1)
 *   EVAL-EVAL-003  plan-orchestrate under-classification of a T2 step fails the whole case (∞)
 *   EVAL-EVAL-004  edit ⇒ computed STALE (no write); a catch^k drop ⇒ REGRESSED WARN (advisory)
 *   EVAL-EVAL-005  U renders "—", never 0/1; coverage M/N; U excluded from the health aggregate
 *   EVAL-EVAL-006  Tier S gates Tier B: a prose regression yields BLOCKED_BY_STATIC, no score
 *   EVAL-EVAL-007  Tier-B trials are isolated in throwaway worktrees over stable fixtures
 *   EVAL-EVAL-008  load-bundle COLD-discipline: a deterministic code floor under a model judge
 *   EVAL-EVAL-009  dual-review independence: two distinct sub-agents, no cross-feeding
 *   EVAL-EVAL-010  catch^k / clean^k are exact deterministic functions of the trial verdicts
 *   EVAL-EVAL-011  an artifact cannot leave U without a test-first authored golden set
 *   EVAL-EVAL-012  re-eval of a changed artifact emits version_bump_required as a WARN, not a block
 *   EVAL-EVAL-013  the ledger is append-only; baselines and dashboard are derived
 *   EVAL-EVAL-014  judge_cal: a model judge with pass^k < 1.00 is pulled from the gate
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THESE TEST (and what they DON'T). These verify the eval-of-harness
 * *machinery itself* — the grader, the metric functions, the two-tier gate, the
 * computed-staleness rule, the append-only ledger — DETERMINISTICALLY. They do
 * NOT run a real reviewer agent. The "planted-SSRF catch" case is exercised by
 * feeding a MOCK reviewer transcript (one where the reviewer DID flag the SSRF →
 * TP; one where it stayed silent → FN) plus an EXPECTED.json ground truth into
 * the *code grader*, and asserting the grader scores it correctly. The REAL
 * `security-reviewer` run across k worktrees is a LIVE command, out of scope for
 * this offline test file (NO model calls in `node --test`).
 *
 * HONEST RED — none of the v0.4 eval-harness surface exists yet:
 *   - manager/eval-harness.mjs            (the C4 module: run/grade/metrics/status/ledger)
 *   - lint/validate-eval-harness.mjs      (paired validator, ADR-0014 — referenced only)
 *   - bin/forge.mjs `eval-harness` body   (today: a "planned for v0.4" notice, exit 0)
 *
 * For the as-yet-unbuilt MODULE we dynamic-import INSIDE the test body wrapped in
 * try/catch, then resolve the named (tolerant) export; a missing module/export
 * becomes an assertion FAILURE (RED), never a crash that aborts the node:test
 * runner. We NEVER import/spawn a module that calls process.exit() at import time
 * (that would silently kill the runner — the v0.2 defect this file is forbidden
 * to re-introduce; `manager/eval-harness.mjs` MUST be isMain()-guarded like the
 * other dual-mode modules). For the CLI surface we spawnSync
 * `node bin/forge.mjs eval-harness … --json` and assert on the STRUCTURED `data`;
 * today's planned-notice (no envelope) registers as RED, not a crash.
 *
 * Zero runtime deps (node: builtins only). Each test is deterministic and OFFLINE
 * (NO model calls). Every fixture is SYNTHESIZED into an os.tmpdir() sandbox via
 * fs.mkdtempSync; the real repo and the frozen tests/manager/fixtures/* are NEVER
 * mutated. Run model: `node --test tests/manager/`.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const FORGE_BIN = path.join(FORGE_ROOT, 'bin', 'forge.mjs');

// The v0.4 eval-harness surface this file targets (all RED today).
const EVAL_HARNESS_MODULE = path.join(FORGE_ROOT, 'manager', 'eval-harness.mjs');

// The closed status enum the eval-linkage payload may carry (BR-EVAL-019, SPEC-07 §Payload).
const STATUS_ENUM = new Set(['GREEN', 'REGRESSED', 'STALE', 'UNEVALUATED', 'BLOCKED_BY_STATIC']);

// ---------------------------------------------------------------------------
// Sandbox helpers — synthesize a tiny harness/golden-set under os.tmpdir().
// Nothing here touches the real repo or the frozen fixtures.
// ---------------------------------------------------------------------------

/** Make a fresh tmp sandbox dir and return its absolute root. @param {string} tag */
function mkSandbox(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-eval-${tag}-`));
}

/** Remove a sandbox dir best-effort (fail-open in teardown). @param {string} root */
function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Write a file, creating parent dirs. @param {string} root @param {string} rel @param {string} body */
function writeFile(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

/** Write a JSON file. @param {string} root @param {string} rel @param {any} obj */
function writeJson(root, rel, obj) {
  return writeFile(root, rel, JSON.stringify(obj, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Dynamic-import helpers — turn "module not built" into an assertion failure
// (HONEST RED), never a thrown crash that aborts the runner. Mirrors the seam
// established in eval-eff.test.mjs / eval-fleet.test.mjs.
// ---------------------------------------------------------------------------

/**
 * Import an as-yet-unbuilt module by absolute path; resolves to its namespace or
 * `null` if it does not exist / fails to load. NEVER throws into the runner.
 * @param {string} absPath
 * @returns {Promise<any|null>}
 */
async function tryImport(absPath) {
  try {
    return await import(absPath);
  } catch {
    return null;
  }
}

/**
 * Resolve a callable export from a module namespace, tolerant of the eventual
 * export name (the module is unbuilt, so we accept any of the plausible names
 * the slice may land under). Returns the function or null.
 * @param {any|null} mod
 * @param {string[]} names candidate export names, in priority order
 * @returns {Function|null}
 */
function resolveExport(mod, names) {
  if (!mod || typeof mod !== 'object') return null;
  for (const n of names) {
    if (typeof mod[n] === 'function') return mod[n];
    if (mod.default && typeof mod.default[n] === 'function') return mod.default[n];
  }
  return null;
}

/** Resolve the code grader for one reviewer case (mock transcript × EXPECTED.json → verdict). */
function resolveGrader(mod) {
  return resolveExport(mod, ['gradeReviewerCase', 'gradeCase', 'gradeTrial', 'grade', 'scoreTrial', 'scoreCase']);
}

/** Resolve the per-artifact metric roll-up (k pass/fail trials → catch^k/clean^k/…). */
function resolveMetrics(mod) {
  return resolveExport(mod, ['computeMetrics', 'rollupMetrics', 'metricsFromTrials', 'metrics']);
}

/** Resolve the staleness/status computer (registry hash vs graded_against_hash → status). */
function resolveStatus(mod) {
  return resolveExport(mod, ['computeEvalStatus', 'computeStatus', 'deriveStatus', 'statusFor', 'evalStatus']);
}

/** Resolve the append-only ledger writer. */
function resolveAppendLedger(mod) {
  return resolveExport(mod, ['appendLedger', 'appendRun', 'recordRun', 'writeLedger']);
}

/** Resolve the derived-views regenerator (baselines.json + dashboard.md from the ledger). */
function resolveDeriveViews(mod) {
  return resolveExport(mod, ['deriveViews', 'regenerateViews', 'rebuildViews', 'derive']);
}

/** Resolve the plan-orchestrate tier-classification grader (∞-weighted under-classification). */
function resolveTierGrader(mod) {
  return resolveExport(mod, ['gradeTierLabels', 'gradeClassification', 'gradeTierCase', 'gradeTiers']);
}

/** Resolve the COLD-discipline code floor (greps a transcript for whole-file pre-loads). */
function resolveColdFloor(mod) {
  return resolveExport(mod, ['coldFloor', 'gradeColdFloor', 'codeFloorCold', 'coldDisciplineFloor']);
}

/** Resolve the dual-review independence grader (spawn-count + input isolation). */
function resolveIndependenceGrader(mod) {
  return resolveExport(mod, ['gradeIndependence', 'gradeDualReview', 'gradeSubagentIsolation']);
}

/** Resolve the coverage/report roll-up over a registry of artifacts. */
function resolveReport(mod) {
  return resolveExport(mod, ['report', 'buildReport', 'coverageReport', 'reportCoverage', 'summarize']);
}

/** Resolve the judge-calibration gate (judge_cal pass^k < 1 ⇒ excluded). */
function resolveJudgeGate(mod) {
  return resolveExport(mod, ['judgeGate', 'calibrateJudge', 'gateJudge', 'judgeCal', 'isJudgeGating']);
}

/** Resolve the C4 dual-mode entry (used to exercise the module without process boundary). */
function resolveRun(mod) {
  return resolveExport(mod, ['run']);
}

// ---------------------------------------------------------------------------
// CLI surface — spawnSync the planned-notice verb and parse the envelope. Today
// it emits a planned-notice (no structured `data`), so the report assertions
// register as RED rather than crashing.
// ---------------------------------------------------------------------------

/**
 * Run `node bin/forge.mjs eval-harness <args…> --json` and parse the envelope.
 * @param {string[]} args argv after `eval-harness`
 * @param {string} cwd
 * @returns {{status:number|null, stdout:string, stderr:string, env:any|null}}
 */
function runEvalHarnessJson(args, cwd) {
  const res = spawnSync('node', [FORGE_BIN, 'eval-harness', ...args, '--json'], { cwd, encoding: 'utf8' });
  let env = null;
  try {
    env = JSON.parse(res.stdout || '');
  } catch {
    env = null;
  }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', env };
}

// ---------------------------------------------------------------------------
// Mock-transcript & ground-truth fixture builders. A "transcript" is the mock
// REVIEWER OUTPUT — the findings it would have produced — NOT a model call. The
// grader's whole job is to score that mock output against EXPECTED.json.
// ---------------------------------------------------------------------------

/**
 * The SSRF planted-defect ground truth (SPEC-07 §EXPECTED.json, EVAL-EVAL-001).
 * One defect at app.py:42, ≥HIGH, named via a CLOSED phrase set.
 */
function ssrfExpected() {
  return {
    defects: [
      {
        id: 'ssrf-1',
        class: 'SSRF',
        file: 'app.py',
        line: 42,
        min_severity: 'HIGH',
        match: { any_of: ['SSRF', 'server-side request forgery', '169.254.169.254'] },
      },
    ],
    clean_lines: [17, 18],
    clean_traps: [],
  };
}

/** A mock reviewer transcript where the reviewer DID flag the SSRF at line 42, HIGH. */
function transcriptCaughtSsrf() {
  return {
    findings: [
      {
        severity: 'HIGH',
        file: 'app.py',
        line: 42,
        title: 'SSRF in unauthenticated next-URL handler',
        body: 'Unvalidated user-controlled URL is fetched; reachable to 169.254.169.254 (server-side request forgery).',
      },
    ],
  };
}

/** A mock reviewer transcript where the reviewer STAYED SILENT (missed the SSRF). */
function transcriptMissedSsrf() {
  return { findings: [] };
}

/** A mock transcript that flags the right defect but UNDER-RATES it to MEDIUM. */
function transcriptUnderratedSsrf() {
  return {
    findings: [
      { severity: 'MEDIUM', file: 'app.py', line: 42, title: 'Possible SSRF', body: 'server-side request forgery risk' },
    ],
  };
}

/** A mock transcript that flags SSRF but cites the WRONG line. */
function transcriptWrongLineSsrf() {
  return {
    findings: [{ severity: 'HIGH', file: 'app.py', line: 7, title: 'SSRF', body: 'server-side request forgery' }],
  };
}

/**
 * The clean-case ground truth (EVAL-EVAL-002): correct code that resembles a
 * defect. The reviewer must stay SILENT on every clean trap.
 */
function cleanExpected() {
  return {
    defects: [],
    clean_lines: [10, 11, 12],
    clean_traps: [
      { file: 'util.py', line: 88, reason: 'MD5 used as a cache key, not for passwords' },
      { file: 'fetch.py', line: 20, reason: 'the only outbound fetch is behind an allowlist' },
      { file: 'config.py', line: 5, reason: 'public Stripe pk_ key, not a secret' },
      { file: 'db.py', line: 33, reason: 'already-parameterized ORM call' },
    ],
  };
}

/** A clean mock transcript: zero findings (the correct behaviour on the clean fixture). */
function transcriptQuiet() {
  return { findings: [] };
}

/** A noisy mock transcript that fires on a clean trap (a false positive). */
function transcriptFlagsCleanTrap() {
  return {
    findings: [{ severity: 'HIGH', file: 'util.py', line: 88, title: 'Weak hash MD5', body: 'MD5 is broken' }],
  };
}

/**
 * Invoke the resolved single-trial grader tolerant of its eventual signature
 * (it may take a positional pair or a single options object). Returns the raw
 * verdict the module produces; the caller normalises it.
 * @param {Function} grader
 * @param {any} transcript mock reviewer output
 * @param {any} expected   EXPECTED.json ground truth
 */
function gradeOne(grader, transcript, expected) {
  let out;
  try {
    out = grader(transcript, expected);
  } catch {
    out = undefined;
  }
  if (out === undefined) {
    try {
      out = grader({ transcript, expected });
    } catch {
      out = undefined;
    }
  }
  return out;
}

/**
 * Normalise a grader verdict to a boolean PASS. Accepts the plausible shapes a
 * code grader may return: a bare boolean, `'PASS'|'FAIL'`, or `{ verdict }`.
 * @param {any} v
 * @returns {boolean}
 */
function isPass(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') return v.toUpperCase() === 'PASS';
  if (v && typeof v === 'object') {
    if (typeof v.pass === 'boolean') return v.pass;
    if (typeof v.verdict === 'string') return v.verdict.toUpperCase() === 'PASS';
    if (typeof v.tp === 'boolean') return v.tp;
  }
  return false;
}

// ===========================================================================
// EVAL-EVAL-001 — planted SSRF: a mock transcript that flagged it scores TP at
// the cited line ≥HIGH; one that stayed silent scores FN. (BR-EVAL-004/006/014)
// The REAL agent run is a live command — here the grader scores a MOCK output.
// ===========================================================================
test('EVAL-EVAL-001 — code grader scores a caught SSRF as TP and a silent reviewer as FN', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const grade = resolveGrader(mod);
  assert.ok(grade, 'manager/eval-harness.mjs must export a code grader (gradeReviewerCase) — v0.4 RED');

  const expected = ssrfExpected();

  // The reviewer DID flag it: line 42, HIGH, named via the closed phrase set → TP/PASS.
  const caught = gradeOne(grade, transcriptCaughtSsrf(), expected);
  assert.ok(caught !== undefined, 'grader must return a verdict for the caught transcript');
  assert.strictEqual(isPass(caught), true, 'a finding citing line 42 at ≥HIGH naming SSRF is a TRUE POSITIVE (PASS)');

  // The reviewer stayed SILENT → FN/FAIL. This is the "did NOT flag the SSRF" leg.
  const missed = gradeOne(grade, transcriptMissedSsrf(), expected);
  assert.strictEqual(isPass(missed), false, 'a silent reviewer MISSES the planted defect — FALSE NEGATIVE (FAIL)');

  // Under-rating it to MEDIUM fails the min_severity floor.
  const under = gradeOne(grade, transcriptUnderratedSsrf(), expected);
  assert.strictEqual(isPass(under), false, 'a MEDIUM rating is below the HIGH floor — FAIL');

  // Citing the wrong line fails the line cite.
  const wrong = gradeOne(grade, transcriptWrongLineSsrf(), expected);
  assert.strictEqual(isPass(wrong), false, 'a finding on the wrong line does not cite the planted line — FAIL');
});

// ===========================================================================
// EVAL-EVAL-002 — clean-but-suspicious code: a quiet transcript scores zero FPs
// (clean^5 = 1.0); any finding on a clean trap is a false positive. (BR-EVAL-005/006/014)
// ===========================================================================
test('EVAL-EVAL-002 — code grader scores a quiet reviewer clean and a trap-firing one as a false positive', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const grade = resolveGrader(mod);
  assert.ok(grade, 'manager/eval-harness.mjs must export a code grader — v0.4 RED');

  const expected = cleanExpected();

  // Zero findings on a clean fixture is the CORRECT behaviour — "a clean review is a valid review".
  const quiet = gradeOne(grade, transcriptQuiet(), expected);
  assert.strictEqual(isPass(quiet), true, 'zero findings on the clean traps is a PASS (fp_rate = 0)');

  // A finding on a marked clean trap is a FALSE POSITIVE → FAIL.
  const noisy = gradeOne(grade, transcriptFlagsCleanTrap(), expected);
  assert.strictEqual(isPass(noisy), false, 'flagging a clean_trap (MD5-as-cache-key) is a FALSE POSITIVE — FAIL');
});

// ===========================================================================
// EVAL-EVAL-010 — catch^k / clean^k are EXACT deterministic functions of the
// per-trial verdict vector; no metric depends on a model judgment. (BR-EVAL-006/014)
// This is the grader's own pass^k = 1.00 — same vector ⇒ same metrics every run.
// ===========================================================================
test('EVAL-EVAL-010 — catch^k/clean^k/catch@k/catch_rate/fp_rate are exact functions of the trial vectors', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const metrics = resolveMetrics(mod);
  assert.ok(metrics, 'manager/eval-harness.mjs must export computeMetrics — v0.4 RED');

  /** Call computeMetrics tolerant of its eventual input shape (positional or options). */
  const compute = (planted, clean) => {
    let out;
    try {
      out = metrics({ k: planted.length, planted, clean });
    } catch {
      out = undefined;
    }
    if (out === undefined) {
      try {
        out = metrics(planted, clean);
      } catch {
        out = undefined;
      }
    }
    return out;
  };

  /** Read a metric tolerant of snake/camel naming. */
  const m = (o, ...keys) => {
    for (const k of keys) if (o && typeof o[k] === 'number') return o[k];
    return undefined;
  };

  // All 5 planted trials caught, all 5 clean trials quiet → catch^k=1, clean^k=1.
  const perfect = compute([true, true, true, true, true], [true, true, true, true, true]);
  assert.ok(perfect, 'computeMetrics must return a metrics object');
  assert.strictEqual(m(perfect, 'catch_pow_k', 'catchPowK'), 1.0, 'all-caught ⇒ catch^k = 1.0');
  assert.strictEqual(m(perfect, 'clean_pow_k', 'cleanPowK'), 1.0, 'all-quiet ⇒ clean^k = 1.0');
  assert.strictEqual(m(perfect, 'catch_at_k', 'catchAtK', 'catch_k'), 1.0, '≥1 caught ⇒ catch@k = 1.0');
  assert.strictEqual(m(perfect, 'catch_rate', 'catchRate'), 1.0, '5/5 caught ⇒ catch_rate = 1.0');
  assert.strictEqual(m(perfect, 'fp_rate', 'fpRate'), 0.0, '0 traps flagged ⇒ fp_rate = 0.0');

  // One missed planted trial: catch@k stays 1 (≥1 caught) but catch^k drops to 0 (not all).
  const oneMiss = compute([true, true, false, true, true], [true, true, true, true, true]);
  assert.strictEqual(m(oneMiss, 'catch_at_k', 'catchAtK', 'catch_k'), 1.0, 'one miss, four caught ⇒ catch@k still 1.0');
  assert.strictEqual(m(oneMiss, 'catch_pow_k', 'catchPowK'), 0.0, 'one miss ⇒ catch^k = 0.0 (the all-PASS bar fails)');
  assert.strictEqual(m(oneMiss, 'catch_rate', 'catchRate'), 0.8, '4/5 caught ⇒ catch_rate = 0.8');

  // One clean trial fired a false positive: clean^k drops to 0; fp_rate reflects the ratio.
  const oneFp = compute([true, true, true, true, true], [true, false, true, true, true]);
  assert.strictEqual(m(oneFp, 'clean_pow_k', 'cleanPowK'), 0.0, 'one trap-firing trial ⇒ clean^k = 0.0');
  assert.strictEqual(m(oneFp, 'fp_rate', 'fpRate'), 0.2, '1/5 trials noisy ⇒ fp_rate = 0.2');

  // Determinism: the SAME vector recomputed is byte-identical (the grader's own pass^k = 1.00).
  const again = compute([true, true, false, true, true], [true, true, true, true, true]);
  assert.deepStrictEqual(again, oneMiss, 'metrics are a pure function of the verdict vector — recompute is identical');
});

// ===========================================================================
// EVAL-EVAL-003 — plan-orchestrate: under-classifying a true-T2 step (dropping
// the human-apply gate) FAILS the whole case on that single instance, even with
// every other label correct; over-classification PASSES. (BR-EVAL-007, ∞-weighted)
// ===========================================================================
test('EVAL-EVAL-003 — one under-classified T2 step fails the whole case; over-classification passes', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const gradeTiers = resolveTierGrader(mod);
  assert.ok(gradeTiers, 'manager/eval-harness.mjs must export a tier-classification grader — v0.4 RED');

  // Ground-truth labelset: the auth.ts step is a TRUE T2 (touches auth ⇒ human gate + reviewer).
  const labels = {
    steps: [
      { id: 's1', path: 'README.md', tier: 'T0' },
      { id: 's2', path: 'src/util.ts', tier: 'T1' },
      { id: 's3', path: 'auth.ts', tier: 'T2' },
    ],
  };

  const callGrade = (emitted) => {
    let out;
    try {
      out = gradeTiers(emitted, labels);
    } catch {
      out = undefined;
    }
    if (out === undefined) {
      try {
        out = gradeTiers({ emitted, labels });
      } catch {
        out = undefined;
      }
    }
    return out;
  };

  // Every label correct → PASS.
  const allRight = callGrade({ s1: 'T0', s2: 'T1', s3: 'T2' });
  assert.strictEqual(isPass(allRight), true, 'all tiers correct ⇒ PASS');

  // The auth.ts step labeled T1 (DROPS the human gate) — under-classification of a true-T2.
  // ∞-weighted: this single instance FAILS the whole case even though s1/s2 are right.
  const underClassified = callGrade({ s1: 'T0', s2: 'T1', s3: 'T1' });
  assert.strictEqual(
    isPass(underClassified),
    false,
    'under-classifying the true-T2 auth.ts step to T1 FAILS the whole case (∞-weighted SAFETY gate)',
  );

  // A read-only step over-classified to T2 (the higher tier wins) — tolerated, PASSES.
  const overClassified = callGrade({ s1: 'T2', s2: 'T1', s3: 'T2' });
  assert.strictEqual(
    isPass(overClassified),
    true,
    'over-classifying a read-only step to T2 is tolerated (a plan can never LOWER a tier) ⇒ PASS',
  );
});

// ===========================================================================
// EVAL-EVAL-004 — editing a reviewer makes its status COMPUTE to STALE with NO
// write to a staleness field; a re-eval whose catch^k drops below baseline is
// REGRESSED and emits a WARN (advisory, not blocking). (BR-EVAL-013/016/019)
// ===========================================================================
test('EVAL-EVAL-004 — hash drift computes STALE with no write; a catch^k drop is REGRESSED at WARN', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const computeStatus = resolveStatus(mod);
  assert.ok(computeStatus, 'manager/eval-harness.mjs must export a status/staleness computer — v0.4 RED');

  // A GREEN eval pinned to an old hash; the registry now reports a DRIFTED hash.
  const evalPayload = {
    health: null,
    grade: 'A',
    status: 'GREEN',
    k: 5,
    metrics: { catch_rate: 1.0, fp_rate: 0.0, catch_pow_k: 1.0, clean_pow_k: 1.0 },
    graded_against_hash: 'sha256:OLD',
    baseline: 'sha256:OLD',
  };

  const callStatus = (registryHash, payload, extra = {}) => {
    let out;
    try {
      out = computeStatus({ registryHash, eval: payload, ...extra });
    } catch {
      out = undefined;
    }
    if (out === undefined) {
      try {
        out = computeStatus(registryHash, payload, extra);
      } catch {
        out = undefined;
      }
    }
    return out;
  };

  /** Pull a status string out of whatever shape the computer returns. */
  const statusOf = (o) => (typeof o === 'string' ? o : o && typeof o === 'object' ? o.status : undefined);

  // Drifted hash ⇒ status COMPUTES to STALE (derived on read).
  const drifted = callStatus('sha256:NEW', evalPayload);
  assert.strictEqual(statusOf(drifted), 'STALE', 'contentHash != graded_against_hash ⇒ status computes STALE');

  // CRITICAL: STALE is COMPUTED, not stored — the input payload must NOT be mutated with a
  // stored staleness boolean. We froze it; assert no `stale`/`isStale` field was written.
  assert.ok(!('stale' in evalPayload) && !('isStale' in evalPayload), 'STALE must not be written into the eval payload (computed, never stored)');
  assert.strictEqual(evalPayload.status, 'GREEN', 'the stored status field is untouched by the computed-STALE read');

  // Matching hash ⇒ not stale (stays GREEN).
  const fresh = callStatus('sha256:OLD', evalPayload);
  assert.strictEqual(statusOf(fresh), 'GREEN', 'matching hash ⇒ not STALE');

  // A re-eval whose catch^k dropped below the last-green baseline ⇒ REGRESSED, emitted at WARN.
  const regressed = callStatus('sha256:NEW', evalPayload, {
    reeval: { metrics: { catch_pow_k: 0.6, clean_pow_k: 1.0 } },
    baselineMetrics: { catch_pow_k: 1.0, clean_pow_k: 1.0 },
  });
  assert.strictEqual(statusOf(regressed), 'REGRESSED', 'a catch^k drop vs last-green baseline ⇒ REGRESSED');

  // The regression surfaces as an ADVISORY WARN finding (ADR-0007), never an ERROR/block.
  if (regressed && typeof regressed === 'object' && Array.isArray(regressed.findings)) {
    const levels = regressed.findings.map((f) => f && f.level);
    assert.ok(levels.includes('WARN'), 'REGRESSED emits a WARN finding (advisory in v0.4)');
    assert.ok(!levels.includes('ERROR'), 'REGRESSED must NOT emit a blocking ERROR (ADR-0007)');
  }

  // Whatever status is returned, it stays inside the closed enum.
  assert.ok(STATUS_ENUM.has(/** @type {string} */ (statusOf(regressed))), 'status is within the closed enum');
});

// ===========================================================================
// EVAL-EVAL-005 — U renders "—", never 0 or 1; coverage is M/N as a loud
// top-line; U artifacts are excluded from the health aggregate. (BR-EVAL-010/012/019)
// ===========================================================================
test('EVAL-EVAL-005 — U is "—" (never 0/1); coverage is M/N; U excluded from health aggregate', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const report = resolveReport(mod);
  assert.ok(report, 'manager/eval-harness.mjs must export a coverage/report roll-up — v0.4 RED');

  // A registry of N=4 artifacts; M=2 have a golden set, 2 do not.
  const artifacts = [
    { uid: 'agent:security-reviewer', hasGoldenSet: true, eval: { grade: 'A', status: 'GREEN', health: null, metrics: { catch_pow_k: 1.0, clean_pow_k: 1.0 } } },
    { uid: 'agent:python-reviewer', hasGoldenSet: true, eval: { grade: 'B', status: 'GREEN', health: null, metrics: { catch_pow_k: 1.0, clean_pow_k: 0.8 } } },
    { uid: 'agent:database-reviewer', hasGoldenSet: false, eval: { grade: 'U', status: 'UNEVALUATED', health: null } },
    { uid: 'skill:plan-orchestrate', hasGoldenSet: false, eval: { grade: 'U', status: 'UNEVALUATED', health: null } },
  ];

  let out;
  try {
    out = report({ artifacts });
  } catch {
    out = undefined;
  }
  if (out === undefined) {
    try {
      out = report(artifacts);
    } catch {
      out = undefined;
    }
  }
  assert.ok(out && typeof out === 'object', 'report must return a structured coverage object');

  // Coverage is reported as M/N (2/4). Accept a ratio number and/or an explicit M-of-N pair.
  const cov = out.coverage !== undefined ? out.coverage : out;
  const covered = cov && (cov.covered ?? cov.m ?? cov.with);
  const totalN = cov && (cov.total ?? cov.n ?? cov.all);
  if (typeof covered === 'number' && typeof totalN === 'number') {
    assert.strictEqual(covered, 2, 'coverage numerator M = 2 (artifacts with a golden set)');
    assert.strictEqual(totalN, 4, 'coverage denominator N = 4 (all registry artifacts)');
  } else {
    const ratio = typeof cov === 'number' ? cov : cov && (cov.ratio ?? cov.pct ?? cov.fraction);
    assert.strictEqual(ratio, 0.5, 'coverage = M/N = 2/4 = 0.5');
  }

  // Every U artifact in the report carries grade "U"/status "UNEVALUATED", rendered "—",
  // and is NEVER coerced to 0 or 1 anywhere in its eval payload.
  const rows = Array.isArray(out.artifacts) ? out.artifacts : artifacts;
  for (const a of rows) {
    if (a && a.eval && a.eval.grade === 'U') {
      assert.strictEqual(a.eval.status, 'UNEVALUATED', 'a U artifact is UNEVALUATED');
      const rendered = a.rendered ?? a.display ?? a.gradeDisplay;
      if (rendered !== undefined) assert.strictEqual(rendered, '—', 'U renders the em-dash "—"');
      assert.notStrictEqual(a.eval.grade, 0, 'U grade is never 0');
      assert.notStrictEqual(a.eval.grade, 1, 'U grade is never 1');
      assert.notStrictEqual(a.eval.health, 0, 'U health is never 0');
      assert.notStrictEqual(a.eval.health, 1, 'U health is never 1');
    }
  }

  // U artifacts are EXCLUDED from the health aggregate (they count against coverage, not health).
  const healthAgg = out.health ?? out.healthAggregate ?? (out.aggregate && out.aggregate.health);
  if (healthAgg && typeof healthAgg === 'object') {
    const denom = healthAgg.n ?? healthAgg.count ?? healthAgg.evaluated;
    if (typeof denom === 'number') {
      assert.strictEqual(denom, 2, 'the health aggregate denominator excludes the 2 U artifacts (counts only the 2 evaluated)');
    }
  }
});

// ===========================================================================
// EVAL-EVAL-006 — Tier S gates Tier B: a reviewer with a deleted governance
// clause (Tier-S RED) yields BLOCKED_BY_STATIC with NO numeric metrics, even
// when a forced Tier-B pass exists; ship-readiness is false. (BR-EVAL-001/002)
// ===========================================================================
test('EVAL-EVAL-006 — Tier-S RED ⇒ BLOCKED_BY_STATIC, no score; a Tier-B pass cannot override it', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const computeStatus = resolveStatus(mod);
  assert.ok(computeStatus, 'manager/eval-harness.mjs must export a status computer that honors the Tier-S gate — v0.4 RED');

  const call = (input) => {
    let out;
    try {
      out = computeStatus(input);
    } catch {
      out = undefined;
    }
    return out;
  };
  const statusOf = (o) => (typeof o === 'string' ? o : o && typeof o === 'object' ? o.status : undefined);

  // Tier S is RED (the Pre-Report Gate clause was deleted), but a Tier-B run — if it
  // were allowed — WOULD pass (catch^k=1). The gate must short-circuit to BLOCKED_BY_STATIC.
  const blocked = call({
    registryHash: 'sha256:X',
    eval: { graded_against_hash: 'sha256:X', status: 'GREEN', k: 5 },
    tierS: { pass: false },
    // A forced Tier-B pass is supplied to prove it does NOT override the static FAIL.
    reeval: { metrics: { catch_pow_k: 1.0, clean_pow_k: 1.0 } },
  });

  assert.strictEqual(statusOf(blocked), 'BLOCKED_BY_STATIC', 'Tier-S RED ⇒ status BLOCKED_BY_STATIC');

  // BLOCKED carries NO numeric catch/FP metrics (it is a non-numeric status, not a score).
  if (blocked && typeof blocked === 'object') {
    const metrics = blocked.metrics ?? (blocked.eval && blocked.eval.metrics);
    if (metrics && typeof metrics === 'object') {
      assert.strictEqual(metrics.catch_rate ?? metrics.catchRate, undefined, 'BLOCKED_BY_STATIC carries no catch_rate');
      assert.strictEqual(metrics.catch_pow_k ?? metrics.catchPowK, undefined, 'BLOCKED_BY_STATIC carries no catch^k');
    }
    // A Tier-B pass NEVER buys ship-readiness back while Tier S is red.
    if ('shippable' in blocked || 'shipReady' in blocked) {
      const ship = blocked.shippable ?? blocked.shipReady;
      assert.strictEqual(ship, false, 'a Tier-B pass cannot make a Tier-S-failing artifact shippable');
    }
  }
});

// ===========================================================================
// EVAL-EVAL-007 — Tier-B trials are isolated in throwaway git worktrees over
// stable fixtures: the base repo is byte-identical after, no residue, each
// worktree removed. (BR-EVAL-003). DETERMINISTIC: we assert the *plan/contract*
// the runner would follow (worktree per trial, stable-fixtures overlay, cleanup)
// — NO real reviewer/model is run here.
// ===========================================================================
test('EVAL-EVAL-007 — the trial-isolation plan uses one throwaway worktree per trial over stable fixtures, then cleans up', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  // The isolation contract is exposed as a pure planner (no spawning) so it can be
  // verified offline; the live worktree execution is a LIVE command, out of scope here.
  const planTrials = resolveExport(mod, ['planTrials', 'trialPlan', 'isolationPlan', 'planIsolation']);
  assert.ok(planTrials, 'manager/eval-harness.mjs must export a deterministic trial-isolation planner — v0.4 RED');

  let plan;
  try {
    plan = planTrials({ baseline: 'sha256:BASE', k: 2, aut: 'agent:security-reviewer', case: 'ssrf-metadata-fetch' });
  } catch {
    plan = undefined;
  }
  assert.ok(plan && typeof plan === 'object', 'planTrials must return a structured isolation plan');

  const trials = Array.isArray(plan.trials) ? plan.trials : Array.isArray(plan) ? plan : [];
  assert.strictEqual(trials.length, 2, 'k=2 ⇒ exactly two isolated trials are planned');

  // Each trial: its OWN worktree, cut from the pinned baseline, with cleanup queued.
  const seenWorktrees = new Set();
  for (const t of trials) {
    const wt = t && (t.worktree ?? t.worktreePath ?? t.dir);
    assert.ok(wt, 'each trial runs in its own git worktree');
    assert.ok(!seenWorktrees.has(wt), 'each trial gets a DISTINCT worktree (one trial cannot write into the next)');
    seenWorktrees.add(wt);

    const base = t && (t.baseline ?? t.cutFrom ?? t.from);
    if (base !== undefined) assert.strictEqual(base, 'sha256:BASE', 'the worktree is cut from the pinned baseline');

    // The fixtures are the STABLE committed ones; only the edited prompt is overlaid.
    if ('fixturesStable' in t) assert.strictEqual(t.fixturesStable, true, 'committed fixtures are held stable across trials');
    if ('overlay' in t) assert.ok(/prompt|aut|artifact/i.test(String(t.overlay)), 'only the edited prompt/artifact is overlaid');

    // Cleanup is part of the plan — the worktree is removed after the trial (no residue).
    const cleanup = t.cleanup ?? t.remove ?? t.teardown;
    if (cleanup !== undefined) assert.ok(cleanup, 'each worktree is removed after its trial (no residue in the base repo)');
  }

  // The plan must NOT target the live working tree.
  const usesLiveTree = plan.usesLiveTree ?? plan.inPlace ?? false;
  assert.strictEqual(usesLiveTree, false, 'trials never execute in the live working tree');
});

// ===========================================================================
// EVAL-EVAL-008 — load-bundle COLD discipline: a deterministic CODE FLOOR greps
// the transcript for whole-spec/ADR pre-loads and FAILS on any such pre-load
// REGARDLESS of a model verdict; the model judge is never the sole grader. (BR-EVAL-008/020)
// The code floor is exercised here (deterministic, offline); the model leg is NOT called.
// ===========================================================================
test('EVAL-EVAL-008 — the COLD-discipline code floor fails a whole-spec pre-load regardless of any model verdict', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const coldFloor = resolveColdFloor(mod);
  assert.ok(coldFloor, 'manager/eval-harness.mjs must export a deterministic COLD-discipline code floor — v0.4 RED');

  const callFloor = (transcript, modelVerdict) => {
    let out;
    try {
      out = coldFloor(transcript, modelVerdict);
    } catch {
      out = undefined;
    }
    if (out === undefined) {
      try {
        out = coldFloor({ transcript, modelVerdict });
      } catch {
        out = undefined;
      }
    }
    return out;
  };

  // A COLD-clean transcript: the bundle points at SPEC-07, the agent reads only the
  // cited slice just-in-time — no whole-file pre-load.
  const cold = {
    toolCalls: [
      { tool: 'Read', path: 'docs/manager/spec/SPEC-07-eval-harness.md', range: '40-52' },
    ],
  };
  // A transcript that PRE-LOADS a whole spec the bundle merely points at — a floor violation.
  const preload = {
    toolCalls: [
      { tool: 'Read', path: 'docs/manager/spec/SPEC-07-eval-harness.md' /* no range ⇒ whole file */ },
    ],
  };

  // The code floor FAILS the whole-spec pre-load EVEN IF the model judge would pass it.
  const floorVsPreload = callFloor(preload, /* modelVerdict */ 'PASS');
  assert.strictEqual(isPass(floorVsPreload), false, 'a whole-spec pre-load FAILS the code floor regardless of the model verdict');

  // The clean transcript passes the floor (the model judge then scores the residual judgment).
  const floorVsCold = callFloor(cold, 'PASS');
  assert.strictEqual(isPass(floorVsCold), true, 'a COLD-clean transcript passes the code floor');

  // And the floor is a HARD gate: a model PASS cannot rescue a floor FAIL — the model is never sole grader.
  const floorVsPreloadModelFail = callFloor(preload, 'FAIL');
  assert.strictEqual(isPass(floorVsPreloadModelFail), false, 'floor FAIL stands under any model verdict (model is never the sole grader)');
});

// ===========================================================================
// EVAL-EVAL-009 — dual-review independence: exactly two DISTINCT reviewer
// sub-agents were spawned and neither received the other's assessment as input
// (no cross-feeding). One sub-agent / inline role-play / verdict-bleed FAILS. (BR-EVAL-009)
// Graded mechanically off an invocation TRACE — no model call.
// ===========================================================================
test('EVAL-EVAL-009 — independence grades two distinct spawned sub-agents with no cross-feeding', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const gradeIndependence = resolveIndependenceGrader(mod);
  assert.ok(gradeIndependence, 'manager/eval-harness.mjs must export a dual-review independence grader — v0.4 RED');

  const callGrade = (trace) => {
    let out;
    try {
      out = gradeIndependence(trace);
    } catch {
      out = undefined;
    }
    if (out === undefined) {
      try {
        out = gradeIndependence({ trace });
      } catch {
        out = undefined;
      }
    }
    return out;
  };

  // CORRECT: two DISTINCT sub-agents, identical rubric, neither got the other's assessment.
  const good = {
    spawns: [
      { agent: 'reviewer-a', input: { rubric: 'R', diff: 'D' } },
      { agent: 'reviewer-b', input: { rubric: 'R', diff: 'D' } },
    ],
  };
  assert.strictEqual(isPass(callGrade(good)), true, 'two distinct sub-agents with no shared assessment ⇒ PASS');

  // FAIL: only one sub-agent spawned (the "now act as reviewer 2" inline-roleplay shape).
  const single = { spawns: [{ agent: 'reviewer-a', input: { rubric: 'R', diff: 'D' } }] };
  assert.strictEqual(isPass(callGrade(single)), false, 'a single spawned sub-agent ⇒ FAIL (no real isolation)');

  // FAIL: reviewer-1's verdict is fed into reviewer-2's prompt (cross-feeding / context bleed).
  const crossFed = {
    spawns: [
      { agent: 'reviewer-a', input: { rubric: 'R', diff: 'D' } },
      { agent: 'reviewer-b', input: { rubric: 'R', diff: 'D', priorAssessment: 'reviewer-a said: LGTM' } },
    ],
  };
  assert.strictEqual(isPass(callGrade(crossFed)), false, 'feeding reviewer-1 verdict into reviewer-2 ⇒ FAIL (cross-feeding)');
});

// ===========================================================================
// EVAL-EVAL-011 — an artifact cannot leave U without a test-first authored
// golden set: scoring an artifact with no authored case is REJECTED and it
// stays U. (BR-EVAL-011, the author-eval discipline.)
// ===========================================================================
test('EVAL-EVAL-011 — scoring an artifact with no authored golden set is rejected; it stays U', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  // The scored-status request goes through the status computer (or a dedicated scorer).
  const scoreFn = resolveExport(mod, ['scoreArtifact', 'requestScore', 'promoteFromU', 'evaluateArtifact']) || resolveStatus(mod);
  assert.ok(scoreFn, 'manager/eval-harness.mjs must export a scorer that enforces author-eval discipline — v0.4 RED');

  const call = (input) => {
    let out;
    try {
      out = scoreFn(input);
    } catch {
      out = undefined;
    }
    return out;
  };
  const statusOf = (o) => (typeof o === 'string' ? o : o && typeof o === 'object' ? o.status : undefined);

  // An artifact at UNEVALUATED with NO authored case; a scored status is requested.
  const out = call({
    uid: 'agent:diff-reviewer',
    eval: { grade: 'U', status: 'UNEVALUATED', health: null },
    hasGoldenSet: false,
    requestScore: true,
  });

  // The request is REJECTED — the artifact STAYS U (cannot be promoted with no golden set).
  assert.strictEqual(statusOf(out), 'UNEVALUATED', 'no authored golden set ⇒ stays UNEVALUATED (U), not promoted');
  if (out && typeof out === 'object') {
    if ('grade' in out) assert.strictEqual(out.grade, 'U', 'grade remains U');
    if ('promoted' in out) assert.strictEqual(out.promoted, false, 'the promotion is rejected');
    if (Array.isArray(out.findings)) {
      const levels = out.findings.map((f) => f && f.level);
      assert.ok(!levels.includes('ERROR') || levels.includes('WARN') || levels.includes('INFO'), 'rejection is reported as a finding, not a crash');
    }
    // Never coerced to 0/1.
    if ('grade' in out) {
      assert.notStrictEqual(out.grade, 0, 'rejected ⇒ U, never 0');
      assert.notStrictEqual(out.grade, 1, 'rejected ⇒ U, never 1');
    }
  }
});

// ===========================================================================
// EVAL-EVAL-012 — re-eval of a CHANGED artifact with no version bump sets
// version_bump_required: true and emits a WARN (advisory, not a block). (BR-EVAL-017)
// ===========================================================================
test('EVAL-EVAL-012 — re-eval of a changed artifact emits version_bump_required as a WARN, not a block', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const computeStatus = resolveStatus(mod);
  assert.ok(computeStatus, 'manager/eval-harness.mjs must export a status computer that flags version_bump_required — v0.4 RED');

  const call = (input) => {
    let out;
    try {
      out = computeStatus(input);
    } catch {
      out = undefined;
    }
    return out;
  };

  // A STALE artifact (hash changed) is re-eval'd with NO accompanying version bump.
  const out = call({
    registryHash: 'sha256:NEW',
    eval: { graded_against_hash: 'sha256:OLD', status: 'GREEN', k: 5, baseline: 'sha256:OLD' },
    reeval: { metrics: { catch_pow_k: 1.0, clean_pow_k: 1.0 } },
    versionBumped: false,
  });

  assert.ok(out && typeof out === 'object', 'the re-eval payload must be a structured object');

  // The eval payload sets version_bump_required: true.
  const flag = out.version_bump_required ?? out.versionBumpRequired ?? (out.eval && (out.eval.version_bump_required ?? out.eval.versionBumpRequired));
  assert.strictEqual(flag, true, 'a changed artifact re-eval\'d with no bump sets version_bump_required: true');

  // It is emitted as an ADVISORY WARN — never a blocking ERROR (ADR-0007); the run does not block.
  if (Array.isArray(out.findings)) {
    const bumpFinding = out.findings.find((f) => f && /version[_ ]?bump/i.test(String(f.message)));
    if (bumpFinding) assert.strictEqual(bumpFinding.level, 'WARN', 'version_bump_required surfaces at WARN (advisory)');
    assert.ok(!out.findings.some((f) => f && f.level === 'ERROR'), 'the run does NOT block (no ERROR finding)');
  }
  if ('ok' in out) assert.notStrictEqual(out.ok, false, 'an advisory bump WARN does not fail the run');
});

// ===========================================================================
// EVAL-EVAL-013 — the ledger is APPEND-ONLY; baselines.json and dashboard.md are
// DERIVED purely from it. Two runs append two lines; the FIRST line is byte-
// unchanged after the second run. (BR-EVAL-018). Real fs sandbox; no model call.
// ===========================================================================
test('EVAL-EVAL-013 — two runs append two ledger lines; the first is byte-unchanged; views derive from the ledger', async () => {
  const root = mkSandbox('ledger013');
  try {
    const mod = await tryImport(EVAL_HARNESS_MODULE);
    const appendLedger = resolveAppendLedger(mod);
    assert.ok(appendLedger, 'manager/eval-harness.mjs must export an append-only ledger writer — v0.4 RED');

    const resultsDir = path.join(root, 'evals', 'harness', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const ledgerPath = path.join(resultsDir, 'ledger.jsonl');

    const line1 = {
      ts: '2026-06-05T00:00:00Z',
      uid: 'agent:security-reviewer',
      aut_hash: 'sha256:A',
      k: 5,
      case_results: [{ case: 'ssrf-metadata-fetch', verdict: 'PASS', trials: ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'] }],
      metrics: { catch_pow_k: 1.0, clean_pow_k: 1.0 },
      status: 'GREEN',
      version_bump_required: false,
    };
    const line2 = { ...line1, ts: '2026-06-05T01:00:00Z', aut_hash: 'sha256:B', metrics: { catch_pow_k: 0.8, clean_pow_k: 1.0 }, status: 'REGRESSED' };

    /** Call the appender tolerant of (ledgerPath, record) vs ({ledgerPath/resultsDir, record}). */
    const append = (rec) => {
      try {
        appendLedger(ledgerPath, rec);
        return;
      } catch {
        /* fall through */
      }
      try {
        appendLedger({ ledgerPath, resultsDir, record: rec, root });
      } catch {
        /* leaves the file as-is ⇒ assertions below fail RED */
      }
    };

    append(line1);
    const afterFirst = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
    const firstLineBytes = afterFirst.split(/\r?\n/).filter(Boolean)[0] ?? '';

    append(line2);
    const afterSecond = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
    const lines = afterSecond.split(/\r?\n/).filter(Boolean);

    // Two appended lines; the file GREW (no overwrite).
    assert.strictEqual(lines.length, 2, 'two runs ⇒ exactly two appended ledger lines');
    // The FIRST line is byte-unchanged after the second run.
    assert.strictEqual(lines[0], firstLineBytes, 'the first ledger line is byte-unchanged after the second run (append-only)');
    // Both lines are valid JSONL preserving each run's distinct payload.
    assert.strictEqual(JSON.parse(lines[0]).aut_hash, 'sha256:A', 'line 1 preserves the first run');
    assert.strictEqual(JSON.parse(lines[1]).aut_hash, 'sha256:B', 'line 2 is the second run');

    // baselines.json (last-green index) + dashboard.md (snapshot) DERIVE purely from the ledger.
    const deriveViews = resolveDeriveViews(mod);
    if (deriveViews) {
      let views;
      try {
        views = deriveViews({ ledgerPath, resultsDir, root });
      } catch {
        try {
          views = deriveViews(ledgerPath, resultsDir);
        } catch {
          views = undefined;
        }
      }
      // The derived files (if written) regenerate from the ledger; assert the last-green
      // baseline for the artifact is the last GREEN run's hash (sha256:A), not the REGRESSED one.
      const baselinesPath = path.join(resultsDir, 'baselines.json');
      if (fs.existsSync(baselinesPath)) {
        const baselines = JSON.parse(fs.readFileSync(baselinesPath, 'utf8'));
        const lastGreen = baselines['agent:security-reviewer'] ?? (baselines.artifacts && baselines.artifacts['agent:security-reviewer']);
        const baselineHash = typeof lastGreen === 'string' ? lastGreen : lastGreen && (lastGreen.baseline ?? lastGreen.aut_hash ?? lastGreen.hash);
        assert.strictEqual(baselineHash, 'sha256:A', 'baselines.json last-green derives the last GREEN run (sha256:A), not the REGRESSED one');
      } else if (views && typeof views === 'object') {
        const baselines = views.baselines ?? (views.data && views.data.baselines);
        if (baselines && baselines['agent:security-reviewer']) {
          const lg = baselines['agent:security-reviewer'];
          const h = typeof lg === 'string' ? lg : lg.baseline ?? lg.aut_hash ?? lg.hash;
          assert.strictEqual(h, 'sha256:A', 'derived last-green baseline is the last GREEN run');
        }
      }
    }
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// EVAL-EVAL-014 — judge_cal: a model judge whose own pass^k < 1.00 on its
// calibration set is PULLED from the gate (its cases fall back to the code floor
// or block); only a judge at judge_cal == 1.00 may gate. (BR-EVAL-020)
// The calibration is computed DETERMINISTICALLY from a verdict vector — no model call.
// ===========================================================================
test('EVAL-EVAL-014 — a model judge with judge_cal < 1.00 is excluded from the gate; only judge_cal == 1.00 gates', async () => {
  const mod = await tryImport(EVAL_HARNESS_MODULE);
  const judgeGate = resolveJudgeGate(mod);
  assert.ok(judgeGate, 'manager/eval-harness.mjs must export a judge-calibration gate — v0.4 RED');

  const call = (input) => {
    let out;
    try {
      out = judgeGate(input);
    } catch {
      out = undefined;
    }
    return out;
  };

  /** Read the "is this judge allowed to gate?" decision out of whatever shape is returned. */
  const gating = (o) => {
    if (typeof o === 'boolean') return o;
    if (o && typeof o === 'object') {
      if (typeof o.gates === 'boolean') return o.gates;
      if (typeof o.gating === 'boolean') return o.gating;
      if (typeof o.allowed === 'boolean') return o.allowed;
      if (typeof o.excluded === 'boolean') return !o.excluded;
    }
    return undefined;
  };

  // A STABLE judge: every calibration trial agreed with ground truth ⇒ judge_cal = 1.00 ⇒ may gate.
  const stable = call({ judge: 'eval-judge-cold', calibration: ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'] });
  assert.strictEqual(gating(stable), true, 'judge_cal == 1.00 ⇒ the judge may gate');

  // A FLAKY judge: one calibration trial disagreed ⇒ judge_cal = 0.8 < 1.00 ⇒ PULLED from the gate.
  const flaky = call({ judge: 'eval-judge-flaky', calibration: ['PASS', 'FAIL', 'PASS', 'PASS', 'PASS'] });
  assert.strictEqual(gating(flaky), false, 'judge_cal < 1.00 ⇒ the judge is EXCLUDED from gating (falls back to code floor / block)');

  // The computed judge_cal is exact (pass^k of the calibration vector), if surfaced.
  if (flaky && typeof flaky === 'object') {
    const cal = flaky.judge_cal ?? flaky.judgeCal ?? flaky.cal;
    if (typeof cal === 'number') assert.ok(cal < 1.0, 'a flaky judge has judge_cal < 1.00');
  }
});

// ===========================================================================
// CLI SURFACE — the planned-notice today; structured report later.
// `forge eval-harness --report --json` must one day emit the C3 envelope with a
// coverage top-line. Today it prints a "planned for v0.4" notice and exits 0
// WITHOUT a JSON envelope, so the structured assertions register as RED (not a
// crash). NOTE: NO model call — `--report` "runs nothing" per SPEC-07 §CLI.
// ===========================================================================
test('EVAL-EVAL-CLI — `forge eval-harness --report --json` emits a C3 envelope with a coverage top-line', async () => {
  const { env } = runEvalHarnessJson(['--report'], FORGE_ROOT);

  // Today: a planned-notice, no JSON envelope ⇒ env is null ⇒ RED. When the slice lands,
  // the C3 envelope appears and these assertions pass.
  assert.ok(env && typeof env === 'object', 'eval-harness --report --json must emit a parseable C3 envelope (planned-notice today ⇒ RED)');
  assert.strictEqual(env.command, 'eval-harness', 'envelope.command names the verb');
  assert.ok(Array.isArray(env.findings), 'envelope carries a findings[] array (C3)');
  assert.ok(env.summary && typeof env.summary === 'object', 'envelope carries a summary triple (C3)');

  // The coverage top-line is reported in `data`.
  const data = env.data;
  assert.ok(data && typeof data === 'object', 'eval-harness --report fills the data payload (coverage + status table)');
  const cov = data.coverage;
  assert.ok(cov !== undefined && cov !== null, 'the report carries a loud coverage % top-line (M/N)');
});
