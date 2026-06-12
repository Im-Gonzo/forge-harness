---
name: good-babysit
description: Babysit open PRs — for each, run review + fix CI until green or escalate.
intake: gh-prs
intake_cmd: "gh pr list --json number,statusCheckRollup"
tier: T1
apply: auto
maker: { skill: review-change, model: sonnet }
verifier: { agent: code-reviewer, model: opus }
exit:
  queue-dry: true
  cap: 20
  budget: 200000
escalation:
  - "CI failure not fixed after 2 attempts on the same PR"
  - "review surfaces a security finding"
ledger: .claude/memory/loops/good-babysit.md
runtime: claude-loop
runtime_invocation: "/loop babysit all my open PRs: review, fix CI, stop when none remain"
done_eval: example-unit-done
---

## Body
For each PR returned by `intake_cmd`, load the diff and run the `review-change` skill
(the maker) to triage and apply fixes for failing checks. One PR per iteration.

## Verification
The `code-reviewer` agent (the verifier — distinct from the maker) re-reviews the
resulting diff. PASS means: checks green, no new review findings of severity >= MAJOR,
and the change stays within the PR's stated scope.
