# Eval-spec-as-development — method

> This corpus is written **test-first**. Each EVAL case is an *acceptance spec* that is **RED today**
> (nothing is implemented) and turns GREEN only when the corresponding code makes it pass. Development of
> a phase is "done" when that phase's `MUST` cases are GREEN. This is forge's own EDD discipline
> (`pass@k`/`pass^k`, graders `code > model > human`) turned on the manager itself.

## The loop

1. **Spec** — a dimension's `SPEC-NN` details the design; its `BR-<PREFIX>` states normative rules; each
   rule names the `EVAL-<PREFIX>-NNN` case that proves it.
2. **RED** — author the EVAL case so it fails on today's tree (the feature doesn't exist yet). An EVAL
   case that passes before any code is written is mis-specified.
3. **Build** — implement the smallest slice that turns the case GREEN, honoring the foundational
   invariants (zero-dep, additive, fail-open, dry-run).
4. **GREEN** — the case passes at its `Target` (e.g. `pass^k=1.00` for deterministic checks).
5. **Gate** — a phase ships when all its `MUST` cases are GREEN; `SHOULD`/`MAY` cases are tracked, not
   blocking.

## Case anatomy

```
### EVAL-<PREFIX>-NNN — title
- **Verifies:** BR-<PREFIX>-00x [, BR-…]      # full BR coverage is the goal
- **Kind:** capability | regression           # regression = locks a fixed defect
- **Grader:** code | model | human            # prefer code; model only when code can't decide
- **Target:** pass^k=1.00 | pass@3>=0.90 | n/a # ^k for must-always-hold; @k for capability
- **Given / When / Then:** the concrete assertion (executable intent)
- **Fixture:** what the case needs (a sample repo, a planted-defect file, a synthetic marker, …)
- **Phase:** v0.2 | v0.3 | …                   # which roadmap phase makes it GREEN
- **Status:** RED                              # all cases start RED
```

## Grader ladder (inherited from forge METHOD §5/§7)

- **code** (default) — deterministic. Most manager checks are code-graded: a registry rebuild equals the
  committed file; a dangling ref is reported; a finding parses into the right shape; a dry-run writes
  nothing. Use `pass^k=1.00` (every trial must pass) for these — they should be deterministic.
- **model** — an LLM-as-judge, only where a script genuinely cannot decide (e.g. "did the COLD discipline
  hold in this transcript"). Always paired with a deterministic floor. The judge's own `pass^k` is
  measured (`judge_cal`) and a flaky judge is pulled from the gate.
- **human** — for irreversible/trust-boundary claims; emits `[HUMAN REVIEW REQUIRED]` and blocks.

## Worktree isolation

Behavioral cases (eval-of-harness, `EVAL-EVAL`) run each trial in a throwaway `git worktree` cut from a
pinned baseline, with the *edited* artifact prompt overlaid on *stable* fixtures — exactly as
`skills/run-eval` does. Structural/code cases (most of the manager) run in-process against fixtures.

## Coverage expectation

Every `MUST` BR has at least one EVAL case. `evals/` is organized one file per dimension, mirroring
`business-rules/`. The eval-of-harness file (`EVAL-EVAL.md`) additionally specifies the *golden sets* for
the reviewer agents (planted-defect + clean-code cases) — those are the harness's own behavioral corpus,
distinct from the manager's structural cases.

## Status board (filled as cases are authored)

| Dimension | File | Cases | Phase coverage |
|---|---|---|---|
| Registry | `EVAL-REG.md` | authored in Bundle A | v0.2 |
| Versioning | `EVAL-VER.md` | authored in Bundle A | v0.2 (advisory) |
| Dependency graph | `EVAL-DEP.md` | authored in Bundle A | v0.3 |
| Fleet | `EVAL-FLEET.md` | authored in Bundle B | v0.3–v0.5 |
| Telemetry | `EVAL-TEL.md` | authored in Bundle C | v0.4 |
| Efficiency | `EVAL-EFF.md` | authored in Bundle D | v0.3 (static) / later |
| Eval-of-harness | `EVAL-EVAL.md` | authored in Bundle E | v0.4 |
| CLI & status | `EVAL-CLI.md` | authored in Bundle F | v0.2 |
| Integration | `EVAL-INT.md` | authored in Bundle F | v0.2+ |
