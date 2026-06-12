# Loops Module — Implementation Plan

> Status: DRAFT (2026-06-09) · Not yet started · Companion research: Boris Cherny's
> "my job is to write loops" (Lenny's Podcast 2026-02-19; Acquired/WorkOS 2026-06-02)

## 1. Motivation

Cherny's three-stage ladder: (1) hand-coding → (2) parallel prompting → (3) loop
authorship — "I don't prompt Claude anymore. I have loops running. They're the ones
prompting Claude and figuring out what to do. My job is to write loops."

A loop = a small program that **discovers work → dispatches a chunk → verifies the
result → repeats** until queue-dry / budget-exhausted / human-judgment decision point.

Forge already owns the half Cherny calls the binding constraint — **verification**
(dual-review, run-eval, autonomy ladder, evidence-before-claims). What forge has zero
of is the **automation half**: triggers, recurrence, queues, ratchets. This module adds
it — without violating ADR-0010.

## 2. Design constraints (binding)

- **ADR-0010 (fail-open, no daemon):** forge does not RUN loops. Forge makes loop
  *authoring* first-class and targets native runtimes for execution (Claude Code's native loop command,
  scheduled tasks/cron, GitHub Actions, headless `claude -p` in CI).
- **Maker ≠ checker is structural, not advisory:** enforced by schema, not prose.
- **Autonomy ladder applies inside loop bodies:** T2 surfaces never auto-apply, even
  mid-loop. The draft/apply split survives automation.
- **Paved road over coercion:** hard gates only on unsafe loops and unregistered
  unattended execution; manual work is never blocked.
- **EDD:** every component lands eval-first (author-eval RED case before
  implementation), per the forge method.

## 3. Module definition

`manifests/modules.json` — new key:

```json
"loops": {
  "description": "Loop authorship: declarative checked-in loop definitions with structural maker/checker split, exit conditions, and tier gating. Forge authors loops; native runtimes (/loop, cron, CI) execute them.",
  "components": {
    "skills": ["write-loop", "ratchet", "babysit"],
    "rules": ["loop-discipline"],
    "hooks": ["loop-gate@PreToolUse", "stop-loop-candidate@Stop"],
    "validators": ["validate-loops"]
  }
}
```

`manifests/profiles.json` — selection rule: include when `facts.commands.test` or CI
config detected; always offerable via explicit opt-in.

## 4. Components

### 4.1 Loop registry + schema (the contract)

`.claude/loops/<name>.md` — one file per loop, checked into git, checksummed in
`.forge.json files[]`. Required frontmatter keys:

| Key | Constraint | Enforces |
|---|---|---|
| `name` | kebab-case, unique | identity |
| `intake` | what the loop reads (PRs, CI, issues, Slack MCP, test output) | explicit discovery surface |
| `body` | the per-item work, citing the skill/agent chain it uses | reuse of forge catalog |
| `verifier` | agent ref, **MUST differ from body's maker agent** | maker/checker split |
| `exit` | one of `cap:<n>` \| `budget:<tokens>` \| `queue-dry` \| `schedule-end` | no exit-less loops |
| `tier` | T0 \| T1 \| T2; **`tier: T2` + `apply: auto` is invalid** | autonomy ladder |
| `escalation` | named human decision points | humans gate judgment |
| `ledger` | memory path where each run writes dated evidence | evidence-before-claims |
| `runtime` | target executor: `claude-loop` \| `cron` \| `gh-actions` \| `headless` | ADR-0010: forge doesn't run it |

### 4.2 Validator: `validate-loops`

Pattern-clone of `validate-bundles` (required-keys + negative fixture). Rejects:
missing keys, self-verification (verifier == maker), exit-less loops, T2+auto-apply,
unresolvable verifier/skill refs (xref). Wired into core validator list,
`harness-doctor`, and the generated CI workflow.

### 4.3 Skills

- **`write-loop`** (meta-skill, the centerpiece): interview → fill schema → pick
  verifier from the project's composed agent catalog → choose exit + tier → generate
  the runtime one-liner (`/loop …` invocation, cron entry, or GH Action job) →
  validate → register checksum. One shot from intent to runnable loop.
- **`ratchet`**: run-until-green primitive. Reads gate commands from
  `profile-project.json` (`commands.test`, `commands.typecheck`, `commands.lint`);
  loop body = run gates → fix smallest failing thing → re-run; exit = all green OR
  `cap:N` → escalate with the failure ledger. The goal-command-style validator exit,
  forge-flavored.
- **`babysit`**: Cherny's canonical example, gated. Poll open PRs/CI via `gh` →
  auto-fix build failures (T1) → per review comment, dispatch an isolated worktree
  agent → re-request review. T2 surfaces in any fix → draft + stop.

### 4.4 Rule: `loop-discipline` (always-on, short)

1. **Rule of three** — the third manual repetition of a workflow triggers an offer to
   codify it as a loop/skill.
2. No "done" claim from a loop without grader/verifier output (extends
   evidence-before-claims).
3. Loop bodies inherit tier gates; T2 always stops for human-apply.
4. "Unattended loops make unattended mistakes" — read the ledger, not just the diff.

### 4.5 Hooks

- **`loop-gate@PreToolUse`** (Bash matcher, project-gated, fail-open): pattern-match
  unattended execution (`claude -p`, `nohup claude`, crontab edits, `gh workflow run`
  of agent jobs) → block unless a registered loop def is referenced; steer to
  the write-loop skill. Closes the hand-rolled while-true bypass.
- **`stop-loop-candidate@Stop`** (mirror of `stop-typecheck`, report-only): detect ≥3
  same-gate-command repetitions in the turn → "this was a ratchet; codify it." Once
  per turn, never blocks.

### 4.6 Telemetry + SessionStart rule-of-three

Extend `invoke-telemetry` records with a loop-run tag; extend `detect-project`
SessionStart nudge: if the same skill/command was invoked ≥N times in M days and no
loop covers it → one-line offer. (Nudge-only; respects the existing
once-per-session/staleness discipline.)

### 4.7 Doctor / sync / CI wiring

- `harness-doctor`: loops section — **zombie** (def checksum drifted vs running
  schedule), **orphan** (no ledger entries in N days), **broken verifier** (xref
  fails).
- `harness-sync`: loop defs ride the existing checksum-guarded upgrade/merge path.
- CI template: run `validate-loops`; loop-authored PRs must attach run ledger
  (loop name, verifier, grader output). Review the evidence, not just the diff.

## 5. Build sequence (each phase gated on validators green + RED eval authored first)

| Phase | Deliverable | Gate |
|---|---|---|
| 0 | RED eval cases for schema, validator, each skill (author-eval) | cases fail on today's tree |
| 1 | Loop schema + `validate-loops` + negative fixtures | validator green on fixtures |
| 2 | `write-loop` skill + registry + marker/sync wiring | end-to-end: intent → valid registered loop |
| 3 | `ratchet` + `babysit` skills | dogfood: ratchet on forge's own validator suite |
| 4 | `loop-discipline` rule + both hooks | hooks fail-open verified; gate blocks unregistered `claude -p` |
| 5 | Telemetry/SessionStart + doctor/sync/CI wiring | doctor reports zombie/orphan correctly |
| 6 | modules.json + profiles.json registration; dual-review the whole module | both reviewers APPROVE |

## 6. Multi-model constraint (added 2026-06-09)

The harness serves **haiku, sonnet, opus, and fable simultaneously**; fable is only
available until **2026-06-22**. Consequences for this module and the wider realignment:

- **Tier scaffolds, don't strip them.** Every "this scaffold is overhead on a stronger
  model" finding becomes a *model-conditional* setting, not a deletion. Hooks can read
  the model from their payload and self-gate (e.g. edit-citation-gate: enforce for
  haiku/sonnet, relax for opus/fable). Loop defs gain an optional `model:` hint —
  body model vs verifier model chosen independently.
- **Scaffolding-delta evals are deadline-bound.** Run the ON/OFF matrix across all four
  models BEFORE Jun 22 — the fable column cannot be measured afterwards. The data
  outlives the model.
- **Spend fable on authorship, not execution.** Fable writes the evals, loop
  definitions, workflow scripts, and verifier prompts; cheaper models run the loop
  bodies after Jun 22. (Cherny's loop-author/loop-body split, applied to model budget.)

## 7. Open questions

1. Loop def format: frontmatter-MD (consistent with bundles) vs JSON (machine-first)?
   → leaning MD + frontmatter, consistent with everything else forge renders.
2. Should `babysit` ship in v1 or follow once `write-loop`+`ratchet` are dogfooded?
3. How does the ledger interact with the memory module's confidence dynamics —
   are loop runs `runbook` entries or a new `loop-run` type?
4. `loop-gate` matcher precision: blocking `claude -p` too aggressively would punish
   legitimate one-off headless use. Start report-only, promote to block after a
   false-positive-free week?
