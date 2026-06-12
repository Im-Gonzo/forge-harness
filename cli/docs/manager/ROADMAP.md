# Harness Manager — Roadmap

Phased, advisory-first, walking-skeleton-led. Each phase lists scope, the EVAL gate (the `MUST` cases
that must be GREEN to ship the phase), and the trigger that justifies starting it. Phasing is decided by
`ADR-0016`; proportionality by `ideas/01-proportionality.md`.

## v0.2 — Walking skeleton (Tier 1) — ✅ **SHIPPED** (2026-06-05)

The identity + visibility spine. No blocking gates. Built across 3 gated workflows (W1 RED spine → W2
registry+validators → W3 CLI integration); full v0.2 EVAL-REG/VER/INT/CLI suite GREEN (42/42), `forge
validate --strict` clean, `forge status` live. Two spec contradictions surfaced and resolved during the
build: (A) `-design` is stripped so the version triple is aligned (drift = core-version mismatch);
(B) registry staleness is split — structural change = ERROR, content-only change = advisory WARN.

**Scope**
- `--json` envelope at the parent runners (`lint/run-all.mjs`, `tests/run-meta.mjs`) — parse the existing
  `LEVEL path:line message` output into `findings[]`; **no child validator changes**. (`ADR-0004`)
- `forge/manager/lib/` foundation: `store.mjs` (atomic JSON/JSONL + the two storage roots), `findings.mjs`
  (parse + emit), `frontmatter.mjs` + `resolve-kind.mjs` (extracted from existing validators), `hash.mjs`.
- **Registry**: `forge registry build [--write] | ls | show <uid> | changed` → `forge/.forge/registry.json`
  + `registry.log.jsonl`. (`SPEC-01`, `BR-REG`)
- `lint/validate-registry.mjs` (advisory: stale registry, `VERSION` triple drift, hash/revision mismatch
  as `WARN`) and `lint/validate-manager-zerodep.mjs` — both auto-discovered. (`ADR-0014`, `BR-INT`)
- Marker gains `provenance.sourceRev` (written by `init`; not yet enforced). (`ADR-0009`, `SPEC-04`)
- **`forge status` skeleton**: registry panel live; fleet/telemetry/eval/efficiency panels stub `(no
  data — run X)`. (`SPEC-08`)

**Gate (MUST GREEN):** `EVAL-INT-001` (zero-dep), `EVAL-INT-002` (fail-open), `EVAL-CLI` json-envelope
cases, `EVAL-REG` build/ls/show/idempotence cases, `EVAL-VER` advisory-drift cases.

**Highest-leverage three:** (1) `--json` backbone, (2) registry + `validate-registry`, (3) `status` skeleton.

## v0.3 — Visibility (Tier 1 finish + Tier 2 cheap half) — ✅ **SHIPPED** (2026-06-06)

*Dependency graph caught the real `react-reviewer` dangling ref (since redirected). `analyze` reports
~10.3k always-on tokens. Fleet read-only opt-in.*

**Scope**
- **Dependency graph** with prose-ref resolution: `forge registry deps | rdeps | orphans | dangling`.
  Catches the real `react-reviewer` dangling reference. (`SPEC-03`, `BR-DEP`)
- **Context-budget report** (static): `forge analyze` — always-on / per-artifact / per-profile token
  estimates. No telemetry needed. (`SPEC-06` static half, `BR-EFF`)
- **Fleet read-only**: `forge fleet enable | status | scan | drift` using `sourceRev`. Opt-in, cache.
  (`SPEC-04`, `BR-FLEET`)

**Gate:** `EVAL-DEP` (dangling-ref + rdeps cases), `EVAL-EFF` static-budget cases, `EVAL-FLEET`
read/drift cases.
**Trigger:** you hit a dangling-ref bug, or context feels heavy, or manual project enumeration annoys you.

## v0.4 — Proving it works — ✅ **SHIPPED** (2026-06-06)

*Eval-of-harness Tier-B machinery + 2 real golden sets (coverage 2/2, grade U until a live reviewer run).
Telemetry opt-in/default-off, redacted, no-network — all 6 hooks re-verified to still enforce. Promotion
decision: gates stay ADVISORY (no accumulated data justifies blocking).*

**Scope**
- **Eval-of-harness (Tier B)** as pass/fail meta-tests: planted-defect + clean-code golden sets for the
  reviewer agents; `plan-orchestrate` tier-classification. Keep catch-rate / false-positive measurement;
  **the A–F GPA stays optional/deferred**. (`SPEC-07`, `BR-EVAL`, `ADR-0012`)
- **Telemetry** (opt-in, default off): `emit()` helper, ~12 hook decision-site emits, the
  `invoke-telemetry` `Task|Skill` hook, `forge stat | monitor | telemetry on|off|prune|wipe`. (`SPEC-05`,
  `BR-TEL`, `ADR-0011`)
- **Decision point:** if eval data proves a block is right, the version-bump and eval-regression gates
  *may* be promoted from advisory `WARN` to blocking — explicit, opt-in, never automatic. (`ADR-0007`)

**Gate:** `EVAL-EVAL` (catch-rate, false-positive, regression-detection cases), `EVAL-TEL` (redaction,
no-network, opt-in-default-off cases).
**Trigger:** you edit a reviewer and want proof it still works; or you genuinely can't tell what you use.

## v0.5 — Fleet write (Tier 3) — **DEFERRED** (proportionality decision, 2026-06-06)

**Scope**
- `forge fleet sync [--all|<id>] | relink | forget | prune | ignore | pin`: orchestrate the existing
  per-project `forge sync`; auto-upgrade unedited copies; **stage** 3-way merges for user-edited files to
  `.claude/.forge-merge/` (never clobber). (`SPEC-04`, `BR-FLEET`)

**Gate:** `EVAL-FLEET` sync/merge-staging/user-edits-sacred cases.
**Trigger:** enough tailored projects that bulk operations are genuinely painful by hand.

## v0.6 — Optimization & polish (Tier 3) — **DEFERRED** (proportionality decision, 2026-06-06)

**Scope**
- `VERSION` roll-up automation; `forge registry roll-up`. (`SPEC-02`, `BR-VER`)
- **Value-density** + redundancy + dead-artifact dynamic detection + `forge optimize` (dry-run
  prune-plan, criticality safety-lock). (`SPEC-06`, `BR-EFF`, `ADR-0013`)
- A/B artifact-variant comparison via `run-eval`.

**Gate:** `EVAL-EFF` value-density + safety-lock cases (incl. "a 0-fire `secret-scan` is never pruned").
**Trigger:** the harness is large enough that "is each artifact earning its keep" is a real question with
enough telemetry to answer it.

## Cross-phase definition-of-done

A phase is done when: (1) its `MUST` EVAL cases are GREEN; (2) `forge validate --strict` passes
(including the new self-validators); (3) `forge status` reflects the new dimension; (4) the relevant
SPEC's *Open questions* are resolved or explicitly carried forward; (5) docs (`ARCHITECTURE.md`,
this corpus) updated.
