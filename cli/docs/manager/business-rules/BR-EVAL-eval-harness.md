# Business Rules — Eval-of-Harness & Health (BR-EVAL)

> Normative rules for the eval-of-harness dimension: the two-tier model (static prose meta-tests gate
> behavioral evals), the reviewer golden sets (planted-defect + clean), the per-artifact metrics, honest
> non-scores, and advisory regression. Decided by `ADR-0012`; detailed in `SPEC-07`; proven by `EVAL-EVAL`.
>
> **Phase:** every rule below is **v0.4** unless noted. **Priority key:** the **catch-rate and
> false-positive-rate pass/fail core is `MUST`**; the **letter-grade health composite is `SHOULD` /
> DEFERRED** per `ideas/01-proportionality.md` — specified so the model is coherent and growable, but it does
> not ship in v0.4 and gates nothing. Foreign rules are named by prefix only: registry/`contentHash` storage
> = `see BR-REG` / `ADR-0005,0006`; the version-bump gate = `see BR-VER` / `ADR-0007`; the value-density
> consumer = `see BR-EFF`.

---

## A. The two-tier model

### BR-EVAL-001 — Tier S (static prose meta-tests) is a precondition for Tier B (behavioral evals)

**Rule:** A Tier-B behavioral eval **MUST NOT** produce a score for an artifact whose Tier-S meta-tests
(`tests/meta/*.mjs`) are RED. The Tier-B result for such an artifact **MUST** be status `BLOCKED_BY_STATIC`
with no numeric metrics. CI **MUST** run the tiers in the order `lint → meta (Tier S) → harness-eval
(Tier B)`, so a Tier-B run on a Tier-S-failing artifact is never even attempted.
**Rationale:** Tier S answers "is the artifact still shaped right?" (governance prose present); Tier B answers
"does it actually do its job?". Measuring behavior on an artifact already broken at the prose level is noise,
and a defined non-numeric status prevents that noise from masquerading as a score.
**Acceptance:** `EVAL-EVAL-006` — an artifact with a deleted Pre-Report Gate (Tier-S RED) yields
`BLOCKED_BY_STATIC` and no `catch_rate`, never a behavioral PASS.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Two-tier; Tier S = `tests/meta/reviewer-anti-noise.mjs`,
`reviewers-read-only.mjs`, `skill-governance.mjs`.

### BR-EVAL-002 — a Tier-B PASS never excuses a Tier-S FAIL

**Rule:** A green Tier-B behavioral result **MUST NOT** override, satisfy, or suppress a red Tier-S result.
An artifact **MUST** be both Tier-S green **and** Tier-B green (or honestly `U` — `BR-EVAL-010`) to be
reported shippable; neither tier alone is sufficient.
**Rationale:** Catching the planted defect on a lucky run does not buy back a deleted governance clause. The
two tiers answer different questions; a green answer to one cannot launder a red answer to the other.
**Acceptance:** `EVAL-EVAL-006` (same fixture) — with Tier-S RED, the rollup is BLOCKED even though the
reviewer would have caught the defect; ship-readiness is false.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Two-tier.

### BR-EVAL-003 — Tier-B trials run in worktree isolation against stable fixtures

**Rule:** Every Tier-B trial **MUST** run in a throwaway `git worktree` cut from the pinned baseline, with the
artifact-under-test (the *edited* prompt) overlaid on the *stable* committed fixtures, reusing the
`skills/run-eval` isolation procedure. A trial **MUST NOT** run in the live working tree, and **MUST NOT**
let one trial's writes contaminate another.
**Rationale:** Behavioral trials are non-deterministic; isolation is the reproducibility guarantee
(`evals/README.md`, `skills/run-eval` Phase 2). Holding fixtures stable while varying only the prompt is what
makes a regression attributable to the edit.
**Acceptance:** `EVAL-EVAL-007` — two trials of the same case leave no residue in the base repo and the
worktree is removed after each.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Runner; `skills/run-eval` Phase 2; `evals/README.md` §Worktree isolation.

---

## B. Reviewer golden sets — the two mandatory case classes

### BR-EVAL-004 — every reviewer artifact carries a planted-defect case (catch-rate / true positives)

**Rule:** Each reviewer agent (`code-reviewer`, `diff-reviewer`, `python-reviewer`, `typescript-reviewer`,
`database-reviewer`, `security-reviewer`) **MUST** have at least one **planted-defect** case: a fixture
containing a known defect at a known `file:line`, with an `EXPECTED.json` manifest stating the class, line,
and minimum severity. The case **PASSES** iff the reviewer flags that defect at or above `min_severity` and
**cites the planted line**. This measures the artifact's **catch-rate** (true-positive rate).
**Rationale:** The anti-noise reviewers' whole value is catching real defects; a prose meta-test cannot verify
they still do. A line-cited, severity-floored ground truth makes catch-rate a deterministic, code-graded
number.
**Acceptance:** `EVAL-EVAL-001` — `security-reviewer` on a fixture with a planted SSRF at `app.py:42` flags it
HIGH citing line 42; a run that misses it or cites the wrong line FAILS. Code-graded against `EXPECTED.json`.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Golden sets, §EXPECTED.json; `agents/security-reviewer.md` (threat model).

### BR-EVAL-005 — every reviewer artifact carries a clean case (false-positive rate)

**Rule:** Each reviewer agent **MUST** have at least one **clean** case: production-shaped, *correct* code
that *resembles* a defect (an allowlisted outbound fetch, MD5 used as a checksum/ETag, an already-parameterized
ORM call, a public Stripe `pk_` key). The case **PASSES iff the reviewer returns zero findings** on the
marked clean lines/traps. This measures the artifact's **false-positive rate**, operationalizing "a clean
review is a valid review" as a measured number. Clean fixtures **SHOULD** be harvested from the reviewer's own
"common false positives — do NOT report" list.
**Rationale:** A reviewer that flags everything has a perfect catch-rate and is useless. Forge's anti-noise
ethic ("manufactured findings erode trust faster than a missed bug") is only enforceable if false positives
are *counted*. Sourcing traps from each reviewer's own do-not-report list makes the case self-consistent with
the prompt.
**Acceptance:** `EVAL-EVAL-002` — `security-reviewer` on a fixture where MD5 is a cache key and the only
outbound fetch is allowlisted returns zero findings (`fp_rate = 0`); any finding on a clean trap FAILS.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Golden sets; `agents/*.md` §"Common false positives — do NOT report";
`tests/meta/reviewer-anti-noise.mjs` (the prose half this measures behaviorally).

### BR-EVAL-006 — ground truth is a closed, code-decidable defect manifest

**Rule:** Every fixture **MUST** ship an `EXPECTED.json` defect manifest with shape
`{ defects[]{ id, class, file, line, min_severity, match.any_of[] }, clean_lines[], clean_traps[] }`. A code
grader **MUST** decide a true positive deterministically: a finding counts only if it cites a line in the
defect's `line`/range, names the defect via the **closed phrase set** `match.any_of[]`, and meets
`min_severity`. A finding on any `clean_line`/`clean_trap` is a **false positive**. The grader **MUST NOT**
use a free-form or model judgment to decide TP/FP for reviewer cases.
**Rationale:** Determinism is the point of the code grader (grader ladder: `code > model`). A closed
phrase-set plus a line cite plus a severity floor removes judgment from the catch/FP decision, so the metric
is reproducible (`pass^k = 1.00` for the grader itself).
**Acceptance:** `EVAL-EVAL-001` and `EVAL-EVAL-002` are both graded entirely from `EXPECTED.json` with no
model call; `EVAL-EVAL-010` asserts the grader's own determinism (`pass^k = 1.00`).
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §EXPECTED.json; grader ladder `evals/README.md` §Grader ladder.

---

## C. Skill golden sets — discipline cases

### BR-EVAL-007 — `plan-orchestrate` under-classification of a tier is an ∞-weighted SAFETY failure

**Rule:** The `plan-orchestrate` golden set **MUST** include a tier-classification labelset, and the case
**MUST** treat **under-classification** (labeling a true-T2 step T0/T1, i.e. dropping a human gate or a
mandatory reviewer) as a **SAFETY failure that fails the whole case on a single instance** (∞-weighted).
**Over-classification** (labeling a T0/T1 step T2) is tolerated and **MUST NOT** fail the case.
**Rationale:** A T2 step is irreversible / security- / tenancy- / migration-touching; mis-classifying it
*down* removes the human-apply gate — the exact safety mechanism. The asymmetry mirrors the skill's own rule
("the higher tier wins; a plan can never lower a step's tier"). One missed gate is one too many.
**Acceptance:** `EVAL-EVAL-003` — on a labelset where one step touches `auth.ts`, classifying it T1 (no
human gate) FAILS the case even if every other label is correct; classifying a read-only step T2 PASSES.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Skill cases; `skills/plan-orchestrate/SKILL.md` Phase 2(b) (autonomy tier);
`rules/autonomy-ladder.md`.

### BR-EVAL-008 — `load-bundle` COLD-discipline is graded code-floor-then-model

**Rule:** The `load-bundle` golden set **MUST** verify COLD discipline (one WARM bundle; COLD corpus pulled
just-in-time, never pre-loaded whole) with a **deterministic code floor** — grep the transcript for COLD
file reads and assert no whole-spec pre-load — **paired** with a model judge for the residual judgment. The
model judge **MUST NOT** be the sole grader.
**Rationale:** "Did COLD discipline hold in this transcript?" is partly mechanical (which files were read
whole) and partly judgment; the grader ladder requires a deterministic floor under any model grade
(`evals/README.md`).
**Acceptance:** `EVAL-EVAL-008` — a transcript that pre-loads a whole spec the bundle merely points at FAILS
the code floor regardless of the model's verdict.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Skill cases; `skills/load-bundle/SKILL.md` Phase 3; `evals/README.md`
§Grader ladder.

### BR-EVAL-009 — `dual-review` independence is code-graded (two distinct sub-agents, no cross-feeding)

**Rule:** The `dual-review` golden set **MUST** verify independence with a **code grader**: exactly two
distinct reviewer sub-agents were spawned and neither received the other's assessment as input (no
cross-feeding). A single reviewer, or inline "now act as reviewer 2", **MUST** FAIL the case.
**Rationale:** The skill's entire value is breaking shared blind spots via context isolation; inline
role-play does not give true isolation. Spawn-count and input-isolation are mechanically checkable, so this is
code-graded, not model-graded.
**Acceptance:** `EVAL-EVAL-009` — a run that spawns one sub-agent, or feeds reviewer-1's verdict into
reviewer-2's prompt, FAILS; two isolated sub-agents with identical rubric and no shared assessment PASS.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Skill cases; `skills/dual-review/SKILL.md` Phase 2 (context isolation).

---

## D. Honest non-scores, coverage, staleness

### BR-EVAL-010 — `U` (unevaluated) is rendered `—`, never 0 or 1

**Rule:** An artifact with no golden set **MUST** carry grade `U` / status `UNEVALUATED`, rendered `"—"`. A
`U` artifact **MUST NOT** be reported as health `0` or `1`, and **MUST NOT** be coerced to either by any
downstream consumer. New artifacts ship `U`.
**Rationale:** `0` implies tested-and-failed; `1` implies verified — both are lies about an untested
artifact. An honest non-score is the only defensible default (glossary: "Grade `U`").
**Acceptance:** `EVAL-EVAL-005` — a freshly-scanned artifact with no case reports `grade: "U"`,
`status: "UNEVALUATED"`, render `"—"`; asserting it is neither `0` nor `1` in the eval payload and in
`forge status`.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Health, §Honesty; glossary "Grade `U`"; eval payload stored `see BR-REG`.

### BR-EVAL-011 — author-eval discipline: an artifact cannot leave `U` without an authored golden set

**Rule:** An artifact's status **MUST NOT** advance from `U`/`UNEVALUATED` to a scored status without an
authored, test-first golden set for it (the `author-eval` discipline extended to the harness corpus). A case
**MUST** have been red on the pre-feature tree before it can certify an artifact out of `U`.
**Rationale:** Test-first is forge's EDD cardinal rule; a case that has never been red asserts nothing. This
prevents "score it green by writing a trivially-true case after the fact."
**Acceptance:** `EVAL-EVAL-011` — attempting to score an artifact with no authored case is rejected; the
artifact stays `U`.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Coverage; `skills/author-eval/SKILL.md` (test-first, "a new case must fail
first").

### BR-EVAL-012 — coverage % is a loud top-line metric

**Rule:** The harness health surface (`dashboard.md`, `forge status`) **MUST** display **coverage %** =
(artifacts with a golden set ÷ all registry artifacts) as a top-line number, distinct from any health score.
`U` artifacts count *against coverage*, not against health.
**Rationale:** The honest failure mode of an eval system is silent under-coverage; making the unmeasured
fraction loud is what keeps `U` honest rather than hidden.
**Acceptance:** `EVAL-EVAL-005` — with N artifacts and M golden sets, the surface reports
`coverage = M/N`; the `U` artifacts are excluded from the health aggregate.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Coverage; `forge status` `see BR-CLI` (consumer).

### BR-EVAL-013 — STALE is computed from hash drift, never stored

**Rule:** Eval staleness **MUST** be *computed*: an artifact is `STALE` when its registry `contentHash`
(`see BR-REG` / `ADR-0005`) differs from the `pinnedHash` its last eval was graded against
(`graded_against_hash`). Staleness **MUST NOT** be a stored boolean that can drift from reality; it is derived
on read.
**Rationale:** A stored flag is a second source of truth that desyncs (cf. the live-symlink seam, `ADR-0008`).
Deriving STALE from a hash equality makes it correct regardless of how the edit arrived.
**Acceptance:** `EVAL-EVAL-004` — editing a reviewer prompt (so `contentHash != graded_against_hash`) makes
its status compute to `STALE` on the next read, with no write to a staleness field.
**Priority:** MUST
**Refs:** ADR-0012, ADR-0005 (the hash), ADR-0008 (scan-on-demand); `contentHash` storage `see BR-REG`;
SPEC-07 §Staleness.

---

## E. Per-artifact metrics & the deferred health composite

### BR-EVAL-014 — per-artifact metrics are catch_rate, fp_rate, precision, catch@k, catch^k, clean^k

**Rule:** For each evaluated artifact the harness **MUST** compute, from its pass/fail trials:
`catch_rate` (planted defects found ÷ planted), `fp_rate` (clean traps flagged ÷ clean), `precision`,
`catch@k` (≥1 of k trials caught), `catch^k` (all k trials caught), and `clean^k` (all k trials stayed
quiet). The reviewer default is **k = 5**. These metrics are the **kept core**.
**Rationale:** `catch^k`/`clean^k` are the `pass^k` stability bar applied to catch and quiet — the right bar
for a gate where one flaky miss or one flaky false-positive is one too many (`run-eval` Phase 4).
**Acceptance:** `EVAL-EVAL-001`/`EVAL-EVAL-002` report these metrics for the security-reviewer at k=5;
`EVAL-EVAL-010` asserts `catch^k`/`clean^k` are exact functions of the per-trial verdicts.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Metrics; `skills/run-eval/SKILL.md` Phase 4 (`pass@k`/`pass^k`).

### BR-EVAL-015 — health composite (letter grade) is OPTIONAL and DEFERRED

**Rule:** The harness **MAY** compute a health composite
`health = 0.55·catch^k + 0.45·clean^k − 0.50·(1 − clean^k)`, mapped to grades **A–F + U**. When computed, the
weighting **MUST** keep a noisy reviewer scoring **below** a slightly-less-catchy quiet one (the penalty term
on false positives is steeper than the reward, matching forge's anti-noise ethic). This composite **SHOULD
NOT** ship in v0.4 and **MUST NOT** gate anything: the kept core is the pass/fail catch + FP measurement
(`BR-EVAL-014`); the letter grade is deferred until it earns its keep.
**Rationale:** Per `ideas/01-proportionality.md` (Tier 2: "drop the A–F GPA"), a single composite over a tiny
trial count at `n=1` is "noise wearing a lab coat." It is specified so the model is coherent and growable, but
it ships dark. The weighting is recorded now so that *if* it ships, it cannot reward noise.
**Acceptance:** *(deferred — no MUST EVAL case in v0.4.)* A future case would assert
`health(noisy) < health(quiet)` for two reviewers with equal `catch^k` and different `clean^k`.
**Priority:** SHOULD / **DEFERRED**
**Refs:** ADR-0012, SPEC-07 §Health (deferred); `ideas/01-proportionality.md` Tier 2.

---

## F. Regression, trend, ledger, gates

### BR-EVAL-016 — edit → STALE → re-eval; a catch^k or clean^k drop vs baseline is REGRESSED (advisory)

**Rule:** On an artifact going `STALE`, the harness **MUST** re-eval it (worktree, edited prompt over stable
fixtures, `BR-EVAL-003`); if `catch^k` *or* `clean^k` drops below the last-green baseline, status **MUST**
become `REGRESSED`. In v0.4 `REGRESSED` **MUST** be **advisory (a `WARN` finding)**, never a commit or
version block (`ADR-0007`); it is promotable to blocking later.
**Rationale:** Catching fewer defects *or* getting noisier are both regressions of a reviewer. Keeping the
gate advisory in v0.4 follows the proportionality rule (a blocking version-bump gate × a blocking
eval-regression gate is a deadlock surface for a team of one).
**Acceptance:** `EVAL-EVAL-004` — an edit that lowers `catch^k` vs baseline emits a `REGRESSED` **WARN**
(level `WARN`, not blocking) and does not fail the run.
**Priority:** MUST
**Refs:** ADR-0012, ADR-0007 (advisory), SPEC-07 §Regression; the bump gate `see BR-VER`.

### BR-EVAL-017 — mutually-enforcing version-bump <-> re-eval contract (both advisory)

**Rule:** The eval dimension and the versioning dimension **MUST** mutually flag the other's omission:
`contentHash`-change-without-a-version-bump is a registry/version `WARN` (owned `see BR-VER`); a version-bump
without a re-eval of the changed artifact is an **eval `WARN`** (owned here). The eval side **MUST** emit a
`version_bump_required` flag in its payload when a STALE artifact is re-eval'd and changed. Both directions are
**advisory** in v0.4.
**Rationale:** Each gate alone has an escape hatch; the pair makes "I edited a reviewer and told nobody" hard
to do silently, without blocking the solo dev.
**Acceptance:** `EVAL-EVAL-012` — re-eval'ing a changed artifact sets `version_bump_required: true` and emits
a `WARN`, not a block.
**Priority:** MUST
**Refs:** ADR-0012, ADR-0006, ADR-0007; the registry-side WARN `see BR-VER`; SPEC-07 §Gate contract.

### BR-EVAL-018 — the ledger is append-only and is the source of truth

**Rule:** `forge/evals/harness/results/ledger.jsonl` **MUST** be **append-only** — one line per
artifact × run — and is the source of truth for eval history. `baselines.json` (last-green index) and
`dashboard.md` (health snapshot) **MUST** be *derived* from the ledger, never hand-edited. The harness **MUST
NOT** overwrite prior eval history (the deliberate opposite of forge's current overwrite-only `summary.md`).
**Rationale:** Trend and regression need history; an overwrite-only summary discards exactly the data a
regression check reads. Append-only + derived views is the only shape that supports `trend[]` and
last-green baselines.
**Acceptance:** `EVAL-EVAL-013` — two runs append two lines; the first line is never mutated; `baselines.json`
and `dashboard.md` regenerate from the ledger.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Results layout; contrast `skills/run-eval` `summary.md`.

### BR-EVAL-019 — the eval-linkage payload lives in the registry under `artifacts[uid].eval{}`

**Rule:** Per-artifact eval state **MUST** be stored in the **registry** (storage owned `see BR-REG`) under
`artifacts[uid].eval{}` with shape `{ health|null, grade, status, k, metrics{catch_rate, fp_rate,
catch_pow_k, clean_pow_k}, graded_against_hash, baseline, last_run, trend[], ledger_ref }`, where `status ∈
{GREEN, REGRESSED, STALE, UNEVALUATED, BLOCKED_BY_STATIC}` and `health` is `null` while the composite is
deferred (`BR-EVAL-015`). The eval dimension **MUST NOT** create a second authoritative store for this state.
**Rationale:** One identity store, one eval-linkage slot (glossary: registry "carries … an eval-linkage
slot"). `null` health + a real `status` is how a deferred GPA coexists with the kept-core metrics honestly.
**Acceptance:** `EVAL-EVAL-005`/`EVAL-EVAL-004` read `artifacts[uid].eval{}` and assert the status enum and
`health: null`; no parallel eval store exists.
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Payload; registry storage `see BR-REG` / `ADR-0005,0006`.

### BR-EVAL-020 — grader ladder is code > model > human; a model judge measures its own pass^k

**Rule:** Cases **MUST** use the cheapest grader that can decide (`code > model > human`). A model judge
**MUST** be built via the `eval-judge` bundle, **MUST** be paired with a deterministic floor, and its own
calibration stability (`judge_cal`, the judge's `pass^k`) **MUST** be measured; a judge whose `pass^k < 1.00`
on its calibration set **MUST** be pulled from the gate.
**Rationale:** A flaky judge is a flaky gate (`eval-judge` INV-4). All reviewer catch/FP cases are
code-graded; model graders appear only where a script genuinely cannot decide (e.g. COLD discipline), and even
then under a deterministic floor.
**Acceptance:** `EVAL-EVAL-008` (code floor under the model judge) and `EVAL-EVAL-014` (`judge_cal`: a judge
with `pass^k < 1.00` is excluded from gating).
**Priority:** MUST
**Refs:** ADR-0012, SPEC-07 §Grader ladder; `bundles/eval-judge.md` (INV-1..4); `evals/README.md`
§Grader ladder.

---

## Traceability

| BR | Priority | Phase | EVAL case(s) | Decided-by / Detailed-by |
|---|---|---|---|---|
| BR-EVAL-001 | MUST | v0.4 | EVAL-EVAL-006 | ADR-0012 / SPEC-07 |
| BR-EVAL-002 | MUST | v0.4 | EVAL-EVAL-006 | ADR-0012 / SPEC-07 |
| BR-EVAL-003 | MUST | v0.4 | EVAL-EVAL-007 | ADR-0012 / SPEC-07 |
| BR-EVAL-004 | MUST | v0.4 | EVAL-EVAL-001 | ADR-0012 / SPEC-07 |
| BR-EVAL-005 | MUST | v0.4 | EVAL-EVAL-002 | ADR-0012 / SPEC-07 |
| BR-EVAL-006 | MUST | v0.4 | EVAL-EVAL-001, -002, -010 | ADR-0012 / SPEC-07 |
| BR-EVAL-007 | MUST | v0.4 | EVAL-EVAL-003 | ADR-0012 / SPEC-07 |
| BR-EVAL-008 | MUST | v0.4 | EVAL-EVAL-008 | ADR-0012 / SPEC-07 |
| BR-EVAL-009 | MUST | v0.4 | EVAL-EVAL-009 | ADR-0012 / SPEC-07 |
| BR-EVAL-010 | MUST | v0.4 | EVAL-EVAL-005 | ADR-0012 / SPEC-07 |
| BR-EVAL-011 | MUST | v0.4 | EVAL-EVAL-011 | ADR-0012 / SPEC-07 |
| BR-EVAL-012 | MUST | v0.4 | EVAL-EVAL-005 | ADR-0012 / SPEC-07 |
| BR-EVAL-013 | MUST | v0.4 | EVAL-EVAL-004 | ADR-0012 / SPEC-07 |
| BR-EVAL-014 | MUST | v0.4 | EVAL-EVAL-001, -002, -010 | ADR-0012 / SPEC-07 |
| BR-EVAL-015 | SHOULD / DEFERRED | v0.4 | *(deferred)* | ADR-0012 / SPEC-07 |
| BR-EVAL-016 | MUST | v0.4 | EVAL-EVAL-004 | ADR-0012, ADR-0007 / SPEC-07 |
| BR-EVAL-017 | MUST | v0.4 | EVAL-EVAL-012 | ADR-0012, ADR-0006 / SPEC-07 |
| BR-EVAL-018 | MUST | v0.4 | EVAL-EVAL-013 | ADR-0012 / SPEC-07 |
| BR-EVAL-019 | MUST | v0.4 | EVAL-EVAL-005, -004 | ADR-0012 / SPEC-07, BR-REG |
| BR-EVAL-020 | MUST | v0.4 | EVAL-EVAL-008, -014 | ADR-0012 / SPEC-07 |
