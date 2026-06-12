---
name: loop-discipline
description: Always-on. Recurring work is loop-shaped — codify it, don't re-do it. The third manual repetition of a workflow triggers an offer to codify it via the write-loop skill (cite the repetition). A loop's "done" requires its verifier's output; loop bodies inherit the autonomy tier and T2 surfaces always stop for human-apply; read the ledger, not just the diff.
---
# Loop Discipline

> Always-on, global. Encodes `docs/LOOPS-MODULE-DESIGN.md` D5. Recurring/automated work is
> loop-shaped: name it, split maker from verifier, bound it, hand it to a native runtime.

- [ ] **Rule of three.** The THIRD manual repetition of the same workflow (this session or
      week) means stop hand-running it — OFFER to codify it via the `write-loop` skill (or a
      slash command). Cite the repetition you observed ("ran `npm test` three times this turn").
      Two is coincidence; three is a loop you haven't written yet.
- [ ] **A loop's "done" requires its verifier's output.** Extends evidence-before-claims to
      loops: an iteration is complete only when the DIFFERENT verifier (never the maker) has
      run and reported PASS. "I ran the body" is not done; "the verifier returned green" is.
- [ ] **Loop bodies inherit the tier gate.** The loop's `tier` (autonomy-ladder) governs every
      iteration. A **T2 surface always stops for human-apply** — a loop may PREPARE an
      irreversible/security/tenancy/migration change but never auto-applies it, however many
      iterations it has run cleanly. `apply: auto` is invalid at T2 (validator R4).
- [ ] **Read the ledger, not just the diff.** Unattended loops make unattended mistakes. Before
      trusting a run, read its `.claude/memory/loops/<name>.md` ledger — the dated per-iteration
      evidence, not just the final diff. A loop with no completed verified iteration is not done.

## Related

- `skills/write-loop/SKILL.md` — author/register a checked-in loop (maker≠verifier, bounded exits).
- `skills/ratchet/SKILL.md` — the bounded run-until-green primitive (one ratchet family ≥3 ⇒ codify).
- `rules/autonomy-ladder.md` — T0/T1/T2 semantics the loop's `tier` inherits; the T2 split.
- `rules/common/evidence-before-claims.md` — "done" needs fresh proof; the verifier's output is that proof.
- `docs/LOOPS-MODULE-DESIGN.md` D5 (this rule), D1 (loop schema), D6 (the loop-gate / stop-loop-candidate hooks).
