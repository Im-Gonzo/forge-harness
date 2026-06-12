# ADR-0014: The manager is subject to forge-validates-forge (auto-discovered self-validators)

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.2

## Context

Foundational invariant 5 is **forge-validates-forge**: every part of forge ships its own auto-discovered
validators (`lint/run-all.mjs` discovers `validate-*.mjs`/`check-*.mjs`; `tests/run-meta.mjs` discovers
`tests/meta/*.mjs`). The proportionality verdict (`ideas/01`) warns the manager "must then register and
eval *itself*, recursively" — so the manager's own integrity must be machine-checked the same way the rest
of forge is, or it becomes an unvalidated blind spot that can silently violate the invariants it preaches
(zero-dep, storage discipline, the module contract).

## Decision

**The manager validates itself through forge's existing auto-discovery. It ships two new validators that
`run-all.mjs` discovers with no runner change, and meta-tests in `tests/meta/` that `run-meta.mjs`
discovers, plus it is itself catalogued by the registry it builds.**

- **`lint/validate-manager-zerodep.mjs`** — scans `forge/manager/**/*.mjs` import specifiers and **FAILS
  (ERROR)** on any specifier that is not `node:*` and not relative (`./`/`../`). This mechanically enforces
  zero-dep (invariant 1) for the manager code itself — a non-`node:` import cannot pass review. Auto-
  discovered by `run-all.mjs` (name matches `validate-*.mjs`); no runner edit needed.
- **`lint/validate-registry.mjs`** — asserts the committed registry is in sync with a fresh in-memory
  rebuild and surfaces advisory drift (stale registry / VERSION-triple drift / hash-without-revision as
  `WARN`, malformed registry as `ERROR`). The *content* of the registry rules is owned by Bundle A — this
  validator implements `BR-REG` (see `BR-REG-002`, `BR-REG-008`); Bundle F only fixes that it exists, is
  auto-discovered, and emits standard findings.
- **`tests/meta/manager-storage-additive.mjs`** — a `node:assert` meta-test (discovered by `run-meta.mjs`)
  asserting: (a) a representative manager run writes **only** under `forge/.forge/` or `~/.claude/forge/`
  (the two roots, ADR-0003) and nowhere else; (b) every state file the store writes carries a top-level
  `schemaVersion`. This is the structural-privacy + storage-discipline guard.
- **Additive extension of existing checks (no replacement).** `forge doctor` gains additive manager-scope
  lines (registry presence/staleness, advisory drift) without changing its existing per-project output;
  `forge validate` auto-discovers the two new validators because they match the existing glob; `forge
  sync` is untouched (fleet sync *composes over* it, ADR-0010, not modifies it). The manager extends the
  existing surfaces; it never rewrites them.
- **The manager is in its own registry.** `registry build` catalogs `forge/manager/**` and the new
  validators as artifacts (BR-REG scan surface), so the thing that catalogs forge also catalogs itself —
  the recursion the verdict flagged is *bounded* (catalogued + zero-dep-checked + storage-checked), not
  open-ended (no recursive eval-of-the-eval at v0.2).

## Consequences

**Positive**
- The invariants the manager preaches are *mechanically* enforced on the manager: a non-node import or a
  stray write outside the two roots fails CI, not a human review.
- Zero runner changes — both new validators and the meta-test ride the existing auto-discovery, proving
  the "feels like forge" claim (ADR-0001).

**Negative**
- The manager now appears in its own validation runs (slightly more for `validate` to do). Negligible —
  two more child processes; the import scan is a cheap static read.

**Neutral**
- `validate-manager-zerodep` is a generic import-specifier scanner; it could later cover all of `forge/`,
  but is scoped to `manager/**` here to keep the blast radius to the new code.

## Alternatives considered

- **Trust review for zero-dep / storage discipline.** Rejected: invariant 5 is "validates-forge", not
  "reviews-forge"; a human misses an import. Mechanical is the standard.
- **A bespoke manager test runner.** Rejected: a second runner contradicts auto-discovery; the existing
  `run-all`/`run-meta` discover the new files for free.
- **Recursive eval-of-the-manager (the manager evals itself behaviorally).** Rejected at v0.2 as exactly
  the recursion the verdict warns against; bounded self-validation (catalog + zerodep + storage) is the
  proportionate stop.

## Related

ADR-0001 (the module contract these validators enforce), ADR-0002/0003 (the storage discipline the meta-
test guards), ADR-0004 (the validators emit standard findings into the envelope), ADR-0007 (advisory
levels for the drift these surface). Invariant 5, C2, C4, C6, BR-INT, BR-CLI, BR-REG, SPEC-00, SPEC-09,
EVAL-INT.
