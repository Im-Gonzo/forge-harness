---
id: uid-collision-keep
kind: capability
grader: code
k: 4
target: "judge_cal=1.00"
aut: catalog-judge
aut_kind: bundle
case_class: conflict-judge
conflict_kind: uid-collision
aut_hash: "sha256:f78af06f31379e0ce346891201f9b8fd2667eb5ad17ea857ca438bb23df4ab43"
fixture: fixtures/catalog-judge/uid-collision-keep
expected:
  verdict: keep
  winning_uid: skill:csv-export
  winning_role: existing
  human_gate: false
  must_emit: []
refs: ["BR-EVAL-020", "BR-CAT-001", "BR-CAT-002", "BR-CAT-003"]
verifies: "EVAL-EVAL-014"
---

# catalog-judge · uid-collision where the existing is better -> keep

GIVEN `fixtures/catalog-judge/uid-collision-keep/conflict/` — the **mirror** of the replace
case, same uid `skill:csv-export`, opposite winner. The EXISTING
(`resource-a.existing.json`) streams the export in constant memory and quotes/escapes every
field per RFC-4180, with a GREEN eval; the INCOMING (`resource-b.incoming.json`) buffers the
whole table in memory and emits unescaped fields (any value with a comma/quote/newline
corrupts the row — a correctness defect), with a REGRESSED eval. Both security signals are
GREEN, so the discriminator is merit + eval, where the EXISTING wins. The ground-truth
verdict in `EXPECTED.json` is **`keep`**: the incoming is dropped from admission, no human
gate, no catalog write.

WHEN `catalog-judge` adjudicates the pair across k isolated trials.

THEN every trial emits verdict `keep` and crowns the existing the survivor. This is the
**discriminating** pair against `uid-collision-replace`: identical conflict shape, opposite
correct answer — a judge that defaults to "newer wins" picks `replace` here and **FAILS**.
The per-case PASS/FAIL feeds `judge_cal` via the harness `judgeGate`; the calibration is
green only if BOTH this and the replace case are answered correctly across all trials.

Offline check: the deterministic verdict-matcher over the mock MATCHING transcript
(`transcripts/catalog-judge/uid-collision-keep.match.json`) is PASS; over the mock MISS
transcript (`*.miss.json`, which replaces with the defective newer incoming) is FAIL. See
`selftest.mjs`.
