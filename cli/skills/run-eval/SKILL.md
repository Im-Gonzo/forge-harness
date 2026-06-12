---
name: run-eval
description: Run a project's eval suite the Eval-Driven Development way — define expected behavior FIRST, run capability + regression evals through code/model/human graders, isolate each trial in a git worktree, then report pass@k and pass^k (pass^k for spec-critical paths) with a fresh error-analysis loop. Evidence before claims; no green claimed from memory.
---

# run-eval — the Eval-Driven Development loop

Evals are the unit tests of agent work (`docs/METHOD.md` §5). This skill runs the loop: behavior is
defined **before** code, evals run **continuously**, regressions are **tracked**, and reliability is reported
as **pass@k** / **pass^k**. It honors **evidence before claims** (`docs/METHOD.md` §4) — a "passing" claim is
backed by the actual command, its exit code, and the tree fingerprint, re-run at the moment of the claim, never
remembered from an earlier run.

> **The cardinal rule: define before you implement.** If the expected behavior is not written down as a case
> before the code is written, you are not doing EDD — you are rationalizing whatever the code happened to do.
> When no case exists for the change in flight, STOP and author one first (see `skills/author-eval/`).

Artifacts live under `.claude/evals/` in the target project (layout below). Resolve the project's real test /
build / lint invocations from `.claude/profile-project.json#commands` — never hard-code `npm test` / `pytest`;
use what the profiler detected.

---

## When to activate

- A change is in flight and you need to prove it does the new thing **and** broke nothing.
- A prompt, agent, rule, or model version changed and you must re-baseline reliability.
- You are gating a release: spec-critical paths must show `pass^k = 1.00`.
- An eval is **flaky** and you need the error-analysis loop to localize the cause.
- Do **not** activate to *author* a new case — that is `skills/author-eval/`. This skill *runs* cases.

---

## How it works

### Phase 1 — Define expected behavior (before any implementation)

1. Locate (or author) the case for the change. Capability evals answer *can it do the new thing*; regression
   evals answer *did this change break existing behavior* (`docs/METHOD.md` §5). Every case names its grader
   (code / model / human) and its target — `pass@3 >= 0.90` for capability, `pass^k = 1.00` for regression on
   release-critical paths.
2. Write the success criteria as checkable assertions, not prose. If you cannot phrase a criterion as something
   a grader can return PASS/FAIL on, it is not yet a criterion.
3. Record the **baseline**: the tree fingerprint (`git rev-parse HEAD`, or `git stash create` for a dirty tree)
   the evals run against, so regression deltas are attributable.

### Phase 2 — Isolate every trial in a git worktree

4. EDD trials are non-deterministic, so each trial runs in its own throwaway git worktree cut from the pinned
   baseline commit — no Docker required. This is the reproducibility-isolation guarantee: trials cannot corrupt
   the base repo or interfere with each other (ported from the agent-eval harness).

   ```bash
   base=$(git rev-parse HEAD)
   wt=$(mktemp -d)
   git worktree add --detach "$wt" "$base"
   # ... run the case + graders inside "$wt" ...
   git worktree remove --force "$wt"
   ```

5. Run the **same** case `k` times (k = the case's declared k, default 3). Trials are independent; never reuse a
   worktree across trials of the same case.

### Phase 3 — Grade with the right grader type

6. **Code grader (deterministic — prefer this).** A script or command returns the verdict: the project's
   `commands.test`, a `grep` for a required symbol, a build that must succeed. Deterministic > probabilistic;
   reach for a model grader only when behavior quality cannot be captured by an assertion.
7. **Model grader (Claude-as-judge with reasoning).** For open-ended output, Claude scores against the case's
   rubric and must emit a verdict **plus its reasoning**. Use a strict verdict taxonomy (PASS / FAIL / one
   numeric score with a stated threshold) — `docs/METHOD.md` §7: deterministic collection, then LLM judgment
   over it. A bare score with no reasoning is an invalid grade.
8. **Human grader (flag with risk level).** For irreversible / security / tenancy / data-migration paths, the
   grader does not auto-pass: it emits `[HUMAN REVIEW REQUIRED] risk=LOW|MEDIUM|HIGH` and the case is **blocked**
   until a human adjudicates. Never silently auto-pass a human-gated case (`docs/METHOD.md` §3, T2).

### Phase 4 — Compute pass@k and pass^k

9. From the `k` trial verdicts compute, per case:
   - **pass@k** — at least one of k trials passed (`>=1` success). Reports practical reliability under retry.
   - **pass^k** — all k trials passed. The stability bar; **use pass^k for spec-critical paths and release
     gates**, where one flaky failure is one failure too many.
   - **pass@1** — the first-attempt rate, reported alongside as raw reliability.

   ```text
   case: apply-transition (k=3)   trials: PASS PASS PASS   pass@1=1.00  pass@3=1.00  pass^3=1.00
   case: summarize-thread (k=3)   trials: PASS FAIL PASS   pass@1=0.67  pass@3=1.00  pass^3=0.00
   ```

### Phase 5 — Error-analysis loop (on any failure or flake)

10. A red or flaky case triggers the loop, not a silent retry: read the failing trial's diff and grader output
    **inside its worktree**, name the concrete failure mode, and decide — is it the **code** (fix the code), the
    **case** (the assertion was wrong → fix the case, re-baseline), or the **grader** (flaky/over-strict grader
    → fix the grader)? A flaky grader is never allowed to gate a release. Loop until the case is green for the
    right reason, then re-run the full `k` to confirm stability.

### Phase 6 — Report with fresh evidence

11. Emit the report from a fresh run at the moment of the claim — never from memory. The report MUST carry: per
    case the grader type, k, the trial verdicts, pass@1 / pass@k / pass^k; the regression set's aggregate; the
    **baseline fingerprint**; the exact commands run with their exit codes; and the status verdict. Append the
    run to `.claude/evals/<case>.log` and, at a release, snapshot to `.claude/evals/summary.md`.

    ```text
    EVAL REPORT  baseline=a1b2c3d  ts=2026-06-05T..Z
    Capability:  3/3 cases pass@3>=0.90  (apply-transition 1.00, summarize 1.00, validate 0.93)
    Regression:  5/5 cases pass^3=1.00   (release-critical paths green)
    Human-gate:  1 case BLOCKED (risk=HIGH) — awaiting adjudication
    Commands:    `pytest -q` -> exit 0 ;  `tsc --noEmit` -> exit 0
    Status:      NOT READY — 1 human-gated case pending
    ```

---

## `.claude/evals/` artifact layout

```text
.claude/evals/
  <case>.md            # case definition: task, success criteria, grader type, k, target threshold
  <case>.log           # append-only run history (one line/block per run, with baseline fingerprint)
  baseline.json        # regression baselines: case -> last-green fingerprint + verdicts
  summary.md           # release snapshot (regenerated at each release gate)
```

Evals are first-class, versioned artifacts — they ship and review with the code that satisfies them, never as a
throwaway scratch file.

---

## Anti-patterns

- **PASS** — wrote the case + success criteria *before* the implementation; **FAIL** — wrote the eval after the
  code, retrofitting it to whatever the code already did (that measures nothing).
- **PASS** — claimed green from a fresh run shown with command + exit code + baseline fingerprint; **FAIL** —
  claimed "evals pass" from memory of an earlier run (violates `docs/METHOD.md` §4).
- **PASS** — used `pass^k = 1.00` to gate a spec-critical / release path; **FAIL** — gated a release on `pass@k`
  alone, letting a path that fails 1-in-3 ship.
- **PASS** — each trial isolated in its own worktree from the pinned baseline; **FAIL** — ran trials in the live
  working tree, letting one trial's writes contaminate the next.
- **PASS** — a flaky grader is fixed or pulled from the gate; **FAIL** — a flaky grader is left in the release
  gate and "passes" by luck on the run that counts.
- **PASS** — a human-gated case emits `[HUMAN REVIEW REQUIRED]` and blocks; **FAIL** — auto-passing a
  security / tenancy / migration case to keep the suite green.
- **PASS** — model grader returns a verdict **with** reasoning against the rubric; **FAIL** — a bare numeric
  score with no reasoning and no stated threshold.

## Related

- `skills/author-eval/` — author a new golden/eval case test-first (the case schema + choosing the grader).
- `bundles/eval-judge.md` — WARM context bundle for building / reviewing a model (LLM-as-judge) grader.
- `docs/METHOD.md` §5 (EDD), §7 (deterministic collection + LLM judgment), §4 (evidence before claims),
  §3 (T0/T1/T2 autonomy — human-gated cases).
- `manifests/modules.json` — the `eval` module (`run-eval`, `author-eval`, `eval-judge`).
