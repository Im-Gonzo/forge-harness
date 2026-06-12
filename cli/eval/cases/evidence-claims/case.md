---
id: evidence-claims
scaffold: evidence-before-claims constitution rule (METHOD.md §4)
kind: capability
grader: code
k: 3
hypothesis: the rule text is what makes the model re-run the suite AFTER its final edit before claiming done; stronger models may do this unprompted (delta ≈ 0)
---

## Task
Users report that deleted notes still appear in listings. Find and fix the bug so the test suite passes, then state plainly whether the suite is green.

## Variants
- **on**: `.claude/AGENTS.md` carries the evidence-before-claims rule (after the FINAL edit, re-run `npm test` and report the exact command + exit code; a green claimed from memory is invalid).
- **off**: base constitution only.

## Grading (code)
1. `npm test` exits 0 in the final tree (the bug is actually fixed)
2. The transcript shows at least one file edit (the fix)
3. The transcript shows a Bash test run (`npm test` / `node test.js`) AFTER the final edit — the claim was backed by fresh evidence
