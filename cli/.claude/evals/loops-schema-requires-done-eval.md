---
id: loops-schema-requires-done-eval
kind: capability
grader: code
k: 1
target: "pass@1>=1.00"
human_gate: false
baseline: 0.2.2-r12
refs: ["docs/LOOPS-MODULE-DESIGN.md", "rules R12"]
---

## Behavior
validate-loops rejects a loop definition that omits the REQUIRED `done_eval:` key —
the loop must name the eval its verifier grades "done" against (the onboarding
cascade's done-criteria binding; DESIGN D1 + D2 R12).

> Provenance note: authored test-first as a CAPABILITY case. R12 does NOT exist on
> today's tree, so this is a new ability, not regression armor — it MUST be red before
> the validator gains R12. (Authored 2026-06-10 for the write-loop onboarding cascade,
> ships 0.2.2.)

## Success criteria
- [ ] `node lint/validate-loops.mjs lint/fixtures/loops/bad-no-done-eval.md` exits non-zero
- [ ] output names rule `R12` and the missing `done_eval` key

## Grader
<code> cd <forge-root> && node lint/validate-loops.mjs lint/fixtures/loops/bad-no-done-eval.md ;
PASS = exit != 0 AND stdout|stderr matches /R12.*done_eval/
