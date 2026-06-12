---
id: loops-schema-rejects-self-verify
kind: regression
grader: code
k: 1
target: "pass^1=1.00"
human_gate: false
baseline: post-phase-1
refs: ["docs/LOOPS-MODULE-DESIGN.md", "rules R5"]
---

## Behavior
validate-loops rejects a loop definition whose maker and verifier are the same ref
(structural maker/checker split — METHOD §6, DESIGN D2 R5).

> Provenance note: authored AFTER the validator landed (the Phase-0 RED-first window was
> missed during the 2026-06-09 classifier outage). Honest classification: this is
> regression armor, not a capability case — it pins behavior that already exists.

## Success criteria
- [ ] `node lint/validate-loops.mjs lint/fixtures/loops/bad-self-verify.md` exits non-zero
- [ ] output names rule `R5` and the duplicated ref

## Grader
<code> cd <forge-root> && node lint/validate-loops.mjs lint/fixtures/loops/bad-self-verify.md ;
PASS = exit != 0 AND stdout matches /R5: self-verification/
