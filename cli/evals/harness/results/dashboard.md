# Eval-of-harness — dashboard (DERIVED)

> Regenerated PURELY from `results/ledger.jsonl` + `manifest.json` (BR-EVAL-018). Do **not** hand-edit as
> truth — the ledger is the source of truth. `U` renders `—`, never `0`/`1` (BR-EVAL-010). No artifact has a
> letter grade yet: a grade requires a **LIVE** reviewer/judge run across k worktrees (a model call, not run
> in this offline corpus authoring — SPEC-07 §CLI: `--report` "runs nothing").

## Coverage

**3 / 3 targeted artifacts have an authored golden set (100%).**

(Coverage is over the artifacts this corpus targets — two reviewers plus the `catalog-judge` conflict judge;
the registry-wide coverage % — golden sets ÷ all registry artifacts — is computed by `forge status` against
the full registry.)

| Artifact | Golden set | Cases | catch^5 | clean^5 | judge_cal | Grade | Status |
|---|---|---|---|---|---|---|---|
| `agent:security-reviewer` | yes | `ssrf-metadata-fetch` (planted), `clean-allowlisted-fetch` (clean) | — | — | n/a | — | UNEVALUATED |
| `agent:code-reviewer` | yes | `nplus1-missing-index` (planted), `clean-batched-query` (clean) | — | — | n/a | — | UNEVALUATED |
| `bundle:catalog-judge` | yes | `uid-collision-replace`, `uid-collision-keep`, `near-dup-both`, `flagged-injection-quarantine` | n/a | n/a | — | — | UNEVALUATED |

## Cases

| Case | AUT | Class | Planted defect → cite | Verifies |
|---|---|---|---|---|
| `ssrf-metadata-fetch` | security-reviewer | planted-defect | SSRF at `app.py:42` (≥ HIGH) | EVAL-EVAL-001 |
| `clean-allowlisted-fetch` | security-reviewer | clean | zero findings on 3 traps | EVAL-EVAL-002 |
| `nplus1-missing-index` | code-reviewer | planted-defect | N+1 `orders.py:36` + missing index `schema.sql:19` (≥ MEDIUM) | EVAL-EVAL-001 |
| `clean-batched-query` | code-reviewer | clean | zero findings on 3 traps | EVAL-EVAL-002 |

### Judge calibration cases (`catalog-judge`, conflict-judge — `manifest.judge_cases[]`)

| Case | AUT | Conflict kind | Expected verdict | Verifies |
|---|---|---|---|---|
| `uid-collision-replace` | catalog-judge | uid-collision | `replace` (incoming dominates → T2 human-applied) | EVAL-EVAL-014 |
| `uid-collision-keep` | catalog-judge | uid-collision | `keep` (existing is better; not "newer wins") | EVAL-EVAL-014 |
| `near-dup-both` | catalog-judge | near-dup | `both` (the near-dup flag was a false positive) | EVAL-EVAL-014 |
| `flagged-injection-quarantine` | catalog-judge | uid-collision | `quarantine` (planted injection + RED security signal) | EVAL-EVAL-014 |

## How a grade is earned (LIVE, not run here)

For each REVIEWER case, the real reviewer agent is run across k=5 isolated git worktrees (the edited prompt
overlaid on these stable committed fixtures, `skills/run-eval`). Each trial's transcript is scored by the
deterministic code grader (`gradeReviewerCase`) against the case's `EXPECTED.json` — no model judgment decides
TP/FP. The offline `selftest.mjs` proves the grader scores hand-written mock catch/clean transcripts PASS and
mock miss/noisy transcripts FAIL, so the machinery is correct before any live run.

For the JUDGE cases, the real `catalog-judge` is run across the four conflict fixtures; each trial's emitted
verdict is scored by a deterministic **verdict-match** against `EXPECTED.json#expected.verdict` (a judge is not
graded by findings). The per-case PASS/FAIL vector is fed to the harness `judgeGate` (BR-EVAL-020) to compute
`judge_cal = pass^k`; a judge below `judge_cal = 1.00` is **pulled from the admission gate** and advises only
(catalog-judge INV-5). `selftest.mjs` proves the verdict-matcher scores the mock MATCH transcripts PASS and
MISS transcripts FAIL, and that the all-MATCH calibration set yields `judge_cal = 1.00` / `gates: true`.
