---
id: eval-judge
title: Eval judge — build and review an LLM-as-judge grader
version: 1
status: active
work_type: eval-judge
invariants: [4, 5]
adrs:
  - id: ADR-0005
    path: docs/adr/ADR-0005-llm-judge-grader.md
    why: chooses LLM-as-judge over code-only grading for open-ended eval criteria
spec_sections:
  - path: docs/METHOD.md
    sections: ["5 EDD", "7 deterministic collection + LLM judgment"]
  - path: docs/specs/eval.md
    sections: ["model-grader rubric", "verdict taxonomy"]
br_ids: [BR-EVAL-001, BR-EVAL-002]
conformance:
  - docs/METHOD.md#5
  - docs/METHOD.md#7
modules:
  - eval
skill: .claude/skills/run-eval/SKILL.md
secondary_skill: .claude/skills/author-eval/SKILL.md
agent: .claude/agents/code-reviewer.md
reviewer: .claude/agents/diff-reviewer.md
dod_ref: docs/specs/eval.md#definition-of-done
human_gate: false
invisible_20:
  - id: INV-1
    rule: A model grader MUST emit a verdict AND its reasoning, against the case rubric — never a bare score.
    check: Grader output is rejected (FAIL) when reasoning is empty or no threshold is stated.
    refs: ["docs/METHOD.md#7"]
  - id: INV-2
    rule: The verdict taxonomy is strict and closed — PASS/FAIL or a single numeric score with a stated threshold; no free-form verdicts.
    check: Any grader output outside the declared taxonomy is treated as FAIL, not silently coerced to PASS.
    refs: ["docs/METHOD.md#7"]
  - id: INV-3
    rule: Pair the model grader with at least one deterministic (code) criterion where one can decide; model judgment adds noise.
    check: The case file lists a code criterion alongside the model criterion, or documents why none is possible.
    refs: ["docs/METHOD.md#5"]
  - id: INV-4
    rule: A flaky model grader must never gate a release — measure its own pass^k before trusting it as a gate.
    check: The judge is itself evaluated for stability; if pass^k < 1.00 on its calibration set it is pulled from release gates.
    refs: ["docs/METHOD.md#5"]
  - id: INV-5
    rule: Do not overfit the judge's rubric to the known eval examples; it must generalize to unseen outputs.
    check: The rubric is validated against a held-out set, not only the cases used to write it.
    refs: ["docs/METHOD.md#5"]
  - id: INV-6
    rule: Irreducibly risky criteria (security/tenancy/migration) escalate to a human grader — the model judge does not auto-pass them.
    check: Such cases carry human_gate true and emit [HUMAN REVIEW REQUIRED] with a risk level instead of a PASS.
    refs: ["docs/METHOD.md#3"]
  - id: INV-7
    rule: A passing claim about the judge comes from a fresh run with the command, exit code, and tree fingerprint — never from memory.
    check: The judge's report carries the baseline fingerprint and the exact grading command + exit code.
    refs: ["docs/METHOD.md#4"]
acceptance_gates:
  - Judge emits verdict + reasoning for every graded case; bare scores are rejected.
  - Judge's own pass^k = 1.00 on its calibration set before it is used as a release gate.
release_blocking_gates:
  - No model grader gates a release while its calibration pass^k < 1.00.
---

# eval-judge — WARM context for building / reviewing a model (LLM-as-judge) grader

WARM context bundle (`docs/METHOD.md` §1): a curated index for one work-type — building or reviewing the
**model grader** half of an eval. It cites by reference and never restates normative text; the rules live in
`docs/METHOD.md` and the project spec, and this bundle points at them. Load it when the task is to design, build,
or review an LLM-as-judge grader for `skills/run-eval/`.

## What this work is

A model grader scores open-ended eval output that a code grader cannot decide — faithfulness, tone, reasoning
quality (`docs/METHOD.md` §5). The backbone is **deterministic collection + LLM judgment** (`docs/METHOD.md`
§7): the case fixes the inputs and rubric deterministically; the judge reasons over them with a strict verdict
taxonomy. The judge is itself an eval subject — it has reliability (pass@k / pass^k) you must measure before you
trust it to gate anything.

## The invisible 20% (defended in frontmatter `invisible_20`)

The cross-cutting concerns a judge build reliably drops — each paired with a concrete check above:

1. **Verdict + reasoning, never a bare score** (INV-1) — a model grade with no reasoning is uninterpretable and
   unauditable.
2. **A strict, closed verdict taxonomy** (INV-2) — free-form verdicts silently leak into PASS.
3. **Pair with a deterministic criterion** (INV-3) — code grading where it can decide; model only where it must.
4. **Measure the judge's own stability** (INV-4) — a flaky judge is a flaky gate.
5. **No rubric overfitting** (INV-5) — validate against held-out outputs, not the writing set.
6. **Escalate irreducibly risky criteria to a human** (INV-6) — the judge does not auto-pass security / tenancy
   / migration paths (`docs/METHOD.md` §3, T2).
7. **Evidence before claims** (INV-7) — the judge's "it passes" is a fresh run with command + exit code +
   fingerprint, not a memory (`docs/METHOD.md` §4).

## Pointers (COLD — pull just-in-time, do not pre-load)

- Method: `docs/METHOD.md` §5 (EDD), §7 (deterministic collection + LLM judgment), §3 (autonomy / human gate),
  §4 (evidence before claims).
- ADR: `ADR-0005` (LLM-judge over code-only) — `docs/adr/ADR-0005-llm-judge-grader.md`.
- Spec + DoD: `docs/specs/eval.md` (model-grader rubric, verdict taxonomy, definition of done).
- Business rules: `BR-EVAL-001`, `BR-EVAL-002` (the BR catalog is the single source of truth).
- Drives: `skills/run-eval/` (runs the judge in the loop) and `skills/author-eval/` (authors the case the judge
  grades).

> The ADR / spec / BR paths above are realistic placeholders for a target project's corpus. At bootstrap,
> retarget them to the project's actual `docs/adr/`, spec files, and BR IDs; the linter checks pointer **shape**
> here and resolves them on-disk against the real corpus in the target repo.
