---
name: bad-t2-auto
description: INVALID — tier T2 with apply auto (R4; a T2 loop may never auto-apply).
intake: gh-prs
intake_cmd: "gh pr list --json number,statusCheckRollup"
tier: T2
apply: auto
maker: { skill: review-change, model: sonnet }
verifier: { agent: code-reviewer, model: opus }
exit:
  queue-dry: true
  cap: 20
escalation:
  - "CI failure not fixed after 2 attempts on the same PR"
ledger: .claude/memory/loops/bad-t2-auto.md
runtime: claude-loop
runtime_invocation: "/loop babysit all my open PRs"
done_eval: example-unit-done
---

## Body
The maker prepares changes for each PR at autonomy tier T2.

## Verification
The verifier re-reviews. This loop is invalid: a T2 loop may PREPARE changes but never
apply them automatically (R4 — autonomy-ladder). It declares apply: auto.
