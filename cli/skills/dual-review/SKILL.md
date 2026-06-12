---
name: dual-review
description: For ship-critical changes — run TWO independent reviewers with no shared context against the same diff and rubric; both must approve to ship. On any disagreement, fix the flagged issues and re-run with FRESH reviewers, looping until both converge or the iteration cap escalates to a human.
---

# dual-review — two independent reviewers, both must pass

The dual-reviewer pattern, per the guidance in `docs/METHOD.md` §6. The core insight: a single
reviewer shares the biases and blind spots of whatever produced the change. **Two independent
reviewers with no shared context** break that failure mode — if only one catches an issue, the
issue is real and the other reviewer's blind spot is exactly what this skill exists to eliminate.

Reviewers are **read-only** (Read/Grep/Glob/Bash — never Edit/Write). This skill orchestrates
review and a fix loop; the *fixing* is done by a separate implementer step between rounds, never
by a reviewer.

## When to activate

Use for **ship-critical** changes — the high cost of a miss justifies ~2-3x the review cost:

- Code that ships to production without a human review gate.
- Irreversible, security-, tenancy-, or data-migration-touching changes (T2 on the autonomy
  ladder, `docs/METHOD.md` §3) — dual-review is the read-only leg, not a substitute for the
  human-apply gate.
- Changes whose correctness is load-bearing for a spec-critical path.

Do **not** use for internal drafts, exploratory work, or changes with deterministic verification
(let build/test/lint and a single **review-change** pass cover those). One reviewer is enough for
ordinary T1 leaf changes; reserve dual-review for when a single blind spot is unacceptable.

## How it works

### Phase 1 — Freeze the inputs (read-only)

Capture the exact change set and a tree fingerprint *now* (`docs/METHOD.md` §4), and write the
shared rubric both reviewers will use. Same diff, same rubric, **no** shared assessment.

```bash
git rev-parse HEAD && git status --porcelain          # fingerprint — anchor the round
git diff --staged && git diff                          # the change set under review
git diff "$(git merge-base HEAD origin/main)"...HEAD   # (PR/branch form)
```

Build a rubric of **objective** pass/fail criteria (the vaguer the rubric, the vaguer the review).
Seed it from the project's invariants and tune to the change. Example rows:

| Criterion | Pass condition | Failure signal |
|---|---|---|
| Correctness | Behaves correctly for every input the diff affects | A nameable input/state yields a wrong result |
| Security & trust boundaries | No injection, no auth/tenancy bypass, no secret/PII leak | A reachable path violates a boundary |
| The invisible-20% | Tenancy/audit/single-write-path checks present where required (`docs/METHOD.md` §2) | A cross-cutting concern is silently dropped |
| Error & edge handling | Failure paths handled or correctly propagated | Unhandled error on a path no caller guards |
| Test coverage | New behavioral paths are tested | A new path ships untested |
| Convention fit | Matches `AGENTS.md` / `rules/` conventions | Drift from a stated project convention |

### Phase 2 — Check it twice (two INDEPENDENT reviewers)

Spawn **two reviewers as separate subagents, in parallel**. Invariants (all four are
load-bearing):

1. **Context isolation** — neither reviewer sees the other's assessment. Subagents give true
   isolation; that is why they are required, not inline "pretend you're reviewer 2" prompting.
2. **Identical rubric** — both receive the Phase 1 rubric verbatim.
3. **Same inputs** — both receive the diff, the tree fingerprint, and project conventions.
4. **Anti-noise still applies** — each reviewer is a **code-reviewer** (or the stack-specific
   `*-reviewer`) and runs the full Pre-Report Gate: exact line, named failure mode, read context,
   defensible severity; HIGH/CRITICAL require proof; **a clean review is a valid review**. Two
   independent passes is *not* license to manufacture findings.

Each reviewer returns a structured verdict — `APPROVE` / `WARN` / `BLOCK` plus a severity table
and findings — and explicitly states "I have not seen any other review of this change."

### Phase 3 — Verdict gate (naughty or nice)

```
both APPROVE                              → NICE  → ship
either has CRITICAL (BLOCK)               → NAUGHTY → fix loop
either has HIGH (WARN), no CRITICAL       → NAUGHTY → resolve the HIGH(s), then re-run
```

Both must clear the bar. **No partial credit, no averaging.** Merge and de-duplicate the findings
from both reviewers; a finding raised by only one reviewer is still real.

### Phase 4 — Fix until nice (convergence loop, cap = 3)

```
iteration = 0
while iteration < 3:
    if both APPROVE: log + ship; stop
    implementer fixes ONLY the merged flagged issues — no refactor, no scope creep
    re-run Phase 1 fingerprint (the tree changed → prior greens are stale, METHOD §4)
    re-run Phase 2 with FRESH reviewers (no memory of prior rounds — anchoring bias)
    iteration += 1
# cap reached without convergence:
escalate to a human with the change, the open findings, and the round history
```

Two non-negotiables: between rounds the **tree fingerprint is recaptured** (a fix invalidates the
previous pass), and each round uses **fresh reviewers** with no memory of the last round — carried
context creates anchoring bias and lets a regression slip. The implementer fixes only what was
flagged, so fresh reviewers naturally catch any fix-induced regression.

## Anti-patterns

| PASS | FAIL |
|------|------|
| Two reviewers as isolated subagents, neither sees the other | One reviewer, or inline "now act as reviewer 2" (context bleed) |
| Ship only when BOTH approve | Shipping on one APPROVE because the other "is probably wrong" |
| A solo finding is treated as real and fixed | Discarding a finding because only one reviewer raised it |
| Fresh reviewers each round; fingerprint recaptured after a fix | Re-using the same reviewer instances / carrying prior-round memory |
| Implementer fixes ONLY flagged issues | Fixing flagged issues *and* refactoring unrelated code mid-loop |
| Both reviewers run the Pre-Report Gate; clean rounds are valid | Manufacturing findings because "two reviewers must find more" |
| Cap at 3 rounds, then escalate to a human | Looping indefinitely while reviewers keep inventing new nits |
| Reviewers stay read-only; a separate step applies fixes | A reviewer edits the code it is reviewing |

## Related

- **review-change** skill — the single-reviewer procedure; dual-review is its ship-critical escalation.
- **code-reviewer** / **diff-reviewer** agents — the read-only reviewers spawned in Phase 2.
- `docs/METHOD.md` §6 (anti-noise + dual independent reviewers), §3 (autonomy ladder — T2 still
  needs the human-apply gate), §4 (evidence before claims — recapture the fingerprint each round).
- Run deterministic build/test/lint checks *before* dual-review; semantic review comes after the
  gates are green.
