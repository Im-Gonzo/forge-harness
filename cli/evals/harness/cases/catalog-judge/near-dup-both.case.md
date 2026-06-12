---
id: near-dup-both
kind: capability
grader: code
k: 4
target: "judge_cal=1.00"
aut: catalog-judge
aut_kind: bundle
case_class: conflict-judge
conflict_kind: near-dup
aut_hash: "sha256:f78af06f31379e0ce346891201f9b8fd2667eb5ad17ea857ca438bb23df4ab43"
fixture: fixtures/catalog-judge/near-dup-both
expected:
  verdict: both
  winning_uid: null
  human_gate: false
  must_emit: []
refs: ["BR-EVAL-020", "BR-CAT-001", "BR-CAT-002", "BR-CAT-003"]
verifies: "EVAL-EVAL-014"
---

# catalog-judge · near-dup flag is a false positive -> both

GIVEN `fixtures/catalog-judge/near-dup-both/conflict/` — a **near-dup** (DIFFERENT uids,
high content similarity). The dedup stage flagged `rule:pg-migrations` and
`rule:mysql-migrations` at 0.91 similarity on shared migration boilerplate. On the merits
they are genuinely DISTINCT and mutually exclusive: A is Postgres-specific (CREATE INDEX
CONCURRENTLY, transactional DDL rollback) and B is MySQL-specific (online DDL, explicitly NO
transactional DDL — forward-only compensation). Neither subsumes the other. Both security +
eval signals are GREEN. The ground-truth verdict in `EXPECTED.json` is **`both`**: the
near-dup flag was a false positive, both are admitted, no uid wins or loses.

WHEN `catalog-judge` adjudicates the pair across k isolated trials.

THEN every trial emits verdict `both`. A trial that over-trusts the similarity score and
collapses the two distinct engine-specific rules into a single `keep` winner (dropping real
coverage) **FAILS**. The per-case PASS/FAIL feeds `judge_cal` via the harness `judgeGate`.

Offline check: the deterministic verdict-matcher over the mock MATCHING transcript
(`transcripts/catalog-judge/near-dup-both.match.json`) is PASS; over the mock MISS transcript
(`*.miss.json`, which collapses the pair to a single keep) is FAIL. See `selftest.mjs`.
