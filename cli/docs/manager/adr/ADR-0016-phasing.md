# ADR-0016: Build phasing — walking-skeleton-first; the three highest-leverage builds

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.2

## Context

The full six-dimension manager is large, and the proportionality verdict (`ideas/01`) is blunt: built all
at once it "doubles the codebase to manage the original half." But the dimensions are not equally urgent —
some are prerequisites with immediate payoff, others are deferred until a specific pain appears. We need a
phasing decision that (a) ships a *thin end-to-end skeleton* before any one dimension is deep, (b) names
the few highest-leverage builds explicitly so effort lands there first, and (c) binds the tier partition
from `ideas/01` to the concrete phases in `ROADMAP.md`.

## Decision

**Walking-skeleton-first, advisory-first, in the phases `ROADMAP.md` defines. v0.2 is a thin slice through
every layer (envelope → store → registry → status), built around the three highest-leverage changes; the
rest grows in only when its trigger condition fires.**

- **The three highest-leverage first builds (v0.2 core):**
  1. **The `--json` backbone** (ADR-0004) — makes the *entire existing harness* machine-readable in two
     parent-runner files, touching no child validator. Highest leverage per line changed; unlocks `status`
     and CI integration.
  2. **Registry + `validate-registry`** (BR-REG, ADR-0008/0014) — the identity spine every other dimension
     reads; fixes `VERSION` drift; ships its own self-validator.
  3. **`forge status` skeleton** (SPEC-08) — composes the above and *proves the dashboard contract*: a
     panel per dimension, `(no data — run X)` where a dimension is absent (fail-open composition). It is
     the skeleton's spine even though most panels are stubs at v0.2.
- **Tier partition (from `ideas/01`, bound to phases):**
  - **Tier 1 — build now (v0.2):** the three above + `manager/lib/` foundation + marker `sourceRev` field.
  - **Tier 1 finish + Tier 2 cheap (v0.3):** dependency graph (prose-ref dangling detection), static
    context-budget `analyze`, read-only `fleet`.
  - **Tier 2 (v0.4):** eval-of-harness (pass/fail meta-tests, no GPA), telemetry (opt-in, default off); the
    *decision point* to maybe promote a gate from advisory to blocking (ADR-0007) lands here, with data.
  - **Tier 3 — defer until many-projects / a collaborator (v0.5–v0.6):** fleet write/sync orchestration,
    `VERSION` roll-up automation, value-density/dead-artifact `optimize`.
- **Advisory-first throughout.** No phase introduces a blocking gate by default (ADR-0007); every
  dimension degrades gracefully (cost-only, static-only, empty-panel) when its upstream signal is absent.
- **Phase definition-of-done** is owned by `ROADMAP.md` (MUST EVAL cases GREEN + `validate --strict` +
  `status` reflects the new dimension + SPEC open-questions resolved/carried + docs updated). This ADR
  fixes the *ordering and the three-build focus*; the gate criteria live in the roadmap.

## Consequences

**Positive**
- A usable, end-to-end-coherent tool exists after v0.2 (~60% of the value, per `ideas/02` success
  criteria), with zero blocking gates and one new authoritative file (the registry).
- Effort is concentrated where leverage is highest; deferred dimensions cost nothing until their trigger.

**Negative**
- v0.2's `status` shows mostly stub panels (only the registry panel is live). Intentional — the skeleton's
  job is to *prove composition*, not to be full. The stubs are honest `(no data — run X)`, not empty.

**Neutral**
- Triggers (not a calendar) decide when a later phase starts: a dangling-ref bug pulls v0.3 forward; "I
  can't tell what I use" pulls telemetry forward. The order is fixed; the timing is demand-driven.

## Alternatives considered

- **Build one dimension fully, then the next (vertical-first).** Rejected: you'd have a deep registry and
  no dashboard, or telemetry with nothing to compose it into — no end-to-end proof until late.
- **Build everything to v1 before shipping.** Rejected outright by the proportionality verdict.
- **Skip the skeleton, start with the most-wanted dimension.** Rejected: without the envelope + store +
  status contracts, each dimension re-invents output and storage; the skeleton is the shared spine.

## Related

ADR-0001 (the shape the skeleton instantiates), ADR-0004 (build #1), ADR-0008 (scan-on-demand registry,
build #2 — owned by Bundle A), ADR-0007 (advisory-first), ADR-0014 (self-validation ships with the
skeleton). `ROADMAP.md`, `ideas/01-proportionality.md`, BR-CLI, BR-INT, SPEC-00, SPEC-08.
