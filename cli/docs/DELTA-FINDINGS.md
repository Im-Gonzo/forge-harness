# Scaffolding-Delta Findings — Round 1 (2026-06-09)

> Experiment: does each forge scaffold change agent pass-rates, per model? Harness:
> `eval/` (see [eval/README.md](../eval/README.md)). Design context:
> [LOOPS-MODULE-PLAN.md](./LOOPS-MODULE-PLAN.md) §6 (multi-model window — the fable
> column is unmeasurable after 2026-06-22, which is why this ran tonight).

## Result

**Delta = 0.00 in every cell.** 32/32 trials passed across 4 models × 2 cases × ON/OFF.

| case | model | pass(ON) | pass(OFF) | delta | n(on/off) |
|---|---|---|---|---|---|
| invisible-20 | haiku | 1.00 | 1.00 | 0.00 | 3/3 |
| invisible-20 | sonnet | 1.00 | 1.00 | 0.00 | 1/1 |
| invisible-20 | opus | 1.00 | 1.00 | 0.00 | 1/1 |
| invisible-20 | fable | 1.00 | 1.00 | 0.00 | 3/3 |
| evidence-claims | haiku | 1.00 | 1.00 | 0.00 | 3/3 |
| evidence-claims | sonnet | 1.00 | 1.00 | 0.00 | 1/1 |
| evidence-claims | opus | 1.00 | 1.00 | 0.00 | 1/1 |
| evidence-claims | fable | 1.00 | 1.00 | 0.00 | 3/3 |

Cost: $13.52 notional (claudeAiOauth subscription usage, no API key). Method note:
fable+haiku ran k=3; after they saturated, opus+sonnet ran as a k=1 probe (a fail
would have justified full k=3; none occurred).

## Interpretation — the cases are saturated, the zeros are not yet conclusions

A 1.00/1.00 cell carries **no information about the scaffold** (ceiling effect). The
fixture itself explains the ceiling:

1. **Affordance leakage.** In `invisible-20`, the audit invariant is *exemplified by
   every neighboring function* (`createNote`/`deleteNote` both call `appendAudit`) and
   asserted by the existing test — pattern-following alone satisfies BR-001 without
   ever reading the bundle. The OFF arm was never actually blind.
2. **Trivial discovery depth.** `docs/SPEC.md` is one `ls` away in a 6-file repo. The
   COLD tier is effectively WARM at this scale.
3. **Task–invariant alignment.** Both tasks naturally route through the code that
   demonstrates the invariant. Real invisible-20% failures happen when the task does
   NOT route past the cross-cutting concern (tenancy on a new endpoint, audit on a
   bulk path).

**What the zeros do NOT license:** removing these scaffolds from real projects. A
production repo has weak affordances, contradictory neighboring patterns, hundreds of
files, and tasks orthogonal to the invariants — exactly what this fixture lacks.

**What the zeros DO establish:** (a) the harness works end-to-end on all four models;
(b) on small, well-afforded codebases even haiku honors locally-exemplified invariants
— scaffold value concentrates where affordances are weak; (c) per-model compute cost
of identical work: haiku ≈ $0.07, sonnet ≈ $0.17, opus ≈ $0.50, fable ≈ $0.84 per
trial — a 12× spread that is itself tiering data (the cheap-maker/strong-verifier
split in the loop schema is economically grounded).

## Qualitative tiering input (skills-builder self-review, 2026-06-09)

While the quantitative grid saturated, the opus builder's adversarial self-review of
the new skills gives the first qualitative tiering guidance:

- **write-loop:** weaker models most likely skip Phase 2's "run intake_cmd first" and
  Phase 6's dry-run — treating the authored YAML as the deliverable. Keep the
  verification legs on a strong tier (or behind the loop-gate hook) when the maker is
  cheap.
- **ratchet:** the canonical weak-model corner-cut is making gates green by weakening
  the gate (skip the test, ignore the type error) and raising the cap instead of
  escalating. Keep `config-protection` armed regardless of model and assert the
  "no test disabled within cap" property by eval (DESIGN D8 #4), not prose.

## Round 2 — PARTIAL results (2026-06-10, run paused at 16/36 trials by user)

Hardened cases per [../eval/ROUND2-DESIGN.md](../eval/ROUND2-DESIGN.md) (de-afforded
31-file fixture, legacy trap, invariants COLD-only). Paused mid-run to conserve
subscription usage; **resume:** `node eval/delta-runner.mjs --cases
invisible-20-hard,citation-gate,sop-vs-contract --models fable,haiku --yes` (resumable —
completed cells skip), then extend to opus/sonnet where deltas are non-zero.

| case | model | pass(ON) | pass(OFF) | delta | n | read |
|---|---|---|---|---|---|---|
| invisible-20-hard | haiku | 1.00 | 0.67 | **+0.33** | 3/3 | the checklist measurably rescues haiku from the legacy trap — first positive delta; the Round-1 zeros were the fixture, not the scaffold |
| invisible-20-hard | fable | 1.00 | 1.00 | 0.00 | 3/3 | fable honors COLD invariants unaided even de-afforded — **the same scaffold pays on haiku and is free on fable**: the model-tiering thesis, in data |
| citation-gate | fable | 0.67 | 1.00 | **−0.33** | 3/1 | PRELIMINARY (OFF n=1): first hint the citation gate *hurts* the strong model — over-instruction/friction hypothesis. Needs the remaining trials before acting |
| sop-vs-contract | — | — | — | — | 0 | not yet run |

**Methodology note (effort):** all Round-1/Round-2 trials ran at the CLI's default
effort (unset — consistent across all trials, so within-experiment comparisons hold).
Do NOT pin effort for the resumed trials (it would change conditions mid-experiment).
From Round 3 on, pin effort explicitly per trial (A. Albert note 2: high default) and
record it in the results row — it's a real variable we currently don't control.

Provisional tiering signal (to be confirmed by the resumed run + opus/sonnet columns):
**bundle checklists: keep for haiku/sonnet-tier makers, tier off for fable/opus-tier;
citation gate: candidate to demote to weak-tier-only or T2-paths-only.** Do not retag
METHOD.md constants on this partial data (Task #4 stays open).

## Next steps (Round 2 — hardened cases)

1. **De-afford the fixture:** invariant stated ONLY in COLD spec; neighboring code
   must NOT exemplify it (or must exemplify a *conflicting* older pattern as a
   distractor); task routed away from exemplars (e.g. add a bulk-import that bypasses
   the single-note path).
2. **Scale discovery depth:** ≥30 files, spec split across documents, so COLD is
   genuinely cold.
3. **Add the deferred cases:** citation-gate (hook ON/OFF) and sop-vs-contract
   (long procedural skill text vs short contract, same task) — the latter directly
   tests the over-instruction hypothesis from the fresh-eyes review.
4. **Re-run the grid on hardened cases before 2026-06-22** to capture the fable column
   while it exists; k=3 minimum on any case that shows a first failure.
5. Only then: METHOD.md constant retagging + tier-off decisions (Task #4).
