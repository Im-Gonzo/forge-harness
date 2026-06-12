# EVAL-EFF — Efficiency & Optimization acceptance specs

> RED-first (`evals/README.md`): every case below fails on today's tree (nothing is built) and turns GREEN
> only when the corresponding slice ships. STATIC cases (EVAL-EFF-001..009) are v0.3; DYNAMIC/value-density
> cases (EVAL-EFF-010..013) are v0.6 (DEFERRED). All structural checks are **code**-graded at `pass^k=1.00`
> (deterministic). The one model-graded case is paired with a deterministic floor.
>
> The load-bearing case is **EVAL-EFF-006** — the critical safety regression that a 0-fire `secret-scan`
> can never reach the prune-plan. It is code-graded `pass^k=1.00` and must hold for the life of the corpus.

---

### EVAL-EFF-001 — token estimator matches pinned fixtures and reads its constants from one place
- **Verifies:** BR-EFF-001
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a fixture set of artifacts with known char/word counts (a plain rule, a
  code-dense validator, a JSON manifest), When `analyze` estimates each, Then each `~N` equals the
  pre-computed expected value from `round(0.5*ceil(chars/4) + 0.5*ceil(words*1.33))` (×`1.15` for dense
  ones); AND mutating `CHARS_PER_TOKEN` or `CODE_DENSITY` in `analyze/constants.mjs` changes the output
  (proving the constants are read from one place, not inlined); AND every figure is rendered with a leading
  `~`.
- **Fixture:** `fixtures/eff/estimate/` — 3 artifacts + an `expected.json` of pinned `~N` values.
- **Phase:** v0.3
- **Status:** GREEN

---

### EVAL-EFF-002 — artifacts are placed in the correct residency class (hook ≠ its .mjs size; validator = 0)
- **Verifies:** BR-EFF-002
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a fixture harness with an always-on rule (no `paths:`), a path-scoped rule
  (`paths:` present), an agent, a validator, and a hook with a `permissionDecisionReason` literal, When
  `analyze` classifies them, Then the no-`paths:` rule is `always-on` and the path-scoped rule is
  `conditional`; AND the validator's `estTokens == 0` (`on-demand`); AND the hook's cost equals
  `description + estimated(injection-literal)`, which is strictly less than `estimate(whole .mjs source)`
  (the source is never counted).
- **Fixture:** `fixtures/eff/residency/` mirroring `rules/`, `hooks/`, a validator, an agent.
- **Phase:** v0.3
- **Status:** GREEN

---

### EVAL-EFF-003 — always-on total is an itemized sum and per-profile budget uses `resolveModules`
- **Verifies:** BR-EFF-003
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given the seed manifests, When `analyze` runs, Then `alwaysOnTotal` equals the
  exact sum of the itemized ALWAYS-ON list (no hard-coded constant; removing one always-on item lowers the
  total by that item's estimate); AND `perProfile[generic].alwaysOn`/`conditionalCeiling` are computed by
  resolving `generic` through the same `resolveModules` the composer uses, so a `moduleSelectionRules` delta
  that adds a module is reflected in the profile's budget.
- **Fixture:** seed `manifests/` + a variant profile that triggers a `moduleSelectionRules.add`.
- **Phase:** v0.3
- **Status:** GREEN

---

### EVAL-EFF-004 — static dead-detection reports D1–D4 with their check-ids
- **Verifies:** BR-EFF-004
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a fixture harness with a planted orphan module (in zero profiles, not
  `always:true`), a planted orphan component (in no module), a planted orphan file on disk, and a planted
  dangling ref (module names a component with no backing file), When `analyze` runs, Then D1, D2, D3, and
  D4 are each reported against the correct artifact with their `check-id`; AND D4 cites the dependency-graph
  resolution (see BR-DEP / SPEC-03) rather than re-deriving it.
- **Fixture:** `fixtures/eff/dead-static/` with one planted instance of each of D1–D4.
- **Phase:** v0.3
- **Status:** GREEN

---

### EVAL-EFF-005 — D5 detects a vacuous path-scoped rule in a `--project`
- **Verifies:** BR-EFF-004
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a pure-Python `--project` fixture (no `.tsx`/`.ts` files) into which a
  harness carrying `react-patterns` (`paths: **/*.tsx`) is installed, When `analyze --project <pyproj>`
  runs, Then `react-patterns` is reported as a **D5 vacuous path-scoped rule** ("globs matched 0 files");
  AND running the same analyze on a project that *does* contain `.tsx` files does NOT flag it (the rule is
  inert only *here*, not everywhere).
- **Fixture:** `fixtures/eff/d5/python-only/` and `fixtures/eff/d5/has-tsx/`.
- **Phase:** v0.3
- **Status:** GREEN

---

### EVAL-EFF-006 — CRITICAL REGRESSION: a 0-fire `secret-scan` never reaches the prune-plan
- **Verifies:** BR-EFF-006, BR-EFF-007, BR-EFF-012
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given the seed harness with telemetry showing `secret-scan` fired **0 times**
  over an *adequate* window (`sessions=50`, `windowDays=30` — so the adequacy gate would NOT shield it),
  When `analyze` and `optimize --emit-plan` run, Then `secret-scan` (criticality `safety`) appears in
  **NO** dead/waste/prune section and in **NO** `optimize.plan.json` recommendation; AND it appears ONLY
  under "low-activity safety (expected)" with the success framing ("0 fires = no secrets leaked"); AND the
  same holds for `block-no-verify`, `config-protection`, `prompt-defense-baseline`, `security-baseline`.
  The grader asserts on the structured plan, so the lock is checked at the data layer, not in prose.
- **Fixture:** `fixtures/eff/safety-lock/` — seed `criticality.json` + a synthetic 0-fire telemetry window.
- **Phase:** v0.3 (lock); plan-exclusion re-asserted in v0.6
- **Status:** GREEN

---

### EVAL-EFF-007 — thin window downgrades a never-fired `normal` artifact to `watch`, not `prune`
- **Verifies:** BR-EFF-008
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a `normal` artifact that never fired across a telemetry window with
  `sessions=3` (< MIN_SESSIONS=20), When `analyze` runs, Then the artifact's dynamic-dead verdict is
  `watch`, NOT `prune`; AND a planted static orphan (D2) in the same run IS still recommended (static
  checks are exempt from the adequacy gate); AND raising the fixture to `sessions=50` flips the same
  artifact's verdict to a `prune`-eligible dynamic-dead.
- **Fixture:** `fixtures/eff/adequacy/` — telemetry windows at `sessions=3` and `sessions=50`.
- **Phase:** v0.3
- **Status:** GREEN

---

### EVAL-EFF-008 — unknown effectiveness routes to needs-eval (`U` ≠ 0), never prune
- **Verifies:** BR-EFF-011
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a `normal` artifact with grade `U` / coverage `0` (no golden set, see
  BR-EVAL) and a high estimated `costTok`, When value-density is computed, Then its `value-density` is
  `null` (NOT `0`), it routes to `needs-eval`, and it is NOT a `prune-candidate`; AND an otherwise-identical
  artifact with a real low `effScore` IS a `prune-candidate` (proving `U` is treated as unknown, not as the
  worst score).
- **Fixture:** `fixtures/eff/value-density/` — one grade-`U` artifact, one low-`effScore` artifact.
- **Phase:** v0.6 (DEFERRED)
- **Status:** RED (deferred)

---

### EVAL-EFF-009 — `analyze` degrades to static-only when telemetry is off/empty
- **Verifies:** BR-EFF-005
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given telemetry disabled (or an empty window), When `analyze` runs, Then it
  returns D1–D5 results AND a clear "dynamic checks unavailable (telemetry off)" notice; AND it emits NO
  `U1`–`U4` verdicts (an empty `deadDynamic` is accompanied by `telemetry.available:false`, so absence is
  never presented as "everything is alive"); AND it exits successfully (fail-open, never blocks).
- **Fixture:** `fixtures/eff/no-telemetry/` — a harness with telemetry off.
- **Phase:** v0.3
- **Status:** GREEN

---

### EVAL-EFF-010 — dynamic dead-detection (U1) flags a reachable-but-never-fired `normal` artifact
- **Verifies:** BR-EFF-009
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given an adequate telemetry window (`sessions=50`, `windowDays=30`) in which a
  composed, reachable `normal` rule has `0` cite events, When `analyze` runs, Then that rule is reported as
  `U1 never-fired`; AND a `safety` artifact in the identical 0-event state is NOT reported as `U1` (the lock
  holds inside the dynamic path); AND a `normal` artifact WITH cite events is not flagged.
- **Fixture:** `fixtures/eff/dynamic-dead/` — adequate window, one never-cited normal rule, one never-fired
  safety hook, one active rule.
- **Phase:** v0.6 (DEFERRED)
- **Status:** RED (deferred)

---

### EVAL-EFF-011 — redundancy flags near-duplicates but de-flags intentional floor/ceiling layering
- **Verifies:** BR-EFF-010
- **Kind:** capability
- **Grader:** code (Jaccard is deterministic); **model** floor for the layering-intent hint
- **Target:** pass^k=1.00 (overlap math) / pass@3>=0.90 (layering hint)
- **Given / When / Then:** Given two near-duplicate rule bodies (shingle `J ≥ 0.6`) and the real
  `security-baseline` / `common/security` pair (which declares itself the deliberate ceiling/floor), When
  redundancy runs, Then the near-duplicate pair is flagged `strong` (body `k=5`, `J ≥ 0.6`); AND the
  `security-baseline`/`common/security` pair carries the **layering de-flag hint** and is NOT presented as a
  prune-worthy redundancy. The Jaccard thresholds are code-graded; the "is this intentional layering" hint
  has a model floor.
- **Fixture:** `fixtures/eff/redundancy/` — a planted near-duplicate pair + the seed layering pair.
- **Phase:** v0.6 (DEFERRED)
- **Status:** RED (deferred)

---

### EVAL-EFF-012 — value-density quadrants classify keeper / prune-candidate, safety forced keeper
- **Verifies:** BR-EFF-011
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given artifacts with known `effScore` (see BR-EVAL) and estimated `costTok`,
  When value-density (`effScore / costTok`) is computed, Then a high-eff / low-cost artifact is `keeper`,
  a low-eff / high-cost `normal` artifact is `prune-candidate`, and a `safety` artifact with a poor ratio
  is STILL a forced `keeper` (criticality overrides the quadrant); AND the report labels value-density
  `low-confidence`.
- **Fixture:** `fixtures/eff/quadrants/` — one artifact per quadrant + a poor-ratio safety artifact.
- **Phase:** v0.6 (DEFERRED)
- **Status:** RED (deferred)

---

### EVAL-EFF-013 — `forge optimize` is a dry-run plan that writes nothing but `optimize.plan.json`
- **Verifies:** BR-EFF-012
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a harness with at least one genuine `normal` prune-candidate, When
  `forge optimize --emit-plan` runs, Then NO artifact files are deleted or modified on disk (additive-never-
  destructive); the ONLY write is `optimize.plan.json`; each recommendation carries
  `{check-id, confidence, recoverableTokens, evidence, safetyLocked:false}`; AND every `safety`/`compliance`
  artifact appears ONLY in the non-actionable "considered & excluded" section (`safetyLocked:true`) and in
  NO recommendation.
- **Fixture:** `fixtures/eff/optimize/` — a normal prune-candidate + the seed safety artifacts.
- **Phase:** v0.6 (DEFERRED)
- **Status:** RED (deferred)

---

## Coverage check (every MUST BR has a case)

| BR | Priority | Phase | Case(s) |
|---|---|---|---|
| BR-EFF-001 | MUST | v0.3 | EVAL-EFF-001 |
| BR-EFF-002 | MUST | v0.3 | EVAL-EFF-002 |
| BR-EFF-003 | MUST | v0.3 | EVAL-EFF-003 |
| BR-EFF-004 | MUST | v0.3 | EVAL-EFF-004, EVAL-EFF-005 |
| BR-EFF-005 | MUST | v0.3 | EVAL-EFF-009 |
| BR-EFF-006 | MUST | v0.3 | EVAL-EFF-006 |
| BR-EFF-007 | MUST | v0.3 | EVAL-EFF-006 |
| BR-EFF-008 | MUST | v0.3 | EVAL-EFF-007 |
| BR-EFF-009 | SHOULD | v0.6 | EVAL-EFF-010 |
| BR-EFF-010 | MAY | v0.6 | EVAL-EFF-011 |
| BR-EFF-011 | SHOULD | v0.6 | EVAL-EFF-008, EVAL-EFF-012 |
| BR-EFF-012 | SHOULD | v0.6 | EVAL-EFF-013, EVAL-EFF-006 |

**v0.3 gate (MUST GREEN to ship the static half):** EVAL-EFF-001..007 + EVAL-EFF-009 — with EVAL-EFF-006 as
the non-negotiable safety regression.
