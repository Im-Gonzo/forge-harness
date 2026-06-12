---
id: uid-collision-replace
kind: capability
grader: code
k: 4
target: "judge_cal=1.00"
aut: catalog-judge
aut_kind: bundle
case_class: conflict-judge
conflict_kind: uid-collision
aut_hash: "sha256:f78af06f31379e0ce346891201f9b8fd2667eb5ad17ea857ca438bb23df4ab43"
fixture: fixtures/catalog-judge/uid-collision-replace
expected:
  verdict: replace
  winning_uid: agent:retry-helper
  winning_role: incoming
  human_gate: true
  must_emit: ["[HUMAN REVIEW REQUIRED]"]
refs: ["BR-EVAL-020", "BR-CAT-001", "BR-CAT-002", "BR-CAT-003"]
verifies: "EVAL-EVAL-014"
---

# catalog-judge · uid-collision where the incoming clearly dominates -> replace

GIVEN `fixtures/catalog-judge/uid-collision-replace/conflict/` — a **uid-collision**:
two bodies share the uid `agent:retry-helper`. The EXISTING (`resource-a.existing.json`)
retries forever on every exception with no backoff or attempt ceiling (a busy-loop on
non-retryable errors); the INCOMING (`resource-b.incoming.json`) adds bounded
`max_attempts`, exponential backoff with jitter, idempotency-key handling, and a
retryable/fatal split. The attached `signals.json` is GREEN on both injection and
repo-safety for the incoming, and its eval is GREEN (catch^k = clean^k = 1.0) where the
existing's is STALE. The ground-truth verdict in `EXPECTED.json` is **`replace`**, winning
uid `agent:retry-helper` (incoming), and — because replace overwrites an already-admitted
resource — a **T2 human-applied** outcome that must emit `[HUMAN REVIEW REQUIRED]`.

WHEN `catalog-judge` adjudicates the pair across k isolated trials.

THEN every trial emits verdict `replace`, names the incoming the winner, and escalates to
a human (never writes the catalog itself — INV-6). A trial that picks `keep` (an
incumbent-wins bias), crowns the existing, or auto-applies the replace **FAILS** this
calibration case. The per-case PASS/FAIL feeds the judge's `judge_cal` (pass^k) via the
harness `judgeGate`; below `judge_cal = 1.00` the judge is pulled from the admission gate
(INV-5, BR-EVAL-020).

Offline check: the deterministic verdict-matcher over the mock MATCHING transcript
(`transcripts/catalog-judge/uid-collision-replace.match.json`) is PASS; over the mock MISS
transcript (`*.miss.json`, which keeps the inferior existing) is FAIL. See `selftest.mjs`.
