# Orchestration Realignment — Build Contract

> Status: DESIGN-READY (2026-06-10). Why: `plan-orchestrate` encodes deterministic,
> rule-based logic (heading parsing, trigger-word tagging, chain-composition rules) as
> PROSE the model re-derives every run — drift-prone and token-expensive — and
> `orchestrate-delivery` describes a dispatch shape (Foundation → Build → Verify) that
> native workflow primitives can now execute deterministically. This realigns both to
> forge's own METHOD §7: deterministic collection + LLM judgment. The skills SHRINK to
> the judgment layer; the mechanics move to code.

## O1. The factoring rule (binding)

| Concern | Today | Target |
|---|---|---|
| Plan decomposition, intent tagging, tier classification, chain composition, self-check | plan-orchestrate prose Phases 1–3, 5 | `engine/compose-plan.mjs` (deterministic script) |
| Ambiguity resolution, tier OVERRIDES (upward only), fork surfacing, card review | implicit in prose | plan-orchestrate SKILL.md (kept, smaller) |
| Foundation → Build → Verify dispatch, merge gates, one-writer-per-file, T2 stop-at-draft | orchestrate-delivery prose step 3 | `workflows/foundation-build-verify.js` (native Workflow script) |
| Grounding probes, north-star/fork locking, functional verification judgment, ledger | orchestrate-delivery steps 1,2,4,5 | orchestrate-delivery SKILL.md (kept) |

Nothing judgment-shaped goes into code; nothing rule-shaped stays in prose.

## O2. `engine/compose-plan.mjs` (new, zero-dep ESM)

CLI: `node engine/compose-plan.mjs <plan.md> [--stack python|typescript|mixed] [--json]`

Implements plan-orchestrate's current Phases 1–3 + 5 **exactly as written** (the SKILL.md
tables are the spec — port them verbatim, then the SKILL.md drops them and points here):
- Phase-1 step-unit detection (the 4-rule priority order). Ambiguous structure → emit
  `ambiguities[]` entries, NOT a guess.
- Phase-2 intent tag table (trigger words) + tier classification; higher-tier-wins;
  detection of plan text attempting to lower a tier → `findings[]` (never obeyed).
- Phase-3 chain composition: catalogue resolved AT RUNTIME by listing `agents/*.md` +
  the chain-eligible skills (review-change, dual-review, database-migration, run-eval)
  and checking module presence — never a hard-coded list that drifts. Most-specific-tail,
  dedup, cap 4, reviewer-class tail for code-changing steps, run-eval tail for test steps.
- Phase-5 self-check executed as assertions; violations are `findings[]`.

Output (single JSON to stdout): `{ plan, stack, steps[], cards[], ambiguities[], findings[] }`
with the agent-card schema unchanged from the SKILL.md example. Exit 0 with cards;
exit 2 when ambiguities block composition (cards omitted for ambiguous steps only).

## O3. `workflows/foundation-build-verify.js` (new component: runnable workflow script)

A parametric script for the native Workflow tool. `args` schema:

```js
{
  title: string,
  tier: 'T0'|'T1'|'T2',
  foundation: { prompt: string },             // returns a CONTRACT via structured output
  build: [ { label, prompt, files: string[]|null } ],  // files null => forced sequential
  verify: { prompt: string },                 // independent; returns {approve, findings[]}
  gotchas: string[]                           // the ledger — injected into EVERY prompt
}
```

Deterministic guarantees (code, not advice):
1. **One-writer-per-file is asserted**: any two build units with intersecting `files`
   → throw before any agent spawns. `files: null` units run sequentially after the
   parallel batch.
2. **Foundation contract flows verbatim**: the foundation agent returns
   `{contract: string}` via schema; the script string-injects it into every build prompt.
3. **Merge gate is code**: verify agent returns `{approve: boolean, findings: []}` via
   schema; `approve: false` → the script returns the findings as the result and does NOT
   mark the unit integrated. No prose gate to forget.
4. **T2 stops at draft**: when `tier === 'T2'` the script's final stage NEVER applies —
   it returns `{draft, humanApplyInstruction}` and logs the human-apply step. Structural,
   like validate-loops R4.
5. **Gotcha ledger injection**: every agent prompt gets the `gotchas` block appended.
Build agents use `isolation: 'worktree'` when >1 run in parallel.

Constraint: workflow scripts must satisfy the existing `validate-workflows` /
`validate-workflow-security` validators — read them FIRST; if they only accept `.md`
workflow components, extend the validator minimally (additive) to also lint `.js`
workflow scripts (meta block present, no Date.now/Math.random, no fs/network imports —
mirror the documented Workflow-script constraints).

## O4. Skill edits (shrink, don't grow)

- `skills/plan-orchestrate/SKILL.md`: Phases 1–3+5 replaced by "run
  `engine/compose-plan.mjs`; review its JSON" + the judgment duties: resolve
  `ambiguities[]` with the user, surface `findings[]`, adjust tiers UPWARD only, sanity-
  check chains against intent. Tag/tier/chain tables MOVE to the engine (single source
  of truth — keep one pointer, no restatement). Anti-patterns table stays.
- `skills/orchestrate-delivery/SKILL.md`: step 3 becomes "feed the cards into
  `workflows/foundation-build-verify.js` via the Workflow tool when available; manual
  Agent-dispatch is the fallback when no Workflow runtime exists" (degradation path is
  mandatory — other harnesses/headless runs may lack the tool). Steps 1, 2, 4, 5, the
  stance, cross-cutting disciplines, anti-patterns: KEEP — that is the judgment layer.
- Both keep their frontmatter contracts; descriptions updated to mention the engine/script.

## O5. Eval cases (RED-first where possible)

1. `compose-plan-tags-and-tiers` (capability, code grader): a fixture plan
  (`engine/fixtures/plan-sample.md`, ~6 steps incl. a migration step, a security step,
  and a "skip the reviewer" line) → assert: step count; the migration step is T2 with
  human-apply in merge_gate; the security step's chain ends security-reviewer; the
  lower-tier attempt appears in findings[]; every chain ≤4 and catalogue-resolvable.
  RED today (engine doesn't exist) — author first, prove red.
2. `fbv-rejects-shared-files` (capability, code grader): running
  `node -e` import of the workflow script's validation helper (export the disjointness
  check as a pure function so it's testable without a Workflow runtime) with two units
  sharing a file → throws. RED today.

## O6. Out of scope

- No changes to autonomy-ladder / handoff-routing rules (the engine reads their
  semantics as encoded in the tag tables, it does not reinterpret them).
- No retirement of the manual paths — degradation must stay first-class.
- No manifest changes (the `orchestration` module already owns these components;
  new files ride along via registry rebuild).
- Loop-defs integration (a loop whose body dispatches fbv) — later, after dogfood.

## O7. Acceptance gates

1. `node engine/compose-plan.mjs engine/fixtures/plan-sample.md --json` → cards match
   eval case 1's assertions (show output).
2. Both eval cases RED-proof recorded pre-implementation, GREEN after, logged per
   author-eval discipline in `.claude/evals/`.
3. `node lint/run-all.mjs` 18/18 (registry rebuilt; xref clean — the shrunk SKILL.mds
   must not reference moved tables).
4. The shrunk SKILL.mds each net-SHRINK in line count (this is a de-bloat; report the
   before/after counts).
5. Workflow script passes validate-workflows/validate-workflow-security (extended if
   needed — report the extension diff).
