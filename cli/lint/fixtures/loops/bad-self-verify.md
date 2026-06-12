---
name: bad-self-verify
description: INVALID — maker and verifier are the same ref (R5 self-verification).
intake: gh-prs
intake_cmd: "gh pr list --json number,statusCheckRollup"
tier: T1
apply: auto
maker: { skill: review-change, model: sonnet }
verifier: { skill: review-change, model: opus }
exit:
  queue-dry: true
  cap: 20
escalation:
  - "CI failure not fixed after 2 attempts on the same PR"
ledger: .claude/memory/loops/bad-self-verify.md
runtime: claude-loop
runtime_invocation: "/loop babysit all my open PRs"
done_eval: example-unit-done
---

## Body
The maker runs the review-change skill per PR.

## Verification
The verifier runs the SAME review-change skill — which is invalid: a loop may not
verify its own work (R5). maker == verifier.
