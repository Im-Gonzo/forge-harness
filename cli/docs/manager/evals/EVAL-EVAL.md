# EVAL-EVAL — Eval-of-Harness & Health acceptance specs

> **META cases.** These verify the eval-of-harness *machinery itself* — the two-tier gate, the catch/FP
> metrics, honest non-scores, computed staleness, the append-only ledger, the grader ladder — **plus the
> spec of the harness golden sets** (planted-defect + clean fixtures, `EXPECTED.json`, skill discipline
> cases). They are **RED today** (`evals/README.md`): nothing under `forge/evals/harness/` exists yet. Each
> turns GREEN only when the slice that makes it pass lands. Behavioral cases run each trial in a throwaway
> `git worktree` cut from the pinned baseline, the edited artifact prompt overlaid on stable fixtures
> (`skills/run-eval` Phase 2). Verifies → BR-EVAL-001..020; decided by ADR-0012; detailed in SPEC-07.

---

### EVAL-EVAL-001 — planted SSRF is caught HIGH at the cited line (code-graded)

- **Verifies:** BR-EVAL-004, BR-EVAL-006, BR-EVAL-014
- **Kind:** capability
- **Grader:** code
- **Target:** catch^5 = 1.00
- **Given / When / Then:** GIVEN `fixtures/security-reviewer/ssrf-metadata-fetch/code/app.py` with a planted
  SSRF at line 42 (an unauthenticated handler `requests.get`s a user-controlled `?next=` URL with no
  allowlist, reachable to `169.254.169.254`) and an `EXPECTED.json` defect `{class:SSRF, line:42,
  min_severity:HIGH, match.any_of:[SSRF, "server-side request forgery", "169.254.169.254"]}`; WHEN
  `security-reviewer` reviews it across k=5 isolated worktree trials; THEN every trial flags a finding citing
  **line 42** at **≥ HIGH** naming the defect via the closed phrase set. The code grader (no model call)
  computes `catch_rate = 1.0`, `catch^5 = 1.0`. A run that misses it, cites the wrong line, or under-rates it
  to MEDIUM FAILS.
- **Fixture:** `fixtures/security-reviewer/ssrf-metadata-fetch/{code/app.py, EXPECTED.json}` + the
  `ssrf-metadata-fetch.case.md` definition.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-002 — clean-but-suspicious code yields zero false positives (code-graded)

- **Verifies:** BR-EVAL-005, BR-EVAL-006, BR-EVAL-014
- **Kind:** capability
- **Grader:** code
- **Target:** clean^5 = 1.00
- **Given / When / Then:** GIVEN a clean fixture for `security-reviewer` harvested from its own "common false
  positives — do NOT report" list — MD5 used as a cache key (not a password), the only outbound fetch behind
  an allowlist, a public Stripe `pk_` key, an already-parameterized ORM call — with `EXPECTED.json` listing
  these as `clean_traps[]` and an empty `defects[]`; WHEN `security-reviewer` reviews it across k=5 trials;
  THEN every trial returns **zero findings** on the clean traps (`fp_rate = 0.0`, `clean^5 = 1.0`). Any
  finding on a `clean_trap` FAILS. This operationalizes "a clean review is a valid review" as a measured
  number.
- **Fixture:** `fixtures/security-reviewer/clean-resembles-defect/{code/, EXPECTED.json}`.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-003 — `plan-orchestrate` under-classification of a T2 step fails the whole case

- **Verifies:** BR-EVAL-007
- **Kind:** capability
- **Grader:** code
- **Target:** n/a (∞-weighted SAFETY gate — any single under-classification fails)
- **Given / When / Then:** GIVEN a labelset of plan steps with ground-truth tiers, including a step that
  touches `auth.ts` (true tier **T2**); WHEN `plan-orchestrate` classifies the steps; THEN labeling that step
  **T0/T1** (dropping the human-apply gate / mandatory reviewer) **FAILS the entire case on that single
  instance**, even if every other label is correct. Labeling a read-only step T2 (over-classification) PASSES
  — the asymmetry is the safety rule ("the higher tier wins; a plan can never lower a step's tier"). Graded by
  comparing emitted tiers to the labelset with under-classification weighted ∞.
- **Fixture:** `fixtures/plan-orchestrate/tier-labelset/{plan.md, LABELS.json}`.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-004 — editing a reviewer makes it compute STALE, and a catch^k drop is REGRESSED (advisory)

- **Verifies:** BR-EVAL-013, BR-EVAL-016, BR-EVAL-019
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k = 1.00
- **Given / When / Then:** GIVEN a GREEN reviewer with `eval.graded_against_hash == registry.contentHash`;
  WHEN its prompt is edited so `contentHash != graded_against_hash`; THEN on the next read its status
  **computes** to `STALE` with **no write** to any staleness field (`BR-EVAL-013`); AND re-evaling it in a
  worktree (edited prompt over stable fixtures) where `catch^k` drops below the last-green baseline sets
  status `REGRESSED` and emits a finding at level **`WARN`** (not blocking, `ADR-0007`), reading/writing only
  `artifacts[uid].eval{}` in the registry.
- **Fixture:** a baseline-green reviewer + a planted-defect case + a prompt edit that lowers catch.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-005 — `U` is rendered `—`, never 0 or 1; coverage % is reported

- **Verifies:** BR-EVAL-010, BR-EVAL-012, BR-EVAL-019
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k = 1.00
- **Given / When / Then:** GIVEN a registry of N artifacts of which M have a golden set; WHEN
  `forge eval-harness --report` runs; THEN each artifact with no case reports `grade:"U"`,
  `status:"UNEVALUATED"`, `health:null`, rendered `"—"` in the dashboard and `forge status`; asserting the
  value is **neither `0` nor `1`** anywhere in `eval{}`; AND coverage is reported as `M/N` as a loud top-line
  metric with `U` artifacts excluded from the health aggregate.
- **Fixture:** a registry with a mix of evaluated and unevaluated artifacts.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-006 — Tier S gates Tier B: a prose regression yields BLOCKED_BY_STATIC, no score

- **Verifies:** BR-EVAL-001, BR-EVAL-002
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k = 1.00
- **Given / When / Then:** GIVEN a reviewer whose Tier-S meta-test is RED (its Pre-Report Gate clause deleted,
  so `tests/meta/reviewer-anti-noise.mjs` fails) but whose fixture *would* let it catch the planted defect;
  WHEN `forge eval-harness <uid>` runs with CI order `lint → meta → harness-eval`; THEN Tier B is **not run**
  for that artifact, its status is `BLOCKED_BY_STATIC`, and it carries **no** `catch_rate`/numeric metrics; AND
  a Tier-B pass on the same artifact (if forced) does **not** override the Tier-S FAIL — ship-readiness is
  `false`.
- **Fixture:** a reviewer with a deleted governance clause + an otherwise-catchable planted-defect fixture.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-007 — Tier-B trials are isolated in throwaway worktrees over stable fixtures

- **Verifies:** BR-EVAL-003
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k = 1.00
- **Given / When / Then:** GIVEN a behavioral case at k=2; WHEN it runs; THEN each trial executes in its own
  `git worktree` cut from the pinned baseline with the edited prompt overlaid on the stable committed
  fixtures, the base repo is left byte-identical (no residue), and each worktree is removed after its trial.
  A run that executes in the live working tree, or lets one trial's writes reach the next, FAILS.
- **Fixture:** any planted-defect case + a clean base repo to assert no residue.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-008 — `load-bundle` COLD-discipline: code floor under a model judge

- **Verifies:** BR-EVAL-008, BR-EVAL-020
- **Kind:** capability
- **Grader:** model (with a deterministic code floor)
- **Target:** pass@5 ≥ 0.90 (model leg) AND pass^k = 1.00 (code floor)
- **Given / When / Then:** GIVEN a slice transcript for `load-bundle`; WHEN the case grades COLD discipline;
  THEN a **code floor** greps the transcript for whole-spec/ADR pre-loads the bundle merely points at and
  **FAILS deterministically** on any such pre-load *regardless of the model verdict*; a **model judge** (built
  via `eval-judge`) scores the residual judgment with reasoning. A transcript that pre-loads a whole spec
  FAILS even if the judge would pass it; the model judge is never the sole grader.
- **Fixture:** two `load-bundle` transcripts (one COLD-clean, one with a whole-file pre-load).
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-009 — `dual-review` independence: two distinct sub-agents, no cross-feeding (code-graded)

- **Verifies:** BR-EVAL-009
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k = 1.00
- **Given / When / Then:** GIVEN a `dual-review` run; WHEN the case inspects how it executed; THEN exactly two
  **distinct** reviewer sub-agents were spawned and neither received the other's assessment as input
  (no cross-feeding). A run that spawns one sub-agent, uses inline "now act as reviewer 2", or feeds
  reviewer-1's verdict into reviewer-2's prompt FAILS. Graded mechanically on spawn-count + input isolation.
- **Fixture:** a `dual-review` invocation trace (one correct, one with context bleed).
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-010 — catch^k / clean^k are exact deterministic functions of the trial verdicts

- **Verifies:** BR-EVAL-006, BR-EVAL-014
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k = 1.00
- **Given / When / Then:** GIVEN a vector of k per-trial PASS/FAIL verdicts; WHEN the harness computes
  metrics; THEN `catch@k` = (≥1 PASS), `catch^k` = (all PASS), `clean^k` = (all quiet), `catch_rate` and
  `fp_rate` are the exact ratios, computed identically on every run from the same vector (the grader's own
  `pass^k = 1.00`). No metric depends on a model judgment for reviewer cases.
- **Fixture:** synthetic trial-verdict vectors with known expected metrics.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-011 — an artifact cannot leave `U` without a test-first authored golden set

- **Verifies:** BR-EVAL-011
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k = 1.00
- **Given / When / Then:** GIVEN an artifact at status `UNEVALUATED` with no authored case; WHEN a scored
  status is requested for it; THEN the request is **rejected** and the artifact **stays `U`** — a score
  requires an authored case that was red on the pre-feature tree first (`author-eval` discipline). A run that
  promotes an artifact out of `U` with no golden set FAILS.
- **Fixture:** an artifact with no case + an attempt to score it.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-012 — re-eval of a changed artifact emits version_bump_required as a WARN, not a block

- **Verifies:** BR-EVAL-017
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k = 1.00
- **Given / When / Then:** GIVEN a STALE artifact (changed `contentHash`) re-eval'd with no accompanying
  version bump; WHEN `forge eval-harness <uid>` runs; THEN the eval payload sets
  `version_bump_required: true` and emits a finding at level **`WARN`** (advisory, `ADR-0007`), and the run
  does **not** block the commit/CI. The mirror direction (hash-change-without-bump → registry WARN) is owned
  `see BR-VER`; this case asserts the eval-side WARN only.
- **Fixture:** a STALE artifact + a re-eval invocation with no bump.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-013 — the ledger is append-only; baselines and dashboard are derived

- **Verifies:** BR-EVAL-018
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k = 1.00
- **Given / When / Then:** GIVEN an empty `results/`; WHEN two `forge eval-harness` runs execute; THEN
  `ledger.jsonl` has two appended lines, the **first line is byte-unchanged** after the second run (no
  overwrite), and `baselines.json` (last-green index) + `dashboard.md` (snapshot) regenerate **purely from**
  the ledger. A run that mutates a prior ledger line, or hand-edits a derived view as truth, FAILS.
- **Fixture:** an empty `forge/evals/harness/results/` + two successive runs.
- **Phase:** v0.4
- **Status:** GREEN

### EVAL-EVAL-014 — judge_cal: a model judge with pass^k < 1.00 is pulled from the gate

- **Verifies:** BR-EVAL-020
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k = 1.00
- **Given / When / Then:** GIVEN a model judge with a calibration set; WHEN its own `pass^k` (`judge_cal`) is
  measured; THEN a judge scoring `pass^k < 1.00` on its calibration set is **excluded from gating** (its
  cases fall back to the code floor or block), and only a judge at `judge_cal = 1.00` may gate. A flaky judge
  left in the gate FAILS the case.
- **Fixture:** a stable judge + a deliberately-flaky judge, each with a calibration set.
- **Phase:** v0.4
- **Status:** GREEN

---

## Coverage map (MUST BR → case)

| MUST BR | Case(s) |
|---|---|
| BR-EVAL-001 | EVAL-EVAL-006 |
| BR-EVAL-002 | EVAL-EVAL-006 |
| BR-EVAL-003 | EVAL-EVAL-007 |
| BR-EVAL-004 | EVAL-EVAL-001 |
| BR-EVAL-005 | EVAL-EVAL-002 |
| BR-EVAL-006 | EVAL-EVAL-001, -002, -010 |
| BR-EVAL-007 | EVAL-EVAL-003 |
| BR-EVAL-008 | EVAL-EVAL-008 |
| BR-EVAL-009 | EVAL-EVAL-009 |
| BR-EVAL-010 | EVAL-EVAL-005 |
| BR-EVAL-011 | EVAL-EVAL-011 |
| BR-EVAL-012 | EVAL-EVAL-005 |
| BR-EVAL-013 | EVAL-EVAL-004 |
| BR-EVAL-014 | EVAL-EVAL-001, -002, -010 |
| BR-EVAL-016 | EVAL-EVAL-004 |
| BR-EVAL-017 | EVAL-EVAL-012 |
| BR-EVAL-018 | EVAL-EVAL-013 |
| BR-EVAL-019 | EVAL-EVAL-004, -005 |
| BR-EVAL-020 | EVAL-EVAL-008, -014 |

> **BR-EVAL-015** (health GPA) is **SHOULD / DEFERRED** — it has no MUST case in v0.4 by design
> (`ideas/01-proportionality.md`: drop the A–F GPA). A future case would assert `health(noisy) < health(quiet)`
> for two reviewers with equal `catch^k` and different `clean^k`.
