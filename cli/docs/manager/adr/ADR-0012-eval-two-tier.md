# ADR-0012: Eval-of-harness is two-tier — static prose meta-tests (Tier S) gate behavioral evals (Tier B)

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.4

## Context

Forge today validates *itself* with one mechanism: **static prose meta-tests** under `tests/meta/*.mjs`.
`reviewer-anti-noise.mjs` asserts every reviewer still carries the Pre-Report Gate, the "a clean review
is a valid review" clause, and the HIGH/CRITICAL-require-proof rule; `reviewers-read-only.mjs` asserts no
reviewer's `tools:` grants Edit/Write; `skill-governance.mjs` asserts `run-eval` still says `pass@k`/`pass^k`
and `dual-review` still says "two independent reviewers". These are real and load-bearing — but they only
answer one question: **"is the artifact still *shaped* right?"** They grep for governance prose. A
`security-reviewer` whose prompt still contains every required phrase, yet which silently stops flagging a
planted SSRF, passes every meta-test green. Forge can prove its reviewers *say* the right things; it cannot
prove they *do* their job.

The proportionality verdict (`ideas/01-proportionality.md`, Tier 2) names the trigger that closes this gap:
*"you edit a reviewer and want proof it still catches planted defects."* The kept core is **planted-defect +
clean-code pass/fail cases** measuring catch-rate and false-positive rate; the A–F GPA is explicitly dropped
(deferred). This ADR fixes the *structure* that core lives in: where behavioral evals sit relative to the
existing meta-tests, and what it means when one passes but the other fails.

The danger to avoid: two *independent, co-equal* gates produce ambiguity. If a reviewer's prose meta-test is
red (the Pre-Report Gate was deleted) but its behavioral eval is green (it happened to still catch the
planted defect on this run), is the reviewer shippable? Treating them as peers invites "the behavioral run
was green, ship it" — laundering a governance regression through a lucky behavioral pass. The two signals are
not peers; one is a precondition for the other to *mean anything*.

## Decision

**Eval-of-harness is two tiers, ordered, with Tier S a hard precondition for Tier B.**

- **Tier S — static prose meta-tests** (`tests/meta/*.mjs`, **EXISTS today**). Answers *"is the artifact
  still shaped right / is the governance prose present?"* Deterministic, dependency-free, code-graded. This
  ADR does not change Tier S; it names it as the first tier and the gate.
- **Tier B — behavioral evals** (**NEW**, `forge/evals/harness/`). Answers *"does the artifact actually DO
  its job?"* — a reviewer catches a planted defect citing the line at the right severity; a reviewer stays
  silent on clean-but-suspicious code; `plan-orchestrate` classifies a step's tier correctly; `load-bundle`
  reads COLD just-in-time. Runs each trial in an isolated git worktree (reuses `skills/run-eval`, per
  `evals/README.md`).

**The precondition rule (load-bearing):**

1. **Tier S is a precondition for Tier B.** A Tier-B run on an artifact whose Tier S is RED is **void**: it
   produces **no score** and status **`BLOCKED_BY_STATIC`**, not a number. You do not measure whether a
   reviewer with a deleted Pre-Report Gate "still catches the defect" — the artifact is already broken at the
   prose level; the behavioral measurement would be noise.
2. **A Tier-B PASS never excuses a Tier-S FAIL.** Catching the planted defect on a lucky run does not buy
   back a deleted governance clause. The two signals answer different questions; a green answer to one cannot
   overwrite a red answer to the other.
3. **Both are required to ship.** An artifact ships only when Tier S is green **and** Tier B is green (or
   honestly `U`/unevaluated — `BR-EVAL`). Neither tier alone is sufficient.
4. **CI order is fixed:** `lint → meta (Tier S) → harness-eval (Tier B)`. Tier B never runs on an artifact
   Tier S already failed, so `BLOCKED_BY_STATIC` is computed, never measured.

**Cases are pass/fail.** Each Tier-B case is a binary verdict against a ground-truth manifest, not a graded
essay. The per-artifact rollup metrics (catch-rate, false-positive rate, `catch^k`, `clean^k`) are
deterministic functions of pass/fail trials. The **letter-grade health composite is OPTIONAL and DEFERRED**
(per `ideas/01-proportionality.md`): the kept core is the pass/fail catch + FP measurement; the A–F + `U`
score is specified in `SPEC-07` but does not ship in v0.4 and does not gate anything until it earns its keep.

**Honest non-scores.** An artifact with no golden set is **`U` (unevaluated)**, rendered `"—"`, **never 0 or
1** — `0` would imply tested-and-failed, `1` would imply verified; both are lies. Coverage % (artifacts with
a golden set ÷ all artifacts) is a loud top-line metric, separate from health.

**Regression is advisory in v0.4.** An edit drifts an artifact's `contentHash` (`ADR-0005`) away from the
hash its eval was pinned to → status `STALE` → re-eval in a worktree → a `catch^k`/`clean^k` drop vs the
last-green baseline ⇒ `REGRESSED`. `REGRESSED` is a **`WARN`**, not a commit/version block, in v0.4
(`ADR-0007`); it is promotable to blocking once enough eval data exists to justify it.

## Consequences

**Positive**
- Closes the exact hole the meta-tests cannot see: prose-present-but-behavior-broken. A reviewer that stops
  catching its planted defect now fails a gate, where before it passed silently.
- No ambiguity about mixed signals: `BLOCKED_BY_STATIC` is a defined, non-numeric status, so a prose
  regression can never be laundered through a behavioral pass.
- Cheap to start: Tier S already exists; Tier B reuses `run-eval`'s worktree isolation and the established
  `code > model > human` grader ladder. Nothing new is invented at the infrastructure layer.
- `U`/coverage make the *absence* of measurement visible and honest, instead of a false green.

**Negative**
- Tier B requires a golden corpus (planted-defect + clean fixtures per reviewer); building it is real work
  and the `author-eval` test-first discipline now extends to "an artifact can't leave `U` without a golden
  set" (`BR-EVAL`). Mitigated: the corpus is small, harvested directly from each reviewer's own
  "common false positives — do NOT report" list, and grown incrementally as artifacts are edited.
- A model-graded behavioral case (e.g. COLD-discipline) adds non-determinism; mitigated by a deterministic
  floor and by measuring the judge's own `pass^k` (`judge_cal`) and pulling a flaky judge from the gate.

**Neutral**
- Two tiers means two CI stages where there was one; the order is fixed and cheap, and Tier B is skipped
  entirely for an artifact whose Tier S is red, so total cost is bounded.
- The deferred health GPA is fully specified now so the model is coherent and growable, but ships dark.

## Alternatives considered

- **One flat eval suite (no tiers).** Rejected: it cannot express "this behavioral score is void because the
  prose is already broken." A flat suite either ignores the prose meta-tests or averages them with behavioral
  results, both of which let a governance regression hide behind a lucky behavioral run.
- **Tier B replaces Tier S.** Rejected: behavioral evals are non-deterministic and expensive; the cheap,
  deterministic prose check is a strictly-better first filter and already ships. Replacing it would lose a
  fast, free signal and make every prose regression cost a full behavioral run to notice.
- **Co-equal tiers, ship on either green.** Rejected as the core failure mode this ADR exists to prevent
  (laundering a prose FAIL through a behavioral PASS).
- **Ship the A–F health GPA now.** Rejected per proportionality: at `n=1` with a handful of artifacts, a
  letter grade over a tiny trial count is "noise wearing a lab coat." The pass/fail catch + FP numbers are
  the kept core; the GPA is deferred until it earns its keep.

## Related

ADR-0005 (`contentHash` is the staleness primitive `pinnedHash` derives from), ADR-0006 (the `revision`/bump
the regression gate couples to), ADR-0007 (advisory-first gates — why `REGRESSED` is a WARN in v0.4),
ADR-0014 (manager is subject to forge-validates-forge — Tier S is the existing instance), C1, C5,
BR-EVAL, BR-REG (registry stores the eval-linkage payload + `contentHash`), BR-VER (the bump gate this
couples to), SPEC-07, EVAL-EVAL.
