# Skill Authoring Style — objective-first, judgment-first

> Status: NORMATIVE for new skills as of 2026-06-10; existing-skill sweep gated on the
> Round-2 delta data (docs/DELTA-FINDINGS.md). Rationale: prose
> written for prior-model failure modes anchors stronger models to stale patterns
> (external guidance, A. Albert 2026-06; measured in-house: the orchestration
> realignment shrank plan-orchestrate by 84 lines with zero capability loss, and the
> preliminary citation-gate × fable delta is NEGATIVE — over-instruction has a cost).

## The rule

A skill states **what done looks like and how it is verified — not the keystrokes.**

Required order of sections:
1. **Objective** — the outcome, one or two sentences.
2. **Invariants** — what must hold no matter the path (the tier gate, the maker/checker
   split, the things a wrong path would violate). These are the load-bearing lines.
3. **Verification** — how "done" is proven: the command, the grader, the reviewer, the
   evidence the claim must carry. If a criterion can't be phrased checkably, it isn't
   one yet.
4. **Anti-patterns** — PASS/FAIL pairs (house convention, unchanged).
5. **Worked example (optional appendix)** — the step-by-step, LAST. Weaker-tier makers
   lean on it; stronger-tier makers should never need to read past §3. This is tiered
   scaffolding inside one file — no model-conditional text required.

## What this does NOT relax

- **Safety procedures are invariants in disguise.** Where the procedure IS the
  contract — T2 draft/human-apply splits, expand-contract migration order, dual-review
  independence, fail-open hook semantics — the steps stay normative, up in §2. The rule
  targets *mechanical* walkthroughs, never safety sequencing.
- **Verification is never advisory.** Prescribe the verification, not the path. A skill
  that loosens §3 to give the model "judgment" has inverted the rule.
- **Trigger frontmatter stays rich.** Discovery needs detail; the body is what slims.

## Smell test for existing skills (the sweep checklist)

- Numbered steps that restate what any competent agent would do unprompted → appendix
  or delete.
- A table the model re-derives every run (tag maps, routing rules, composition rules)
  → move to a deterministic script, leave a pointer (METHOD §7; see
  engine/compose-plan.mjs as the worked precedent).
- Instructions justified by "the model forgets/skips X" → candidate for a hook or a
  validator (enforced, not suggested — METHOD §9), or for deletion if the delta data
  says current models don't drop X anymore.
- Prose restating another file's normative content → pointer (single source of truth).

## Enforcement

Advisory for now. After the sweep: extend `lint/validate-skills.mjs` with a
section-order check (Objective/Invariants/Verification present, worked example last) —
authoring-time ratchet, same pattern as the bundle required-keys check.
