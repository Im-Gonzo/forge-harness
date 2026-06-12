---
name: evidence-before-claims
description: Always-on. No "done" / "passing" / "fixed" claim without FRESH proof captured at claim time — the actual command, its exit code, and a tree fingerprint. Recalled memory is a pointer to verify, never authoritative. Skipped steps and failures are stated plainly with output.
---
# Evidence Before Claims

> Always-on, global. Encodes METHOD.md Section 4. A status claim is a factual assertion
> about the live tree; it must be backed by proof produced NOW, not remembered.

## No claim without fresh proof

Do NOT say "done", "passing", "green", "fixed", "it works", "tests pass", or "build
succeeds" unless, **at the moment of the claim**, you have just:

- [ ] Run the ACTUAL command (the real test/build/lint invocation — not a paraphrase, not
      a subset you assume is representative).
- [ ] Observed its EXIT CODE (and quoted the relevant output: pass/fail counts, the error,
      the summary line).
- [ ] Captured a TREE FINGERPRINT tying the proof to the current state — e.g.
      `git rev-parse HEAD` plus `git status --porcelain` (or the dirty-file list), so the
      claim is anchored to exactly the code you just ran against.

If you have not done all three this turn, you may report *intent* ("I will run the tests")
but not *result* ("the tests pass").

## Proof must be current, not remembered

- [ ] A passing result from earlier in the session is STALE the moment the tree changes.
      Re-run; do not carry an old green forward across an edit.
- [ ] Do not infer success from "the change looks right" or "it should pass". Reasoning is
      a hypothesis; the command is the test.
- [ ] Quote real output. Never fabricate, round up, or reconstruct command output from
      memory — paste what actually printed.

## Memory is a pointer, not an authority

- [ ] A recalled memory entry (a learning, gotcha, runbook, or decision) is a lead to
      VERIFY against live code, never proof on its own. Code drifts; memory lags.
- [ ] Before acting on a remembered fact, confirm it still holds in the current tree
      (grep the file, read the line, run the check). Cite the live confirmation, not the
      memory, as your evidence.
- [ ] If live code contradicts memory, trust the code and flag the entry as stale.

## State gaps honestly

- [ ] If you SKIPPED a step (didn't run a suite, couldn't build, ran out of time), say so
      plainly. Do not let silence imply success.
- [ ] If a test FAILED or a command errored, report it with the actual output and exit
      code. A surfaced failure is useful; a hidden one is a defect you shipped.
- [ ] "I could not verify X" is a valid, expected outcome — and far better than an
      unbacked "X works".
