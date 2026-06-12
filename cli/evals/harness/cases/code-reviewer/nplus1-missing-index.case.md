---
id: nplus1-missing-index
kind: capability
grader: code
k: 5
target: "catch^5=1.00"
aut: code-reviewer
aut_kind: agent
case_class: planted-defect
aut_hash: "sha256:6a19d98964cc8bee60f1b758872bf1a0aed81b14e9fb8654359f3a12e9138ab1"
fixture: fixtures/code-reviewer/nplus1-missing-index
expected:
  must_flag: N_PLUS_ONE
  must_flag_line: 36
  min_severity: MEDIUM
  must_not_flag: []
refs: ["BR-EVAL-004", "BR-EVAL-006", "BR-EVAL-014"]
verifies: "EVAL-EVAL-001"
---

# code-reviewer · planted N+1 + missing index caught at the cited lines

GIVEN `fixtures/code-reviewer/nplus1-missing-index/code/` — a SQLAlchemy read path
with two planted defects: (1) an **N+1** in `summarize_orders`, which issues one
`session.execute` per order inside the loop at **orders.py:36** (unbounded
cardinality, a real N+1, not the fixed-cardinality-enum false positive the reviewer
is told to skip); and (2) a **missing index** on `line_items.order_id` at
**schema.sql:19**, the hot filter column for that per-order query, so each lookup is
a full table scan.

WHEN `code-reviewer` reviews the fixture across k=5 isolated worktree trials.

THEN every trial flags BOTH defects at **≥ MEDIUM**, citing **orders.py:36** for the
N+1 and **schema.sql:19** for the missing index, named via the closed phrase sets in
`EXPECTED.json`. The code grader computes `catch_rate = 1.0`, `catch^5 = 1.0`. A run
that catches only one, cites the wrong line, or under-rates **FAILS**.

Offline check: `gradeReviewerCase` over the mock CATCHING transcript
(`transcripts/code-reviewer/nplus1-missing-index.catch.json`) is PASS; over the mock
MISS transcript (`*.miss.json`, which catches only the N+1) is FAIL. See `selftest.mjs`.
