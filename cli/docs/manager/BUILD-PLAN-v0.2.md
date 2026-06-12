# Build Plan — Harness Manager v0.2 (walking skeleton)

> The approved execution plan for implementing v0.2. Companion to `ROADMAP.md` (which defines the
> phases) — this file defines the **dispatch**: build slices, the 3-workflow decomposition, parallel-vs-
> sequential safety, risks, and the done-criteria. Status: **approved, in progress**.

## Pre-flight (done)

Writing this corpus made `validate-xref` fail on `docs/manager/` (it flagged planned-command references,
the *intentional* `react-reviewer` dangling-ref example, and adjacent-code-span false positives). Fixed
by **excluding `docs/manager/` from `validate-xref`** (a design-stage corpus references forward artifacts
by nature — consistent with the validator's existing "legitimate forward references" stance) plus a
reword of one false-positive line in `EVAL-EFF.md`. `forge validate` is green (11/11).

## Context

The spec corpus is complete (16 ADRs, 115 BRs, 10 specs, 99 RED eval cases, 0 dangling IDs); nothing is
implemented. v0.2 delivers the lean Tier-1 spine (`ideas/01-proportionality.md`): a generated
**registry** (the only live data source), the **`--json` backbone**, two self-validators, and a composed
**`forge status`** dashboard — **every gate advisory (WARN, never blocking)**, **zero change to existing
behavior**, built **eval-spec-first** (RED tests before implementation). Out of scope: v0.3+.

## Key decisions

1. **Dispatch by delegation, not async-main.** `bin/forge.mjs#main()` is sync; every case `process.exit()`s
   immediately. Add sync cases that `delegateInherit('manager/<noun>.mjs', rest)` (as `validate` already
   does). Each manager module is dual-mode: runnable script + `run()`/`summarize()` exports. Satisfies the
   "no manager import on doctor/init/sync hot path" evals (EVAL-CLI-006/EVAL-INT-010) by the process
   boundary. → small SPEC-00 amendment (dispatch mechanism only; C4 contract unchanged).
2. **`--json` at the parent runner, parsing BOTH streams.** Findings → stderr, `… PASS/FAIL` → stdout, so
   the parser in `run-all.mjs`/`run-meta.mjs` reads both. No child validator touched (ADR-0004).
3. **Extract for new code; do not rewire existing validators.** New `manager/lib/frontmatter.mjs` +
   `resolve-kind.mjs` (copying `componentCandidates`/`loadDeclaredHookIds` from `validate-manifests.mjs`);
   the 3 divergent existing frontmatter parsers stay untouched (v0.3 cleanup). (R2)
4. **`registry changed --since` is snapshot-vs-current** (forge is not a git repo); `git init` is an
   optional later unlock.
5. **Node v22.16, zero deps** → executable evals use built-in `node:test`/`node:assert`, under
   `tests/manager/` with fixtures in `tests/manager/fixtures/`.

## Build slices & DAG

```
S0 schemas + manager/lib/ (store·hash·frontmatter·resolve-kind·findings·json-out·walk)  — universal blocker
 ├ S1 --json backbone (patch run-all + run-meta)        [⊥ S3]
 ├ S3 manager/registry.mjs (build/ls/show/changed/diff) — critical path
 │   ├ S4 lint/validate-registry.mjs   ├ S5b lint/validate-manager-zerodep.mjs   └ S6 meta storage-additive
 ├ S5a manager/status.mjs (compose panels)  ← needs S3
 └ S2 RED tests + fixtures  ← needs only S0 contracts + schemas
S7 bin/forge.mjs dispatch (single-writer)   →   S8 doctor MANAGER-SCOPE block
```
Critical path `S0 → S3 → S4 → S5a → S7`. `bin/forge.mjs` (S7+S8) is single-writer, always sequential.
Highest-leverage first slice: the **S0 nucleus** (`store.mjs` + `findings.mjs` + the 3 schemas).

## The 3 workflows (one at a time; human gate between)

- **W1 — RED spine + zero-risk foundation:** (1A ∥) schemas + fixtures · (1B ∥×4) `manager/lib/` ·
  (1C ∥×4) RED `node:test` cases. **Gate 1:** suite runs; feature cases RED for the right reason; `forge
  validate|doctor|sync` byte-identical to baseline; `lib/` zero-dep. Also apply the SPEC-00 amendment.
- **W2 — registry core + validators → GREEN (no CLI wiring):** (2A) `registry.mjs`; (2B ∥×3)
  `validate-registry` + `validate-manager-zerodep` + `manager-storage-additive`. **Gate 2:** EVAL-REG-001..010,
  EVAL-VER advisory cases, EVAL-INT-001/002/003/005/006/008/009 GREEN; new validators auto-discovered.
- **W3 — integrate CLI surface (single-writer):** (3A ∥×2) `status.mjs` + the `--json` runner patch;
  (3B) `bin/forge.mjs` dispatch; (3C) doctor block. **Gate 3:** EVAL-CLI-001..010, EVAL-INT-004/007/010
  GREEN; **EVAL-INT-007** (no-state commands byte-identical to baseline) is the keystone; `forge validate
  --strict` passes incl. the 2 new validators.

## Risks
R1 `bin/forge.mjs` parallel-edit corruption → single-writer, sequential. R2 frontmatter rewire → new lib
only. R3 stderr/stdout parse → parse both; EVAL-CLI-001 fixture pins one finding. R4 async/exit → avoided
by delegation; `spawnSync` capture. R5 fixtures drift → authored once in W1, frozen, read-only.

## "Prove the spine" milestone (target by end of W2)
`forge registry build --write` writes a valid `forge/.forge/registry.json` for `fixtures/lib-min`;
`forge registry ls` reads it back; `forge status` renders one live REGISTRY panel + four `(no data)`
stubs, exit 0 — with `forge doctor|validate|sync` still byte-identical to baseline.

## Verification (v0.2 done)
1. v0.2 EVAL-REG/VER/INT/CLI suite GREEN (`node --test`). 2. `forge validate --strict` passes incl. the
2 new validators + the meta-test. 3. No regressions (EVAL-INT-007). 4. `forge status --json` validates
against `envelope.schema.json`. 5. Invariants: zero-dep, fail-open, additive storage, advisory-only exit.
