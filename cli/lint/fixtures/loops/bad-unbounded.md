---
name: bad-unbounded
description: INVALID — queue-dry is the only exit, no cap or budget (R7 unbounded).
intake: gh-prs
intake_cmd: "gh pr list --json number,statusCheckRollup"
tier: T1
apply: auto
maker: { skill: review-change, model: sonnet }
verifier: { agent: code-reviewer, model: opus }
exit:
  queue-dry: true
escalation:
  - "CI failure not fixed after 2 attempts on the same PR"
ledger: .claude/memory/loops/bad-unbounded.md
runtime: claude-loop
runtime_invocation: "/loop babysit all my open PRs"
done_eval: example-unit-done
---

## Body
The maker runs review-change per PR; the loop only stops when the queue is dry.

## Verification
The verifier re-reviews. This loop is invalid: queue-dry is its ONLY exit and the
intake is unbounded, so it needs a cap or budget too (R7).
