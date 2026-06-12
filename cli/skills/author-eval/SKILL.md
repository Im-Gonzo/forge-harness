---
name: author-eval
description: Author a new golden/eval case test-first — write the expected behavior and PASS/FAIL success criteria BEFORE any implementation, fill the case schema (.claude/evals/<case>.md), classify it capability vs regression, pick the right grader (code > model > human) and the right k with a pass@k / pass^k target, and prove the case fails on today's tree before it can ever be claimed to pass.
---

# author-eval — write a golden/eval case, test-first

The companion to `skills/run-eval/`. Where `run-eval` *runs* cases, this skill *creates* one — the test-first
half of Eval-Driven Development (`docs/METHOD.md` §5): the case is written **before** the implementation, so it
encodes the intended behavior rather than rationalizing whatever the code happened to do.

> **A new case must fail first.** A case authored against already-passing code proves nothing — it could be
> asserting the trivially-true. Confirm the case is **red on today's tree** before any implementation, exactly
> as a TDD test must fail before it goes green. A case that has never been red is not yet a valid case.

Cases are first-class versioned artifacts; they live in `.claude/evals/` and ship/review with the code.

---

## When to activate

- A new capability is about to be built and has no eval yet (define behavior before coding).
- A regression slipped through: capture it as a regression case so it can never recur silently.
- An existing case is wrong (the assertion or grader was misframed) and must be re-authored + re-baselined.
- A spec-critical path lacks a `pass^k` stability case.
- Do **not** activate to *run* an existing suite — that is `skills/run-eval/`.

---

## How it works

### Phase 1 — State the expected behavior (before implementation)

1. Write, in one or two sentences, what the system **should** do — the observable behavior, not the mechanism.
   If you cannot state it without describing the implementation, the behavior is not yet understood; stop and
   clarify against the spec/BR the change implements.
2. Classify the case: **capability** (can it do the new thing) or **regression** (did a change break existing
   behavior). The class sets the default target — capability `pass@3 >= 0.90`; regression `pass^k = 1.00` on
   release-critical paths (`docs/METHOD.md` §5).

### Phase 2 — Write success criteria as checkable assertions

3. Decompose the behavior into concrete PASS/FAIL criteria. Each must be something a grader can return a verdict
   on — a command exit code, a required symbol/pattern, a schema match, or a rubric score against a stated
   threshold. Prose like "handles errors well" is not a criterion until it names *which* error and *what*
   correct handling looks like.
4. Cover more than the happy path: include at least one boundary / failure-mode criterion. Happy-path-only cases
   pass while the feature is broken in the field.

### Phase 3 — Choose the grader type (code > model > human)

5. Pick the **cheapest grader that can actually decide** the criterion:
   - **code** — deterministic; the criterion is an exit code, a pattern, a schema, a build. **Default to this.**
   - **model** — the criterion is open-ended quality a script can't judge (tone, faithfulness, reasoning). The
     grader is Claude scoring against the rubric and emitting a verdict **with reasoning** (`docs/METHOD.md` §7);
     use `bundles/eval-judge.md` to build/review that judge. Model graders add noise — pair every case with at
     least one deterministic criterion where possible.
   - **human** — the criterion is irreversible / security / tenancy / data-migration risk (`docs/METHOD.md` §3,
     T2). The grader flags `[HUMAN REVIEW REQUIRED] risk=LOW|MEDIUM|HIGH` and the case blocks on adjudication;
     set `human_gate: true` on the case.

### Phase 4 — Fill the case schema

6. Write `.claude/evals/<case>.md`. The case schema:

   ```markdown
   ---
   id: apply-transition           # slug, unique within .claude/evals/
   kind: capability               # capability | regression
   grader: code                   # code | model | human
   k: 3                           # trials per run
   target: "pass@3>=0.90"         # pass@k or pass^k threshold (pass^k for spec-critical)
   human_gate: false              # true for irreversible/security/tenancy/migration cases
   baseline: a1b2c3d              # fingerprint the case is graded against (set when first green)
   refs: ["BR-WF-014", "docs/specs/workflow.md#transitions"]   # spec/BR this case defends
   ---

   ## Behavior
   One-sentence statement of what the system should do.

   ## Success criteria
   - [ ] criterion 1 (checkable: exit code / pattern / schema / rubric+threshold)
   - [ ] criterion 2 (a boundary or failure-mode criterion)

   ## Grader
   <code> the command(s) and their PASS condition
   <model> the rubric + verdict taxonomy (PASS/FAIL or score>=threshold) + required reasoning
   <human> the risk level and what the reviewer must adjudicate
   ```

   Resolve the project's real test/build/lint commands from `.claude/profile-project.json#commands` — never
   hard-code `npm test` / `pytest`.

### Phase 5 — Prove it fails first, then hand off

7. Run the case once on today's tree (via `skills/run-eval/`, in an isolated worktree) and confirm it is **red**
   for the right reason — the behavior genuinely does not exist yet, not because the grader is broken. Record
   that red result. Only after the implementation lands do you re-run to green and write the `baseline`. Then
   hand off to `skills/run-eval/` for the continuous loop and reporting.

---

## Anti-patterns

- **PASS** — authored the case before the code and proved it red first; **FAIL** — authored it after the feature
  exists, against passing code, so it has never failed and may assert nothing.
- **PASS** — every success criterion is a checkable PASS/FAIL assertion; **FAIL** — criteria are prose ("works
  well", "handles edge cases") a grader can't return a verdict on.
- **PASS** — chose a code grader because the criterion is deterministic; **FAIL** — reached for a model grader
  for something `grep`/exit-code could decide, adding noise to the gate.
- **PASS** — a security/tenancy/migration case sets `human_gate: true` and a risk level; **FAIL** — a risky case
  graded code-only so it can auto-pass.
- **PASS** — the case includes a boundary / failure-mode criterion; **FAIL** — happy-path-only criteria that
  stay green while the feature is broken.
- **PASS** — the case cites the spec/BR it defends in `refs`; **FAIL** — an orphan case with no traceability to
  a rule, impossible to maintain when the spec changes.

## Related

- `skills/run-eval/` — run the authored case k times, grade, compute pass@k / pass^k, report with evidence.
- `bundles/eval-judge.md` — WARM context bundle for building / reviewing a model (LLM-as-judge) grader.
- `docs/METHOD.md` §5 (EDD), §7 (deterministic collection + LLM judgment), §3 (T0/T1/T2 — human-gated cases).
- `manifests/modules.json` — the `eval` module.
