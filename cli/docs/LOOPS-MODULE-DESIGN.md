# Loops Module — Implementation Design

> Status: DESIGN-READY (2026-06-09) · Companion: [LOOPS-MODULE-PLAN.md](./LOOPS-MODULE-PLAN.md)
> (motivation, build sequence, multi-model constraint). This doc is the build contract:
> a builder agent should be able to implement file-by-file from here without design
> decisions. House style references are normative: skills follow `skills/run-eval/SKILL.md`
> structure; hooks follow the `hooks/edit-citation-gate.mjs` contract; validators follow
> the `lint/` conventions.

## D1. Loop definition schema (`.claude/loops/<name>.md`)

One file per loop, frontmatter + body. Generated into target projects by `write-loop`;
checksummed in `.forge.json files[]`.

### Frontmatter contract

```yaml
---
name: babysit-prs              # REQUIRED kebab-case slug; MUST equal filename minus .md
description: <one line>        # REQUIRED non-empty
intake: gh-prs                 # REQUIRED — what the loop reads. Free slug + intake_cmd
intake_cmd: "gh pr list --json number,statusCheckRollup"   # REQUIRED — deterministic discovery command
tier: T1                       # REQUIRED — T0 | T1 | T2 (autonomy-ladder.md semantics)
apply: auto                    # REQUIRED — auto | draft. INVALID: tier T2 + apply auto
maker: { skill: review-change, model: sonnet }   # REQUIRED — body executor. model OPTIONAL (haiku|sonnet|opus|inherit)
verifier: { agent: code-reviewer, model: opus }  # REQUIRED — MUST differ from maker.skill/agent. model OPTIONAL
exit:                          # REQUIRED — at least one; multiple = first reached wins
  queue-dry: true              #   intake_cmd returns zero items
  cap: 20                      #   max iterations per run (positive int)
  budget: 200000               #   max tokens per run (positive int)
escalation:                    # REQUIRED — non-empty list of named human decision points
  - "CI failure not fixed after 2 attempts on the same PR"
ledger: .claude/memory/loops/babysit-prs.md   # REQUIRED — dated evidence per run
runtime: claude-loop           # REQUIRED — claude-loop | cron | gh-actions | headless
runtime_invocation: "/loop babysit all my PRs ..."  # REQUIRED — the exact one-liner that runs it
done_eval: babysit-pr-done     # REQUIRED — the eval id the verifier grades "done" against (no ext). When a sibling .claude/evals/ exists, MUST resolve to <evals>/<done_eval>.md
---

## Body
<the per-item work, citing the forge skill/agent chain it uses>

## Verification
<what the verifier checks per item; what PASS means>
```

### Semantic rules (validator-enforced, see D2)

- maker ≠ verifier is **structural**: same skill/agent ref in both is invalid.
- `tier: T2` forces `apply: draft` — a T2 loop may PREPARE changes, never apply them.
- Every `exit` key bounded: a loop whose only exit is `queue-dry` with an unbounded
  intake also needs `cap` or `budget` (R7 below).
- `model:` hints are OPTIONAL everywhere; omitted = inherit the runtime's model. This is
  the model-tiering hook (PLAN §6): cheap maker + strong verifier is the recommended split.
- `done_eval` binds the loop to a checked-in done-definition: the eval id (no extension)
  the verifier grades each item against. REQUIRED + non-empty (R12a); when a sibling
  `.claude/evals/` exists it MUST resolve to `<evals>/<done_eval>.md` (R12b). The
  onboarding cascade (D3 Phase 0) authors this eval before the loop is written.

## D2. `lint/validate-loops.mjs`

Zero-dep Node ESM, exit 0 clean / 1 findings, same reporting shape as existing
validators. Scans `<root>/loops/*.md` (forge library) and, via `forge doctor`,
`<project>/.claude/loops/*.md`. Rules:

| # | Rule | Finding |
|---|---|---|
| R1 | frontmatter parses; all REQUIRED keys present | `loops/<f>: missing key <k>` |
| R2 | `name` kebab-case AND == filename | `name/filename mismatch` |
| R3 | `tier` ∈ {T0,T1,T2}; `apply` ∈ {auto,draft}; `runtime` ∈ enum | `invalid enum <k>` |
| R4 | `tier: T2` ⇒ `apply: draft` | `T2 loop may not auto-apply (autonomy-ladder)` |
| R5 | maker ref ≠ verifier ref | `self-verification: maker == verifier` |
| R6 | maker/verifier refs resolve (agents/, skills/ catalogs — xref style) | `unresolvable ref <r>` |
| R7 | ≥1 exit key; if only `queue-dry`, require `cap` or `budget` too | `unbounded loop` |
| R8 | `escalation` non-empty list of non-empty strings | `no human decision points` |
| R9 | `ledger` path under `.claude/memory/` | `ledger outside memory vault` |
| R10 | `model` (if present) ∈ {haiku,sonnet,opus,inherit} | `invalid model hint` |
| R11 | body has `## Body` and `## Verification` sections | `missing section` |
| R12 | `done_eval` present + non-empty (R12a); resolves to `<evals>/<done_eval>.md` when a sibling evals dir exists (R12b) | `done_eval missing or empty` / `done_eval does not resolve` |

Negative fixtures (each must FAIL validation on its OWN rule; bundle-lint pattern):
`lint/fixtures/loops/bad-self-verify.md` (R5), `bad-t2-auto.md` (R4),
`bad-no-exit.md` (R7), `bad-unbounded.md` (R7, queue-dry only),
`bad-no-done-eval.md` (R12a). Each bad fixture carries a valid `done_eval` (except the
R12a one) so it fails for its own reason, not R12. One positive fixture
`good-babysit.md` must PASS (no sibling evals dir ⇒ R12b not triggered). Wire into `lint/run-all.mjs`,
`validate-manifests` component list, and the CI workflow.

## D3. Skill: write-loop (planned — SKILL.md to be scaffolded under the skills tree)

The meta-skill — "my job is to write loops" made first-class. House style: frontmatter
(name/description), When to activate, How it works (phases), Anti-patterns (PASS/FAIL
pairs), Related.

Phases:
0. **Onboard the work-type (cascade)** — `/forge:write-loop <goal> — context: <dir>` is the
   single entry point for onboarding a new recurring work-type. Parse the goal + context-dir
   pointer; INVENTORY the dir (listing + selective reads of normative-looking files — the dir
   stays COLD, never wholesale-loaded; METHOD §1). Prerequisite check: bundle in
   `.claude/bundles/`? done-definition eval in `.claude/evals/`? Missing bundle ⇒ drive
   `new-bundle` from the inventory (INVARIANT — honest stop: if the dir has no WRITTEN
   spec/taxonomy, draft the spec WITH the user before bundling; you can't index what isn't
   written). Missing eval ⇒ drive `author-eval`: draft checkable done-criteria from the dir's
   examples, then REQUIRE user confirmation (INVARIANT — the goal is the human's; the path is
   the harness's); the confirmed eval id becomes `done_eval`. If both already exist, Phase 0
   is a one-line check — proceed, no ceremony. Then phases 1–6 run unchanged, citing the
   bundle, grading against the eval, and setting `done_eval`.
1. **Name the loop's job** — one sentence: what work it discovers and finishes. If the
   user can't state the intake and the per-item outcome, STOP — it's not loop-shaped yet.
2. **Fill the schema** — interview for intake_cmd (must be runnable now: run it once,
   show the items), tier (classify per autonomy-ladder), exits (default cap:10 +
   queue-dry), escalation points, ledger path.
3. **Pick maker + verifier from the composed catalog** — verifier MUST be a different
   agent/skill; recommend cheap-maker/strong-verifier split per the model-tiering rule.
4. **Generate the runtime invocation** — per `runtime`: `/loop <intent>` one-liner |
   crontab line | gh-actions job YAML | `claude -p` wrapper. Write it into
   `runtime_invocation` verbatim.
5. **Validate + register** — run validate-loops on the new file; add to `.forge.json
   files[]` with checksum; append a `decision` memory entry (capture-learning style)
   recording why this loop exists.
6. **Dry-run one iteration** — execute intake_cmd, take the FIRST item only, run the
   body + verifier once, write the first ledger entry. A loop that has never completed
   one verified iteration is not registered as done (run-eval's "prove it red/green"
   instinct applied to loops).

Anti-patterns: authoring without running intake_cmd (FAIL) · verifier = maker (FAIL) ·
exit-less "until done" (FAIL) · T2 loop that edits prod surfaces (FAIL) · registering
without a dry-run iteration (FAIL).

## D4. Skill: ratchet (planned — SKILL.md to be scaffolded under the skills tree)

Run-until-green primitive. Phases:
1. Resolve gates from `.claude/profile-project.json#commands` (test/typecheck/lint) —
   never hard-code; run all once; record the failure set as the ratchet's queue.
2. Loop (default cap 5): pick the SMALLEST failing gate; fix only what it names;
   re-run that gate; on green re-run ALL gates (no regression ratcheting backward).
3. Exit: all gates green (report with command + exit codes, evidence-before-claims) OR
   cap reached → escalate with the ledger of attempts (what was tried, what failed,
   diagnosis), never a silent stop.
4. Every iteration appends to the ledger; the final report cites it.

Anti-patterns: fixing multiple gates in one blind pass (FAIL) · claiming green from an
earlier run (FAIL) · raising the cap instead of escalating (FAIL) · disabling a test to
go green (FAIL — config-protection's spirit).

## D5. Rule: `rules/loop-discipline.md`

Always-on, SHORT (≤ 25 lines, HOT-tier cost). Content:
- **Rule of three:** the third manual repetition of the same workflow in a session/week
  ⇒ offer to codify it (the write-loop skill or a slash command). Cite the repetition.
- A loop's "done" claim requires its verifier's output (extends evidence-before-claims).
- Loop bodies inherit the tier gate; T2 surfaces always stop for human-apply.
- Read the ledger, not just the diff: unattended loops make unattended mistakes.

## D6. Hooks

Both follow the edit-citation-gate contract: stdin JSON payload, fail-open (any error →
stderr log + exit 0), deny via PreToolUse JSON on stdout, PROJECT-GATED on
`.claude/.forge.json`, zero-dep ESM, telemetry via `hooks/lib/telemetry.mjs` (emit-only).

### `hooks/loop-gate.mjs` (PreToolUse, matcher: Bash)

- Pattern: command matches `/\bclaude\s+(-p|--print)\b/` OR `/\bnohup\b.*\bclaude\b/`
  OR `/\bcrontab\s+-e\b/` (edit only — `-l`/`-r` are not scheduling) OR
  `/gh\s+workflow\s+run\b/`.
- ALLOW if: any registered loop's `runtime_invocation` is a substring-normalized match,
  OR the command carries `FORGE_LOOP=<name>` naming a registered loop AND contains that
  loop's `runtime_invocation` (the name alone is NOT authorization — a bare name would
  be a skeleton key for arbitrary commands; security review 2026-06-10),
  OR `<project>/.claude/loops/` doesn't exist (module not adopted).
- Else DENY with: "unattended execution without a registered loop — author it via
  /write-loop (maker/checker split + exit condition required), or prefix with
  FORGE_LOOP=<name>." **Ships in `report-only: true` mode** (PLAN §7 open question 4):
  emits the message as stderr context instead of deny until a false-positive-free week.
- State: none needed (stateless pattern match + loops dir read).

### `hooks/stop-loop-candidate.mjs` (Stop, matcher: *)

- Mirror stop-typecheck's structural contract. Scan the transcript tail's Bash commands
  (turn boundaries aren't reliably delimited in the JSONL; session-wide accumulation
  matches the rule-of-three intent);
  normalize (strip args after the binary+subcommand); if the same gate-shaped command
  (test/lint/typecheck/build family) ran ≥3 times → emit once:
  "this turn hand-ran a ratchet (<cmd> ×N) — codify: /ratchet or /write-loop."
- Never blocks. Once per turn. No state across turns (telemetry counts cover that).

## D7. Manifest wiring

`manifests/modules.json` — add:

```json
"loops": {
  "description": "Loop authorship: declarative checked-in loop definitions with structural maker/checker split, bounded exits, and tier gating. Forge authors loops; native runtimes (/loop, cron, CI, headless) execute them.",
  "components": {
    "skills": ["write-loop", "ratchet"],
    "rules": ["loop-discipline"],
    "hooks": ["loop-gate@PreToolUse", "stop-loop-candidate@Stop"],
    "validators": ["validate-loops"]
  }
}
```

(`babysit` ships v1.1 after write-loop+ratchet are dogfooded — PLAN §7 Q2 resolved: defer.)

`manifests/profiles.json` — `moduleSelectionRules`: include `loops` when
`facts.hasTests == true` (the profiler's materialized test signal; a `facts.ci` leg can
be added when the profiler emits one); always offerable opt-in.
`hooks/hooks.json` — add both hooks with descriptions per house style (loop-gate
marked PROJECT-GATED + report-only default).

## D8. Eval cases (RED-first, per author-eval)

Authored BEFORE implementation; each must fail on today's tree:
1. `loops-schema-rejects-self-verify` — validate-loops on bad-self-verify fixture exits 1
   citing R5. (Code grader. RED today: validator doesn't exist.)
2. `loops-schema-rejects-t2-auto` — R4 fixture, same shape.
3. `write-loop-dry-runs` — invoking write-loop on a toy repo produces a loop file that
   passes validate-loops AND a ledger with one dated entry. (Code grader, RED today.)
4. `ratchet-converges` — repo with 2 planted gate failures: ratchet exits green within
   cap, ledger shows ≤ cap iterations, no test deleted/skipped. (Code grader, RED today.)
5. `loop-gate-reports` — loop-gate given a synthetic `claude -p` payload with no
   registered loop emits the steer message; with FORGE_LOOP=<registered> stays silent.
   (Code grader piping fixture payloads, RED today.)

## D9. Out of scope (explicit)

- No daemon, watcher, or scheduler inside forge (ADR-0010) — `runtime_invocation` hands
  off to native runtimes.
- No babysit skill in v1 (deferred).
- Telemetry rule-of-three SessionStart nudge (PLAN §4.6) — v1.1, needs telemetry-window
  queries that don't exist yet.
- Ledger↔memory-confidence integration (PLAN §7 Q3): v1 ledgers are plain dated entries
  under `.claude/memory/loops/`; `loop-run` as a first-class memory type is deferred to
  the memory module's next revision.
