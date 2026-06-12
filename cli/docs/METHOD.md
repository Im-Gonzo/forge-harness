# Forge — The Encoded Method

> Status: **Phase 1 (blueprint)**. Forge is not just plumbing; it encodes an opinionated way of building software
> with agents. This is that method. See [ARCHITECTURE.md](./ARCHITECTURE.md) and [BOOTSTRAP.md](./BOOTSTRAP.md)
> for how the method is delivered.

## 1. Context is engineered, not dumped — HOT / WARM / COLD

- **HOT** — always loaded, ~one screen: the project **constitution** (`AGENTS.md`) with the non-negotiable
  invariants.
- **WARM** — exactly one **context bundle** per slice: a curated index of the spec sections, rules, prior art,
  and the *invisible-20% checklist* for one work-type. Bundles cite by reference; they never restate normative
  text (single source of truth).
- **COLD** — the corpus (specs/ADRs/rules) and the memory vault, pulled **just-in-time** (grep the need, never
  pre-load).

Forge ships the bundle system as the `context-bundles` module and generates a project's first bundles at
bootstrap.

## 2. The invisible 20% is made structural

Agents reliably drop cross-cutting concerns (tenancy, audit, the single write path). Each bundle pairs every such
concern with a concrete check (a test to write) so the invisible 20% is **in context from step one**, reinforced
across four layers: authoring (bundle) → implementing (the named check) → review (reviewer checklist = the
bundle's checklist) → CI (release-blocking gates). `bundle-lint` forces the governing invariants to be listed at
authoring time, and ships a negative fixture that must fail.

## 3. The autonomy ladder — T0 / T1 / T2

Every task is classified by how much autonomy is safe:

- **T0** read-only (planning, audit, review);
- **T1** leaf change behind a mandatory read-only reviewer;
- **T2** human-gated (irreversible / security / tenancy / data migration) — split into autonomous-draft +
  human-apply. The split *is* the safety mechanism, defended in depth (bundle gate → agent STOP contract →
  workflow gated branch → read-only reviewer).

Forge carries this as the `orchestration` module's `autonomy-ladder` rule.

## 4. Evidence before claims

No "done" without fresh proof. A claim of passing is backed by the actual command + exit code + a tree
fingerprint, re-run at the moment of the claim — not remembered from earlier. Delivered as the
`evidence-before-claims` rule and (Phase 2) a fail-closed Stop hook. The memory vault inherits the same rule: a
recalled entry is a pointer to verify against live code, never authoritative on its own.

## 5. Eval-Driven Development

Evals are the unit tests of agent work. Define expected behavior **before** implementing; run evals continuously;
track regressions. Forge's `eval` module provides:

- **capability** evals (can it do the new thing) vs **regression** evals (did a change break existing behavior);
- three grader types — **code** (deterministic), **model** (Claude scores with reasoning), **human** (flag with
  risk level);
- reliability metrics **pass@k** (≥1 success in k tries) and **pass^k** (all k succeed) — `pass^k` for
  spec-critical paths.

> Eval-Driven Development treats evals as the unit tests of AI development: define expected behavior before
> implementation, run evals continuously, track regressions, use pass@k for reliability.

## 6. Anti-noise review

The primary failure mode of LLM reviewers is manufactured findings. Forge's `code-reviewer` enforces:

- a **Pre-Report Gate** (cite the exact line? name a concrete failure mode? read surrounding context? is the
  severity defensible?);
- **HIGH/CRITICAL require proof** (snippet + line + the specific input/state/outcome, or demote/drop);
- **a clean review is a valid review** — returning zero findings is expected and legitimate;
- a common-false-positives skip-list (magic numbers, speculative "consider X", N+1 on fixed loops, …).

> A clean review is a valid review. Do not manufacture findings to justify the invocation.

For ship-critical slices, the `dual-review` skill runs two **independent** reviewers (no shared context); both
must pass.

## 7. Deterministic collection + LLM judgment

The backbone of every Forge meta-operation (bootstrap profiling, rule distillation, compliance checks): a script
gathers facts **exhaustively** and emits JSON; the model reasons over that JSON with a **strict verdict
taxonomy**; mutations require **human approval**; long operations are **resumable** via a results file. This is
why `profile-project` (script) and `bootstrap-harness` (LLM) are separate steps.

## 8. Memory is curated, confidence-scored, and evidence-backed

The `memory` module's entry schema carries a `confidence` (0–1), a dated `## Evidence` section, and `links` to
related entries. Confidence **rises** on recurrence without correction and **falls** on contradiction. The
governing norm:

> Prefer a small set of accurate entries over bulk-generated, duplicated, or contradictory ones.

Entry types: `decisions`, `glossary`, `gotchas`, `learnings`, `runbooks`. A
`validate-memory-integrity` check guards link resolution, type<->dir consistency, and index freshness. A
sprint-scoped working-context file (pruned per an explicit update rule) is kept distinct from durable memory.

## 9. Guardrails are enforced, not suggested

Prose instructions are forgotten ~20% of the time; hooks fire deterministically. Forge moves load-bearing rules
into hooks (`hooks-quality` module): an **edit-citation gate** (name the rule/spec/BR the change implements
before the first edit to a file), **config-protection** (fix the code, not the linter config),
**block-no-verify** (no skipping git/CI hooks), **Stop-typecheck** (batched `mypy`/`tsc` once per turn). All hooks
**fail open**. Layered `paths:`-globbed rules + a one-time **Prompt Defense Baseline** cover the rest.

## 10. The framework holds itself to its own standard

Forge validates Forge: no asset ships that fails the self-validators, and CI asserts that load-bearing governance
prose is *present* in the agents (a missing Pre-Report Gate is a failing build). The harness we use to build
software is built the same way we build software.
