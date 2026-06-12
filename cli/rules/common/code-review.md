---
name: code-review
description: Always-on reviewer's checklist. A clean review is a valid review; every HIGH/CRITICAL needs proof (line + concrete failure); check security, correctness, tests, and clarity — and skip the known false positives.
---
# Code Review

> Always-on, global. The human/agent reviewer's checklist. It complements the
> `code-reviewer` agent's anti-noise stance (METHOD.md §6): findings are earned, not
> manufactured.

## Anti-noise first

- [ ] **A clean review is a valid review.** Returning zero findings is expected and
      legitimate — do not invent issues to justify the review.
- [ ] Every HIGH/CRITICAL finding needs PROOF: the exact file and line, a concrete
      failure mode (the specific input/state → wrong outcome), and a defensible
      severity. Without proof, demote it or drop it.
- [ ] Read the surrounding context before flagging — confirm the concern is real in
      THIS code, not a generic worry.
- [ ] Skip the known false positives: magic numbers already named, speculative
      "consider X", N+1 on a fixed-size loop, style nits a formatter owns, and
      "might want to" suggestions with no failure behind them.

## What to actually check

- [ ] **Security** — no hardcoded secrets; inputs validated; queries parameterized;
      output escaped; authz checked on the resource (see `security`).
- [ ] **Correctness** — edge cases, null/empty/boundary inputs, error paths, and
      off-by-ones. Does it do what the diff claims?
- [ ] **Tests** — new behavior has tests; a fix has a regression test; assertions are
      meaningful (see `testing`).
- [ ] **Clarity & shape** — small focused functions, no deep nesting, no dead code or
      debug debris, names that read (see `coding-style`).
- [ ] **No debris** — leftover `console.log`/prints, commented-out code, or stray TODOs.

## Severity → action

| Level | Meaning | Action |
|---|---|---|
| CRITICAL | Security hole or data-loss risk | BLOCK — fix before merge |
| HIGH | Real bug or significant quality issue | Fix before merge |
| MEDIUM | Maintainability concern | Consider fixing |
| LOW | Style / minor suggestion | Optional |

## Approval

- [ ] Approve when there are no CRITICAL or HIGH findings.
- [ ] Block on any CRITICAL. Escalate auth/crypto/payments/user-data changes to a
      dedicated security review.
- [ ] State findings with the line and the failure; never with a vague "this could be
      better".
