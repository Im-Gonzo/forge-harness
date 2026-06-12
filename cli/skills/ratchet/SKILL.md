---
name: ratchet
description: Run a project's gates until green or escalate — the bounded run-until-green primitive. When asked to "make CI green", "get the build passing", "fix until tests pass", or "keep going until lint is clean". Resolves the real test/typecheck/lint commands from the project profile (never hard-coded), fixes the SMALLEST failing gate one at a time, re-runs ALL gates to catch regressions, and exits either green-with-evidence or — at the iteration cap — escalates with a full ledger of attempts. Never disables a test to go green, never raises the cap instead of escalating.
---

# ratchet — run the gates until green, or escalate honestly

A ratchet only turns one way: each iteration the working tree gets *closer* to all-gates-green and
is never allowed to slip backward. This is the small, bounded run-until-green primitive — the leg a
loop body often invokes for its "fix CI" step, and the right tool any time the job is "make the
gates pass" rather than "build a new feature".

It is disciplined on three points that separate a ratchet from blind retrying:

- It fixes **one gate at a time** (the smallest failing one), so every fix is attributable.
- It claims green only from a **fresh run** — the actual command, its exit code — never from memory
  of an earlier pass ([rules/common/evidence-before-claims.md](../../rules/common/evidence-before-claims.md)).
- It is **bounded**: at the cap it escalates to a human with the full ledger of what was tried, it
  never silently gives up and never quietly raises its own cap.

> **The cardinal rule: a gate goes green by fixing the code, never by weakening the gate.** Deleting
> a failing test, `# type: ignore`-ing the error, loosening the linter config, or `--no-verify`-ing
> the commit is not convergence — it is hiding the failure (this is config-protection's spirit). A
> ratchet that "passes" by disabling the check has done negative work.

---

## When to activate

- The user wants the gates green: "make CI pass", "get the build green", "fix until tests pass",
  "clean up the lint errors", "get typecheck passing".
- A change just landed and you must drive test/typecheck/lint to green before handing off to a
  reviewer (the verification leg before review).
- As the body of a loop's "fix the failing checks" step (the **write-loop** maker often delegates
  here).
- Do **not** activate to author *new* behavior — ratchet drives *existing* gates to green; building
  a new capability is a normal implement-then-review task. Do **not** activate when the right answer
  is that the gate is wrong: if a test asserts the wrong thing, that is a re-baseline decision for a
  human / the eval loop, not something to ratchet around by deleting it.

---

## How it works

Four phases. The loop is bounded at **cap 5** by default.

### Phase 1 — Resolve the gates from the project profile (never hard-code)

1. Read the project's real commands from `.claude/profile-project.json` `#commands` — the
   `test` / `typecheck` / `lint` (and where present `build`) invocations the profiler detected.
   Never hard-code `npm test` / `pytest` / `tsc`; use what the project actually declares. If a
   command is absent from the profile, it is not a gate for this project — do not invent one.
2. Run **all** resolved gates once. Record the **failure set** — which gates failed, with their
   exit codes and the head of their output. That failure set is the ratchet's queue. If everything
   is already green, report that with the evidence and stop (an empty queue is a valid, common
   outcome — do not manufacture work).

### Phase 2 — The ratchet loop (cap 5): smallest failing gate first

```
iteration = 0
while iteration < 5 and queue is non-empty:
    pick the SMALLEST failing gate (fewest failures / narrowest scope)
    fix ONLY what that gate names — no unrelated refactor, no scope creep
    re-run THAT gate
    if it is green:
        re-run ALL gates          # a fix must not have broken a sibling gate
        rebuild the queue from the fresh results (no slipping backward)
    append this iteration to the ledger (gate, what was tried, the result)
    iteration += 1
```

Two non-negotiables: fix **one** gate per iteration (a blind multi-gate pass makes a failure
un-attributable to its fix), and after any green re-run **all** gates — the ratchet only counts a
gate as fixed if fixing it did not regress another. The queue is rebuilt from the *fresh* all-gates
run each turn, never carried forward by assumption.

### Phase 3 — Exit: green-with-evidence, or escalate-with-ledger

- **All gates green** → report success with the **fresh** evidence: each gate's exact command and
  its exit code, and the tree fingerprint, captured at the moment of the claim. Cite the ledger.
- **Cap reached, still red** → **escalate to a human.** Do not raise the cap and keep going (a
  ratchet that won't converge in 5 focused iterations has hit something a human needs to see, not a
  bound that was too low). The escalation carries the ledger: for each iteration, the gate, what was
  tried, what still fails, and your diagnosis of *why* it isn't converging. Never a silent stop and
  never a false green.

### Phase 4 — Ledger every iteration; the final report cites it

Every iteration appends a dated line to the ledger (the gate touched, the attempt, the result), so
the run is auditable whether it ends green or escalated. The final report — success or escalation —
references the ledger as its evidence trail. "Read the ledger, not just the diff": an unattended
ratchet that made a wrong turn shows it in the ledger.

---

## Anti-patterns

| PASS | FAIL |
|------|------|
| Fix the smallest failing gate, re-run it, then re-run ALL gates | Fix several gates in one blind pass — no fix is attributable to its result |
| Claim green from a fresh run with command + exit code now | Claim "it's green" from memory of an earlier run (no fresh evidence) |
| At cap 5, escalate to a human with the ledger | Raise the cap to 10/20 and keep grinding instead of escalating |
| Make the gate pass by fixing the code | Delete/`skip`/`xfail` the failing test, or `--no-verify` the commit, to go green |
| Resolve `test`/`typecheck`/`lint` from `profile-project.json#commands` | Hard-code `npm test` / `pytest`, ignoring what the project declared |
| After a green fix, re-run all gates to catch a regression | Stop after the one gate goes green, never checking it broke a sibling |
| Loosen nothing; a wrong test is escalated as a re-baseline call | Weaken the linter/tsconfig to silence the error (config-protection's spirit) |
| An already-green tree reports green and stops | Manufacture a "fix" so the ratchet looks like it did something |

## Related

- [docs/LOOPS-MODULE-DESIGN.md](../../docs/LOOPS-MODULE-DESIGN.md) §D4 — this skill's four-phase
  contract; §D6 (`stop-loop-candidate` hook) nudges toward ratchet when a turn hand-runs the same
  gate ≥3 times.
- **write-loop** skill — the loop authoring meta-skill; a loop body's "fix the failing checks" leg
  commonly invokes ratchet as its maker.
- [rules/common/evidence-before-claims.md](../../rules/common/evidence-before-claims.md) — "done"
  needs fresh proof (the command + exit code at the moment of the claim), the basis of Phase 3's
  green report.
- **run-eval** skill — when a gate fails because the *test* is wrong (not the code), the
  re-baseline decision belongs there, not in a ratchet that deletes the test.
- `rules/autonomy-ladder.md` — the cap-then-escalate boundary: a ratchet that can't converge stops
  for a human rather than escalating its own autonomy.
- `docs/METHOD.md` §4 (evidence before claims), §9 (guardrails are enforced — config-protection: fix
  the code, not the config).
