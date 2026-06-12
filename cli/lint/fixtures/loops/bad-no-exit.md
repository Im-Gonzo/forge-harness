---
name: bad-no-exit
description: INVALID — no exit keys at all (R7; a loop must declare >=1 bounded exit).
intake: gh-prs
intake_cmd: "gh pr list --json number,statusCheckRollup"
tier: T1
apply: auto
maker: { skill: review-change, model: sonnet }
verifier: { agent: code-reviewer, model: opus }
exit: {}
escalation:
  - "CI failure not fixed after 2 attempts on the same PR"
ledger: .claude/memory/loops/bad-no-exit.md
runtime: claude-loop
runtime_invocation: "/loop babysit all my open PRs"
done_eval: example-unit-done
---

## Body
The maker runs review-change per PR with no declared exit condition.

## Verification
The verifier re-reviews. This loop is invalid: it declares no exit keys, so it is
unbounded and can never terminate (R7).
