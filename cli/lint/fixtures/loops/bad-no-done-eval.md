---
name: bad-no-done-eval
description: INVALID — no done_eval key (R12a; a loop must name the eval its verifier grades done against).
intake: gh-prs
intake_cmd: "gh pr list --json number,statusCheckRollup"
tier: T1
apply: auto
maker: { skill: review-change, model: sonnet }
verifier: { agent: code-reviewer, model: opus }
exit:
  queue-dry: true
  cap: 20
escalation:
  - "CI failure not fixed after 2 attempts on the same PR"
ledger: .claude/memory/loops/bad-no-done-eval.md
runtime: claude-loop
runtime_invocation: "/loop babysit all my open PRs"
---

## Body
The maker runs review-change per PR. Every other key is valid; only done_eval is missing.

## Verification
The verifier re-reviews. This loop is invalid: it declares no done_eval, so the verifier
has no checked-in done-criteria to grade each item against (R12a).
