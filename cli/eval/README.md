# forge/eval — scaffolding-delta eval harness

Measures what each forge scaffold **pays for, per model**: every case runs with its
scaffold ON vs OFF (composed fixture variants), k trials per cell, via headless
`claude -p`, code-graded. `delta = pass(ON) − pass(OFF)`; delta ≈ 0 on a model means
the scaffold buys nothing there (candidate to tier off for that model); negative delta
means it actively hurts.

> **Deadline-bound:** the harness serves haiku/sonnet/opus/fable; fable is only
> available until **2026-06-22** — its column cannot be measured afterwards. Run the
> matrix before then. See `docs/LOOPS-MODULE-PLAN.md` §6.

## Run

```bash
node delta-runner.mjs --plan      # show cells + cost estimate, run nothing
node delta-runner.mjs --smoke     # cases[0] × on/off × smokeModel × k=1 (plumbing check)
node delta-runner.mjs --yes       # full matrix (resumable; cost-capped by matrix.maxCostUSD)
node delta-runner.mjs --report    # aggregate results.jsonl -> results/summary.md
```

> `--compose-only <case> <variant> <dest>` is a DEBUG-ONLY mode: it writes a fixture
> tree to an arbitrary `dest` with no containment check. Never wire it into automated
> pipelines; point it at a scratch dir under /tmp.

Resumable: completed cells (k trials present in `results/results.jsonl`) are skipped;
`--force` re-runs. The cost cap aborts mid-run, keeping completed trials.

## Layout

```
matrix.json                 models × cases × variants × k, claude args, cost caps
delta-runner.mjs            the runner (zero-dep Node)
fixture/base/               shared fixture: tiny ESM notes service, npm test, spec, constitution
cases/<case>/
  case.md                   frontmatter (scaffold, hypothesis, k) + "## Task" (the prompt)
  common/                   overlay applied to BOTH variants (e.g. the planted bug)
  on/  off/                 variant overlays (the scaffold present / absent)
  grader.mjs                code grader: node grader.mjs <trialDir> <transcript>; exit 0 = PASS;
                            last stdout JSON line = {pass, reasons}
results/                    results.jsonl + per-trial transcripts + summary.md (gitignored)
```

Fixture composition: `base` → `common` → `<variant>`, with `{{FORGE_ROOT}}` substituted
in text files (for overlays that wire forge hook scripts).

**`_claude/` convention:** overlays store agent config under `_claude/`; the composer
materializes it as `.claude/` in trial dirs only. The eval tree therefore never contains
live agent config — the fixture's constitution/settings/hooks can't be picked up by a
session working inside `forge/` itself.

## Cases

| case | scaffold measured | hypothesis |
|---|---|---|
| invisible-20 | WARM bundle checklist (METHOD §1-2) | the checklist is what keeps cross-cutting invariants honored when they only live COLD |
| evidence-claims | evidence-before-claims rule (METHOD §4) | the rule text is what forces verify-after-final-edit |

Planned next: citation-gate (edit-citation-gate hook ON/OFF), sop-vs-contract (long
procedural skill text vs short contract-style, same task).

## Adding a case

1. `cases/<name>/case.md` per the author-eval schema (+ `scaffold:` + `hypothesis:`).
2. Overlays: put the scaffold in `on/`, its absence in `off/`, shared setup in `common/`.
   Keep the OFF arm honest: the information may exist COLD (docs/), just not pushed.
3. `grader.mjs` — deterministic only here (code > model > human); prefer behavioral
   probes over greps.
4. Add the case name to `matrix.json#cases`. Prove it red somewhere before trusting it
   (author-eval discipline).
