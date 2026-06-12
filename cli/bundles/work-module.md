---
id: work-module
title: Bring a module online — implement a self-contained feature module
version: 1
status: active
work_type: bring-a-module-online
invariants: [1, 2, 3]
adrs:
  - id: ADR-0002
    path: docs/adr/ADR-0002-modular-monolith.md
    why: fixes the module boundary contract — a module is reached only through its public interface, never its internals
spec_sections:
  - path: docs/METHOD.md
    sections: ["1 HOT/WARM/COLD", "2 invisible-20% made structural"]
  - path: docs/specs/modules.md
    sections: ["module boundary & public interface", "module definition of done"]
br_ids: [BR-MOD-001, BR-MOD-002]
conformance:
  - docs/METHOD.md#2
  - docs/specs/modules.md#module-definition-of-done
modules:
  - the-module-being-brought-online
skill: .claude/skills/load-bundle/SKILL.md
secondary_skill: .claude/skills/new-bundle/SKILL.md
agent: .claude/agents/code-reviewer.md
reviewer: .claude/agents/diff-reviewer.md
dod_ref: docs/specs/modules.md#module-definition-of-done
human_gate: false
invisible_20:
  - id: INV-1
    rule: Reach the module only through its public interface; never import another module's internal files directly.
    check: A test (or import-boundary lint) fails on any cross-module import that bypasses the public entrypoint.
    refs: ["docs/adr/ADR-0002-modular-monolith.md", "AGENTS.md invariant 3"]
  - id: INV-2
    rule: Every change names the governing spec/ADR/rule it implements; a change behind no rule does not merge.
    check: Reviewer rejects any diff in this slice with no cited rule/BR id.
    refs: ["AGENTS.md invariant 2"]
  - id: INV-3
    rule: The module owns its data; cross-module reads/writes go through its interface, not its tables/store.
    check: A test asserts no foreign module touches this module's storage directly (only via the public API).
    refs: ["docs/adr/ADR-0002-modular-monolith.md"]
  - id: INV-4
    rule: Errors cross the boundary as the module's declared error type, never as a leaked internal exception.
    check: A boundary test asserts a forced internal failure surfaces as the declared public error, not a raw stack.
    refs: ["docs/specs/modules.md#module-boundary--public-interface"]
  - id: INV-5
    rule: The module ships with capability AND regression evals before it is called done.
    check: skills/run-eval reports the module's capability cases pass@k>=target and regression cases pass^k=1.00.
    refs: ["docs/METHOD.md#5"]
  - id: INV-6
    rule: No "passing" claim without a FRESH command run + exit code shown at the moment of the claim.
    check: The project's test + typecheck commands run fresh and are pasted with exit codes before 'done'.
    refs: ["docs/METHOD.md#4", "AGENTS.md invariant 1"]
acceptance_gates:
  - The module is exercised only through its public interface in every test and call site.
  - Capability evals pass@k>=target; regression evals pass^k=1.00; both shown with fresh commands + exit codes.
release_blocking_gates:
  - The import-boundary check is green (no internal cross-module imports).
  - The module's regression eval set is pass^k=1.00.
---

# work-module — WARM context for bringing a self-contained module online

WARM context bundle (`docs/METHOD.md` §1): the curated index for one recurring work-type — implementing a new,
self-contained feature module behind a clean public interface. It cites by reference and never restates normative
text; the boundary contract, the spec, and the rules live in the COLD corpus and HOT `AGENTS.md`, and this bundle
points at them. Load it (`skills/load-bundle/`) when the slice is "stand up module X".

## Purpose

Serves the **bring-a-module-online** slice-class. The riskiest thing it must get right: **the module boundary** —
a module is reached only through its public interface and owns its own data; nothing reaches into its internals or
its store. Get that wrong once and the modular monolith quietly degenerates into a tangle.

## Retrieval plan

1. Confirm HOT loaded (`AGENTS.md` + its invariants). 2. Read this bundle whole. 3. JIT, in implementation order:
`docs/specs/modules.md` (module boundary & public interface) -> `ADR-0002` (why the boundary contract) ->
`docs/specs/modules.md` (definition of done); grep `BR-MOD-001` / `BR-MOD-002` in the rule corpus per step. Never
read whole files — pull only on a stated need. Nothing in the COLD corpus or `memory/` is auto-loaded.

## Invariants in play

- **1** — evidence before claims (the "done" claim is a fresh run, not a memory).
- **2** — cite the rule (every change names the spec/ADR/BR it implements).
- **3** — the module boundary contract (public interface only; the module owns its data).

Reminders only — the normative text lives in HOT and the cited ADR/rules, never restated here.

## The invisible 20% — do not drop these

Re-read before claiming done. Each `invisible_20` entry pairs a cross-cutting **rule** with the **check** to
write: the public-interface boundary (INV-1), cite-the-rule (INV-2), data ownership (INV-3), errors as the
declared type (INV-4), capability + regression evals (INV-5), evidence before claims (INV-6). The reviewer checks
the diff against `br_ids` + `conformance` + `invisible_20` before merge; the same list is the reviewer checklist
and (INV-1, INV-5) the release-blocking CI gate.

## Human gate

`human_gate: false`. Bringing a self-contained module online is T1 work: a leaf change behind a mandatory
read-only reviewer (`diff-reviewer`). If the module turns out to touch tenancy/RLS, the core write path, or a
v1->v2 migration, it is no longer this work-type — author the gated bundle for that class (`skills/new-bundle/`)
and stop for a human (`docs/METHOD.md` §3, T2).

## Prior art / memory

Retrieve on demand from the COLD vault (`memory/index.md`): prior module-boundary decisions and gotchas. Pull
only on a stated need; nothing here is auto-loaded, and a recalled entry is a pointer to verify against live code
(`docs/METHOD.md` §8).

> The ADR / spec / BR paths above are realistic placeholders for a target project's corpus. At bootstrap, retarget
> them to the project's actual `docs/adr/`, spec files, and BR ids; the linter checks pointer **shape** here and
> resolves them on-disk against the real corpus in the target repo.
