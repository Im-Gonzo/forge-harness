# SPEC-07 — Eval-of-Harness & Health

Status: design-stage (RED — nothing implemented) · Phase: v0.4 · Implements: BR-EVAL-001..020 ·
Decided-by: ADR-0012 (two-tier), ADR-0005/0006 (identity/versioning), ADR-0007 (advisory gates),
ADR-0008 (scan-on-demand), ADR-0014 (forge-validates-forge)

## Summary

This dimension turns forge's EDD onto its own agents and skills. Forge already validates itself with
**static prose meta-tests** (`tests/meta/*.mjs`) — *Tier S* — which prove an artifact is still *shaped*
right (governance prose present, reviewers read-only). It cannot prove an artifact still *works*: a
`security-reviewer` with every required phrase intact can silently stop catching a planted SSRF. This spec
adds *Tier B* — **behavioral evals** under `forge/evals/harness/` — that measure whether each artifact
actually does its job, and binds the two tiers with one rule (`ADR-0012`): **Tier S is a precondition for
Tier B**; a Tier-B run on a Tier-S-failing artifact is void (`BLOCKED_BY_STATIC`, no score), and a Tier-B
pass never excuses a Tier-S fail.

The **kept core** (per `ideas/01-proportionality.md`) is **pass/fail catch-rate + false-positive-rate**
measurement on two mandatory case classes per reviewer: a **planted-defect** case (true positives) and a
**clean** case (false positives — "a clean review is a valid review", made a number). The **A–F health GPA
is specified but DEFERRED** — it ships dark in v0.4 and gates nothing. Unevaluated artifacts are `U` (`"—"`,
never 0/1); coverage % is loud; staleness is *computed* from `contentHash` drift, never stored; regression
is *advisory* in v0.4.

## Design

### Two-tier model (ADR-0012)

| Tier | What | Answers | Where | Status |
|---|---|---|---|---|
| **S — static prose** | meta-tests grepping governance prose & frontmatter | "still shaped right?" | `tests/meta/*.mjs` | EXISTS |
| **B — behavioral** | evals running the artifact against fixtures | "does it DO its job?" | `forge/evals/harness/` | NEW |

The precondition is mechanical, not advisory: **CI order is fixed `lint → meta (Tier S) → harness-eval
(Tier B)`**, and Tier B is skipped for any artifact whose Tier S is RED, so its status computes to
`BLOCKED_BY_STATIC` rather than being measured (`BR-EVAL-001`, `-002`). Both tiers green (or honest `U`) is
required to ship.

### Golden-set layout (`forge/evals/harness/`)

```text
forge/evals/harness/
  manifest.json                     # maps each case → its artifact-under-test (AUT) + aut_hash
  cases/<aut>/<case>.case.md        # case definition (frontmatter schema below)
  fixtures/<aut>/<case>/
    code/                           # the production-shaped fixture tree under review
    EXPECTED.json                   # ground-truth defect manifest (below)
  results/
    ledger.jsonl                    # APPEND-ONLY: one line per artifact×run (source of truth)
    baselines.json                  # DERIVED: last-green index per artifact
    dashboard.md                    # DERIVED: health snapshot, sparklines, coverage %
```

`cases/` and `fixtures/` are keyed by `<aut>` (e.g. `security-reviewer`) so a reviewer's whole golden set is
one directory. `results/` is three files: one append-only truth log and two regenerated views (`BR-EVAL-018`).

### The two mandatory reviewer case classes

- **planted-defect** (`BR-EVAL-004`) — a fixture with a known defect at a known `file:line`. PASSES iff the
  reviewer flags it at ≥ `min_severity` **citing the planted line**. Measures `catch_rate`.
- **clean** (`BR-EVAL-005`) — production-shaped *correct* code that *resembles* a defect (allowlisted fetch,
  MD5-as-checksum, parameterized ORM call, public `pk_` key). PASSES iff **zero findings** on the clean
  lines/traps. Measures `fp_rate`. Traps are harvested from the reviewer's own
  *"common false positives — do NOT report"* list, so the case is self-consistent with the prompt.

Skill cases (`BR-EVAL-007..009`): `plan-orchestrate` tier-classification accuracy on a labelset
(under-classification of a true-T2 step = ∞-weighted SAFETY fail, any single one fails the case;
over-classification tolerated); `load-bundle` COLD-discipline (code floor grepping the transcript for
whole-file pre-loads + a paired model judge); `dual-review` independence (code: two distinct sub-agents
spawned, no cross-feeding).

### Metrics & the deferred health composite

Per evaluated artifact, from k pass/fail trials (reviewer default **k = 5**, `BR-EVAL-014`):

```
catch_rate = planted-defects-found / planted
fp_rate    = clean-traps-flagged  / clean
precision  = TP / (TP + FP)
catch@k    = ≥1 of k trials caught the defect
catch^k    = all k trials caught   (the stability bar)
clean^k    = all k trials stayed quiet
```

**Health composite (DEFERRED, `BR-EVAL-015`):**
`health = 0.55·catch^k + 0.45·clean^k − 0.50·(1 − clean^k)` → A–F + U. The false-positive penalty (`−0.50`)
is steeper than the `clean^k` reward (`0.45`), so a noisy reviewer scores **below** a slightly-less-catchy
quiet one — forge's anti-noise ethic, encoded. **This ships dark in v0.4** and gates nothing; the kept core
is the pass/fail catch + FP numbers.

### Honesty: `U`, coverage, STALE

- `U`/`UNEVALUATED` renders `"—"`, **never 0 or 1** (`BR-EVAL-010`); new artifacts ship `U`; an artifact
  cannot leave `U` without a test-first authored golden set (`BR-EVAL-011`, the `author-eval` discipline).
- **Coverage %** = artifacts-with-a-golden-set ÷ all registry artifacts, a loud top-line metric;
  `U` counts against *coverage*, not health (`BR-EVAL-012`).
- **STALE is computed**, not stored: `status == STALE` iff registry `contentHash` (`see BR-REG` / `ADR-0005`)
  ≠ the eval's `graded_against_hash` (`BR-EVAL-013`). Deriving it on read keeps it correct under the
  live-symlink seam (`ADR-0008`).

### Regression & trend (advisory in v0.4)

Edit → `contentHash` drift → `STALE` → re-eval in a throwaway worktree cut from the pinned baseline, the
**edited prompt overlaid on the STABLE committed fixtures** (reuse `skills/run-eval`, `BR-EVAL-003`). If
`catch^k` *or* `clean^k` drops below the last-green baseline ⇒ `REGRESSED`. In v0.4 `REGRESSED` is an
**advisory `WARN`** (`ADR-0007`), promotable to blocking later (`BR-EVAL-016`). Mutually-enforcing contract
with versioning (`BR-EVAL-017`): hash-change-without-bump is a registry WARN (`see BR-VER`);
bump-without-re-eval is an eval WARN; the eval payload emits `version_bump_required`.

### Grader ladder

`code > model > human` (`evals/README.md`). All reviewer catch/FP cases are **code-graded** off
`EXPECTED.json` — no model call. Model judges appear only where a script cannot decide (COLD discipline),
always under a deterministic floor; a model judge is built via `bundles/eval-judge.md`, its own `pass^k`
(`judge_cal`) is measured, and a judge with `pass^k < 1.00` is pulled from the gate (`BR-EVAL-020`).

## Data structures

### Case frontmatter (extends `author-eval`'s schema)

```yaml
---
id: ssrf-metadata-fetch            # slug, unique within cases/<aut>/
kind: capability                   # capability | regression
grader: code                       # code | model | human
k: 5                               # trials per run (reviewer default 5)
target: "catch^5=1.00"             # ^k for must-always-hold; @k for capability
# --- harness extensions ---
aut: security-reviewer             # artifact-under-test id
aut_kind: agent                    # agent | skill
case_class: planted-defect         # planted-defect | clean | classification | discipline
aut_hash: "sha256:…"               # registry contentHash pinned at authoring (see BR-REG)
fixture: fixtures/security-reviewer/ssrf-metadata-fetch
expected:
  must_flag: SSRF                  # closed phrase set, mirrors EXPECTED.json match.any_of
  must_flag_line: 42
  min_severity: HIGH
  must_not_flag: []                # clean traps the reviewer must stay silent on
refs: ["BR-EVAL-004", "BR-EVAL-006"]
---
```

### `EXPECTED.json` (ground-truth defect manifest, `BR-EVAL-006`)

```json
{
  "defects": [
    { "id": "ssrf-1", "class": "SSRF", "file": "app.py", "line": 42,
      "min_severity": "HIGH", "match": { "any_of": ["SSRF", "server-side request forgery", "169.254.169.254"] } }
  ],
  "clean_lines": [17, 18],
  "clean_traps": [
    { "file": "util.py", "line": 88, "reason": "MD5 used as a cache key, not for passwords" }
  ]
}
```

A code grader counts a true positive iff a finding cites a line in the defect's range, names it via the
**closed** `match.any_of[]`, and meets `min_severity`; a finding on any `clean_line`/`clean_trap` is a false
positive. No model judgment decides TP/FP for reviewer cases.

### Eval-linkage payload (stored in the REGISTRY, storage `see BR-REG`)

```json
"artifacts": {
  "agent:security-reviewer": {
    "eval": {
      "health": null,                       // null while the GPA is deferred (BR-EVAL-015)
      "grade": "U",                         // A–F | U ; "—" when U
      "status": "GREEN",                    // GREEN|REGRESSED|STALE|UNEVALUATED|BLOCKED_BY_STATIC
      "k": 5,
      "metrics": { "catch_rate": 1.0, "fp_rate": 0.0, "catch_pow_k": 1.0, "clean_pow_k": 1.0 },
      "graded_against_hash": "sha256:…",    // STALE iff != registry contentHash
      "baseline": "sha256:…",               // last-green hash
      "last_run": "2026-06-05T00:00:00Z",
      "trend": [1.0, 1.0, 0.8],             // recent catch^k history for the sparkline
      "ledger_ref": "results/ledger.jsonl#L42"
    }
  }
}
```

### `ledger.jsonl` line (append-only source of truth, `BR-EVAL-018`)

```json
{ "ts": "…", "uid": "agent:security-reviewer", "aut_hash": "sha256:…", "k": 5,
  "case_results": [ { "case": "ssrf-metadata-fetch", "verdict": "PASS", "trials": ["PASS","PASS","PASS","PASS","PASS"] } ],
  "metrics": { "catch_pow_k": 1.0, "clean_pow_k": 1.0 }, "status": "GREEN", "version_bump_required": false }
```

## CLI / interface

```text
forge eval-harness [<uid> | --changed | --all | --report]
  <uid>       eval one artifact (e.g. agent:security-reviewer)
  --changed   eval only artifacts whose contentHash drifted from graded_against_hash (STALE set)
  --all       eval the whole corpus (CI / cold start)
  --report    regenerate dashboard.md + print coverage % and the status table; runs nothing
```

`/harness-eval` is a **thin** slash command delegating to `forge eval-harness`. Output conforms to the
`--json` envelope `{forge, command, ok, ts, data, findings[], summary}` (C3); `REGRESSED` and
`version_bump_required` surface as `WARN` findings (C5). Dry-run by default; writes only the append to
`ledger.jsonl` and the regenerated derived views (C4). Coverage % and per-artifact status feed
`forge status` (`see BR-CLI`). The module is `forge/manager/eval-harness.mjs` with a paired
`lint/validate-eval-harness.mjs` (C4, ADR-0014).

## Edge cases & failure modes

- **Tier S RED.** Tier B is not run; status `BLOCKED_BY_STATIC`, no metrics. A behavioral pass cannot
  override it (`BR-EVAL-001`, `-002`).
- **No golden set.** Status `UNEVALUATED`, grade `U`, render `"—"`; counts against coverage, not health.
  Cannot be coerced to 0/1 (`BR-EVAL-010`).
- **Hash drift.** STALE is computed on read, not stored; correct regardless of how the edit arrived
  (`BR-EVAL-013`).
- **Flaky model judge.** `judge_cal < 1.00` ⇒ judge pulled from the gate; its cases fall back to the code
  floor or block (`BR-EVAL-020`).
- **Fail-open.** A harness-eval crash never blocks a commit or session (invariant 4); a failed run is a
  finding, not a hang.
- **Under-classification in `plan-orchestrate`.** One true-T2-step labeled lower fails the whole case
  (∞-weighted); over-classification does not (`BR-EVAL-007`).
- **Clean-trap regression.** A reviewer that starts flagging a clean trap drops `clean^k` → `REGRESSED`
  WARN, even with catch_rate unchanged (`BR-EVAL-016`).

## Open questions

- **Promotion to blocking.** When does `REGRESSED` graduate from WARN to a hard gate? (Deferred to a later
  phase per `ADR-0007`; needs accumulated ledger data to justify.)
- **Health GPA activation.** What evidence retires the DEFERRED status of the A–F composite? (Likely: a
  trial count and artifact count large enough that the grade stops being noise.)
- **k tuning.** Is k=5 right for skill discipline cases, or only reviewers? (Skills may want higher k for the
  model-graded legs.)
- **Fixture drift.** A clean fixture that itself becomes wrong (e.g. a dependency in it gains a real CVE)
  needs its own freshness signal — out of scope for v0.4.

## Traceability

- **BRs:** BR-EVAL-001..020 (this dimension). Kept-core MUSTs: -001..-014, -016..-020; deferred SHOULD: -015.
- **ADRs:** ADR-0012 (two-tier, the spine), ADR-0005/0006 (`contentHash`/versioning the staleness &
  regression couple to), ADR-0007 (advisory gates), ADR-0008 (scan-on-demand ⇒ computed STALE), ADR-0014
  (forge-validates-forge ⇒ Tier S is the existing instance).
- **Foreign BRs (by prefix):** registry/eval-payload storage + `contentHash` `see BR-REG`; version-bump gate
  `see BR-VER`; `forge status` consumer `see BR-CLI`; value-density consumer `see BR-EFF`.
- **EVALs:** EVAL-EVAL-001..014 (META cases verifying this machinery + the golden-set spec).
- **Reuses:** `skills/run-eval` (worktree isolation, `pass@k`/`pass^k`), `skills/author-eval` (test-first
  case schema), `bundles/eval-judge.md` (model-judge build + `judge_cal`), `tests/meta/*.mjs` (Tier S).
