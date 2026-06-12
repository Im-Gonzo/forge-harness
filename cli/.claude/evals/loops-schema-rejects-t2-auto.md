---
id: loops-schema-rejects-t2-auto
kind: regression
grader: code
k: 1
target: "pass^1=1.00"
human_gate: false
baseline: post-phase-1
refs: ["docs/LOOPS-MODULE-DESIGN.md", "rules R4"]
---

## Behavior
validate-loops rejects a loop definition with `tier: T2` and `apply: auto` — a T2 loop
may prepare changes but never auto-apply them (autonomy ladder, DESIGN D2 R4).

> Provenance note: authored AFTER the validator landed (the Phase-0 RED-first window was
> missed during the 2026-06-09 classifier outage). Honest classification: regression
> armor pinning existing behavior.

## Success criteria
- [ ] `node lint/validate-loops.mjs lint/fixtures/loops/bad-t2-auto.md` exits non-zero
- [ ] output names rule `R4` and requires `apply: draft`

## Grader
<code> cd <forge-root> && node lint/validate-loops.mjs lint/fixtures/loops/bad-t2-auto.md ;
PASS = exit != 0 AND stdout matches /R4: T2 loop may not auto-apply/
