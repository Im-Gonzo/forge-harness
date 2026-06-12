// @ts-check
/**
 * selftest — OFFLINE verification of the harness golden-set CORPUS (SPEC-07).
 *
 * This is NOT a live eval. It NEVER calls a model. It loads the hand-written mock
 * reviewer transcripts in `transcripts/` together with each fixture's
 * `EXPECTED.json` ground truth and runs them through the DETERMINISTIC code grader
 * (`gradeReviewerCase`) and metric roll-up (`computeMetrics`) exported by the real
 * `manager/eval-harness.mjs`. It asserts:
 *
 *   1. Every CATCH/CLEAN transcript scores PASS (the reviewer would have done its job).
 *   2. Every MISS/NOISY transcript scores FAIL (the grader catches a bad reviewer).
 *   3. The manifest's coverage roll-up, fed to the harness `report()`, is > 0.
 *
 * It ALSO calibrates the `catalog-judge` bundle (manifest `judge_cases[]`). A judge is
 * NOT graded by `gradeReviewerCase` (findings vs defects); it emits a CLOSED verdict
 * {keep|replace|both|quarantine} and is graded by VERDICT-MATCH against
 * `EXPECTED.json#expected.verdict` using the small deterministic `gradeJudgeVerdict`
 * matcher below. The per-case PASS/FAIL vector is then fed to the harness's real
 * `judgeGate` (BR-EVAL-020) to compute `judge_cal = pass^k`; the corpus is authored so the
 * all-MATCH vector yields `judge_cal === 1.0` and `gates === true` (the judge MAY gate),
 * while a single injected MISS drops it below 1.00 and pulls the judge from the gate.
 *
 * Running a REAL reviewer or judge across k worktrees is a LIVE model-calling operation,
 * exercised manually — never here. This file proves only that the corpus is
 * well-formed and the grader scores it correctly.
 *
 * Run: `node evals/harness/selftest.mjs`  (exit 0 = all green, 1 = a failure)
 * Zero runtime deps: node: builtins + a relative import of the manager module.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gradeReviewerCase,
  computeMetrics,
  report,
  judgeGate,
} from '../../manager/eval-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(HERE, '..', '..');

/** Fail-open JSON read relative to the harness dir. */
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(HERE, rel), 'utf8'));
}

/** A tiny assertion that records pass/fail without throwing past the loop. */
const results = [];
function check(name, cond) {
  results.push({ name, pass: cond === true });
}

const manifest = readJson('manifest.json');

// --- 1+2) Grade every case's mock transcripts against its EXPECTED.json. ------
// Each planted-defect case has {catch -> PASS, miss -> FAIL}; each clean case has
// {clean -> PASS, noisy -> FAIL}. The grader verdict must match these labels.
const EXPECT_PASS = new Set(['catch', 'clean']);
const EXPECT_FAIL = new Set(['miss', 'noisy']);

for (const c of manifest.cases) {
  const expected = readJson(c.expected);
  for (const [label, rel] of Object.entries(c.transcripts || {})) {
    const transcript = readJson(rel);
    const graded = gradeReviewerCase(transcript, expected);
    if (EXPECT_PASS.has(label)) {
      check(`${c.id}/${label} => PASS`, graded.pass === true);
    } else if (EXPECT_FAIL.has(label)) {
      check(`${c.id}/${label} => FAIL`, graded.pass === false);
    }
  }
}

// --- 3) A k=5 metric roll-up: 5 PASS catch trials + 5 PASS clean trials = ----
//        catch^5 = 1.0, clean^5 = 1.0, fp_rate = 0.0 (the GREEN reviewer shape).
const greenMetrics = computeMetrics(
  ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'],
  ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'],
);
check('green metrics catch^5 = 1.0', greenMetrics.catch_pow_k === 1.0);
check('green metrics clean^5 = 1.0', greenMetrics.clean_pow_k === 1.0);
check('green metrics fp_rate = 0.0', greenMetrics.fp_rate === 0.0);

// One noisy clean trial drops clean^5 to 0 and fp_rate above 0 (REGRESSED shape).
const noisyMetrics = computeMetrics(
  ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'],
  ['PASS', 'FAIL', 'PASS', 'PASS', 'PASS'],
);
check('noisy metrics clean^5 = 0.0', noisyMetrics.clean_pow_k === 0.0);
check('noisy metrics fp_rate = 0.2', Math.abs(noisyMetrics.fp_rate - 0.2) < 1e-9);

// --- 4) Coverage roll-up: feed the manifest artifacts into the harness report. -
const rep = report({ artifacts: manifest.artifacts });
check('coverage covered > 0', rep.coverage.covered > 0);
// 3 artifacts now carry a golden set: agent:security-reviewer, agent:code-reviewer, and
// bundle:catalog-judge (the conflict-judge calibration set added in this corpus).
check('coverage covered == 3', rep.coverage.covered === 3);
check(
  'every covered artifact renders U as "—" (never 0/1)',
  rep.artifacts.every((a) => a.rendered === '—'),
);

// --- 5) JUDGE CALIBRATION (catalog-judge, manifest judge_cases[]). ------------
// A judge emits a CLOSED verdict, not findings — so it is graded by a verdict-MATCH
// against EXPECTED.json#expected.verdict, NOT by gradeReviewerCase. The matcher below is
// the deterministic code floor for a conflict-judge: the verdict enum is closed, and any
// out-of-enum verdict is treated as 'quarantine' (the safe default), never silently
// coerced to 'keep' (catalog-judge INV-2). The per-case PASS/FAIL vector is then fed to the
// harness's real judgeGate to compute judge_cal = pass^k (BR-EVAL-020 / EVAL-EVAL-014).
const VERDICT_ENUM = new Set(['keep', 'replace', 'both', 'quarantine']);

/** Normalize a judge verdict to the closed enum; anything else ⇒ 'quarantine'. */
function normalizeVerdict(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return VERDICT_ENUM.has(s) ? s : 'quarantine';
}

/**
 * Grade ONE mock judge transcript against EXPECTED.json. PASS iff the emitted verdict
 * matches the expected verdict; for a verdict that crowns a winner (keep/replace), the
 * winning role must also match so a right-verdict/wrong-winner trial still FAILS.
 */
function gradeJudgeVerdict(transcript, expected) {
  const exp = (expected && expected.expected) || {};
  const want = normalizeVerdict(exp.verdict);
  const got = normalizeVerdict(transcript && transcript.verdict);
  if (got !== want) return { pass: false, want, got };
  // For a winner-crowning verdict, the winning role must also agree.
  if ((want === 'keep' || want === 'replace') && exp.winning_role) {
    if (String(transcript.winning_role || '') !== String(exp.winning_role)) {
      return { pass: false, want, got, reason: 'wrong winning_role' };
    }
  }
  return { pass: true, want, got };
}

// Grade every judge case: MATCH transcript must PASS, MISS transcript must FAIL. The
// all-MATCH verdict vector (one PASS per case) is the calibration set fed to judgeGate.
const judgeCases = Array.isArray(manifest.judge_cases) ? manifest.judge_cases : [];
const calibrationVector = []; // one verdict per case = the judge's calibration run
for (const jc of judgeCases) {
  const expected = readJson(jc.expected);
  const t = jc.transcripts || {};
  const matched = gradeJudgeVerdict(readJson(t.match), expected);
  const missed = gradeJudgeVerdict(readJson(t.miss), expected);
  check(`judge ${jc.id}/match => PASS (verdict '${expected.expected.verdict}')`, matched.pass === true);
  check(`judge ${jc.id}/miss => FAIL`, missed.pass === false);
  // The judge's own calibration trial for this case = its MATCH verdict (the disciplined run).
  calibrationVector.push(matched.pass ? 'PASS' : 'FAIL');
}

// Feed the all-MATCH calibration vector through the harness's REAL judgeGate (BR-EVAL-020):
// pass^k = 1.00 ⇒ judge_cal = 1.0 and the judge MAY gate (gates === true). This is the exact
// gate the catalog-judge bundle's INV-5 requires before it may GATE an admission.
const greenGate = judgeGate({ judge: 'bundle:catalog-judge', calibration: calibrationVector });
check('judge_cal == 1.0 on the all-MATCH conflict set', greenGate.judge_cal === 1.0);
check('catalog-judge gates at judge_cal == 1.00', greenGate.gates === true);
check('calibration set has 4 conflict cases (keep/replace/both/quarantine)', calibrationVector.length === 4);

// A single FAIL anywhere in the calibration vector pulls the judge from the gate (a
// miscalibrated judge advises only — INV-5 / BR-EVAL-020). Proves the gate enforces pass^k.
const flakyVector = ['PASS', 'FAIL', 'PASS', 'PASS'];
const pulledGate = judgeGate({ judge: 'bundle:catalog-judge', calibration: flakyVector });
check('judge_cal < 1.0 with one miss pulls the judge from the gate', pulledGate.gates === false);
check('flaky judge_cal == 0.75 (3/4)', Math.abs(pulledGate.judge_cal - 0.75) < 1e-9);

// --- Report ------------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n`);
}
process.stdout.write(
  `\n[selftest] ${results.length - failed}/${results.length} green · coverage ${rep.coverage.covered}/${rep.coverage.total}` +
    ` · catalog-judge judge_cal ${greenGate.judge_cal.toFixed(2)} (gates: ${greenGate.gates})\n`,
);
void FORGE_ROOT;
process.exit(failed === 0 ? 0 : 1);
