---
id: clean-batched-query
kind: capability
grader: code
k: 5
target: "clean^5=1.00"
aut: code-reviewer
aut_kind: agent
case_class: clean
aut_hash: "sha256:6a19d98964cc8bee60f1b758872bf1a0aed81b14e9fb8654359f3a12e9138ab1"
fixture: fixtures/code-reviewer/clean-batched-query
expected:
  must_flag: null
  must_flag_line: null
  min_severity: null
  must_not_flag: ["N_PLUS_ONE", "MISSING_INDEX"]
refs: ["BR-EVAL-005", "BR-EVAL-006", "BR-EVAL-014"]
verifies: "EVAL-EVAL-002"
---

# code-reviewer · clean already-batched query yields zero false positives

GIVEN `fixtures/code-reviewer/clean-batched-query/code/` — a read path that
*resembles* the N+1 fixture (a loop over orders that needs each order's item count)
but is CORRECT: the counts are fetched in ONE batched `GROUP BY` query before the
loop (`_batch_item_counts`), so the loop body does only a dict lookup. It carries
the exact false positives the reviewer is told to skip: the already-batched loop at
**orders.py:52**, a fixed-cardinality `for status in OrderStatus` loop at
**orders.py:62**, and a present index `idx_line_items_order` at **schema.sql:22**.

WHEN `code-reviewer` reviews the fixture across k=5 isolated worktree trials.

THEN every trial returns **zero findings** on the clean traps (`clean_traps[]` in
`EXPECTED.json`), so `fp_rate = 0.0`, `clean^5 = 1.0`. Any finding on a `clean_trap`
line — flagging the batched loop or the enum loop as an N+1, or claiming a missing
index — **FAILS**.

Offline check: `gradeReviewerCase` over the mock CLEAN transcript
(`transcripts/code-reviewer/clean-batched-query.clean.json`, empty findings) is PASS;
over the mock NOISY transcript (`*.noisy.json`, which mis-flags the batched loop as an
N+1) is FAIL. See `selftest.mjs`.
