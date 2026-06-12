---
name: write-loop
description: Author a checked-in loop definition for recurring/automated work — when the user wants to "babysit X", "keep Y green", "every morning do Z", run something on a schedule, codify a workflow they keep repeating by hand, "onboard a new research stream / work-type", or "set up X workflow from this folder". The single entry point for onboarding a recurring work-type: it cascades bundle → eval → loop from a goal + context dir. Names the job, fills the loop schema, picks a cheap maker + a DIFFERENT strong verifier, writes the exact runtime invocation, validates + registers, then proves it with one dry-run iteration. Forge authors the loop; native runtimes (/loop, cron, CI, headless) execute it.
---

# write-loop — make "my job is to write loops" first-class

Recurring work is its own work-type. When someone says "babysit my PRs", "keep the suite green
every morning", "triage new issues on a cron", or you catch yourself running the same workflow a
third time by hand, the right move is not to do the work again — it is to **author a loop** and
hand execution to a native runtime. This skill turns a vague "keep doing X" into a declarative,
checked-in loop definition that a validator can lint and a runtime can run unattended **safely**:
a structural maker/checker split, bounded exits, named human escalation points, and a tier gate.

Forge does **not** run loops (no daemon or scheduler lives here — see the design doc's out-of-scope
section). It *writes* them and emits the exact one-liner that hands off to the runtime the user
already has: the native loop command, `crontab`, a GitHub Actions job, or a `claude -p` headless
wrapper.

> **The cardinal rule: never register a loop that has not completed one verified iteration.** A
> loop that has never run its body + verifier once against a real first item is a guess, not a
> tool. This is the run-eval "prove it red/green" instinct applied to loops — Phase 6 is not
> optional.

The loop definition's schema is the single source of truth and lives in exactly two places — do
not restate it here:

- [docs/LOOPS-MODULE-DESIGN.md](../../docs/LOOPS-MODULE-DESIGN.md) **§D1** — the frontmatter
  contract, every REQUIRED key, and the semantic rules (maker ≠ verifier, T2 ⇒ draft, bounded
  exits, model hints).
- [lint/validate-loops.mjs](../../lint/validate-loops.mjs) — the executable enforcement of §D1
  (the D2 rule table R1–R11). If it passes there, it is well-formed; if it fails, fix the file,
  not the validator.

A worked, valid example is [lint/fixtures/loops/good-babysit.md](../../lint/fixtures/loops/good-babysit.md) —
read it as the output shape, then fill it for the user's job.

---

## When to activate

- The user wants **recurring or automated** work: "babysit my PRs", "keep CI green", "every
  morning triage new issues", "poll the deploy until it's done", "run this on a cron".
- The user wants to **onboard a new recurring work-type / research stream** from a folder of
  source material: "onboard a new research stream", "set up the X workflow from this folder",
  `/forge:write-loop <goal sentence> — context: <dir>`. This is the cascade entry point
  (Phase 0): the same skill stands up the bundle and the eval the loop needs before authoring
  the loop itself.
- The user asks to **codify a workflow they keep repeating** — the third manual repetition of the
  same loop in a session/week is the cue (the rule-of-three; cite the repetition).
- A workflow is about to be handed to `claude -p` / `nohup claude` / `crontab` / `gh workflow run`
  for unattended execution and there is no registered loop for it yet.
- Do **not** activate for a one-off task — running a command once is not a loop. If the user can't
  name both the intake (what it discovers) and the per-item outcome (what "done" means for one
  item), it is not loop-shaped yet (Phase 1 stops you).
- Do **not** activate to *run* an existing loop — that is the runtime's job; this skill only
  authors the definition and its first dry-run.

---

## How it works

Phase 0 onboards a new work-type when one isn't set up yet; phases 1–6 author the loop. Each
phase is a gate: do not advance until the current one holds.

### Phase 0 — Onboard the work-type (cascade: bundle → eval → loop)

**Objective.** Turn `/forge:write-loop <goal sentence> — context: <dir>` into a loop that
stands on a real WARM bundle and a confirmed done-definition eval — authoring those two
prerequisites first if they're missing, so the loop body has something to cite and the
verifier has something to grade against.

**Invariants (hold no matter the path):**

- **Honest stop — you cannot index what isn't written.** If the context dir contains *examples
  only* and **no written spec/taxonomy/schema**, STOP and draft the spec file **with the user**
  before bundling. Surfacing that the normative text doesn't exist yet is a **deliverable, not a
  failure** — bundling over absent normative text would produce a bundle that points at nothing.
- **The human owns the goal; the harness owns the path.** The done-criteria you draft from the
  dir's examples are a *proposal*. You **REQUIRE the user's confirmation** of those criteria
  before they become the eval — never auto-adopt criteria you inferred. The confirmed eval's id
  becomes the loop's `done_eval`.
- **The context dir stays COLD.** Inventory is a listing plus *selective* reads of
  normative-looking files (taxonomy / spec / schema / a representative example) — **not** a
  wholesale load. Pull deeper from the dir just-in-time during bundling, by reference
  (`docs/METHOD.md` §1 — HOT/WARM/COLD).
- **Already-onboarded ⇒ no ceremony.** If a bundle for this work-type and a done-definition eval
  both already exist, Phase 0 is a **one-line check** — note both, then proceed straight to
  Phase 1.

**Mechanics (lean):**

1. Parse the **goal** sentence and the **context-dir** pointer from the ask.
2. **Inventory** the dir (listing + selective normative reads, per the COLD invariant).
3. **Prerequisite check:** is there a bundle for this work-type in `.claude/bundles/`? a
   done-definition eval in `.claude/evals/`?
4. **Missing bundle** ⇒ drive `new-bundle` using the inventory as its pointers + invisible-20
   checklist input (honoring the honest-stop invariant first).
5. **Missing eval** ⇒ drive `author-eval`: draft checkable done-criteria from the dir's
   examples, get the user's confirmation, register the eval. Its id is the loop's `done_eval`.

**Verification.** Phase 0 is done when both prerequisites resolve on disk: `node
lint/validate-bundles.mjs` passes for the new/existing bundle, and `.claude/evals/<done_eval>.md`
exists (the same file R12b later checks the loop's `done_eval` against). If the honest stop
fired, the spec file the user co-authored exists in the context dir before bundling resumes.

### Phase 1 — Name the loop's job (one sentence)

Write one sentence: **what work the loop discovers, and what finishing one item looks like.** If
the user cannot state both the intake and the per-item outcome, **STOP** — it is not loop-shaped
yet, and authoring a definition would just encode confusion. A loop is "discover N items, finish
each, stop when none remain or a bound is hit" — if there is no discoverable queue and no per-item
"done", route the user back to a single task or a slash command instead.

### Phase 2 — Fill the schema (interview, do not assume)

Walk §D1's REQUIRED keys with the user. The non-obvious ones:

1. **`intake` + `intake_cmd`** — the deterministic discovery command. It MUST be runnable *now*:
   run it once, show the user the items it returns. An intake you have not executed is a guess; an
   intake that returns nothing tells you the loop will exit immediately (which may be correct).
2. **`tier`** — classify per [rules/autonomy-ladder.md](../../rules/autonomy-ladder.md) by the
   loop body's blast radius, not its difficulty. T0 read-only; T1 reversible leaf change behind a
   reviewer; T2 if the body ever touches an irreversible / security / tenancy / migration surface.
   When in doubt, climb a rung.
3. **`apply`** — `auto` only for T0/T1. **`tier: T2` forces `apply: draft`** (the validator rejects
   T2 + auto): a T2 loop may PREPARE changes every iteration but a human applies them. The split is
   the safety mechanism, not bureaucracy.
4. **`exit`** — at least one bound. Default to `cap: 10` **plus** `queue-dry: true` so the loop
   stops both when the work runs out and when it has run too long. A `queue-dry`-only exit over an
   unbounded intake is rejected (it can run forever) — always pair it with `cap` or `budget`.
5. **`escalation`** — name the concrete human decision points ("CI still red after 2 attempts on
   the same PR", "review surfaces a security finding"). This list is non-empty by contract.
6. **`ledger`** — a path under `.claude/memory/loops/`. Every run appends a dated evidence entry
   here; the loop's "done" claim is read from it, not from memory.
7. **`done_eval`** — the id of the done-definition eval the verifier grades each item against
   (the eval Phase 0 confirmed/located, no `.md`). REQUIRED and non-empty (R12a); when a sibling
   `.claude/evals/` exists it must resolve to `<evals>/<done_eval>.md` (R12b). This is the loop's
   checked-in "done", not a per-run judgement call.

### Phase 3 — Pick maker + verifier from the composed catalog (cheap maker, strong verifier)

The body is executed by a **maker**; the result is checked by a **verifier**. Two binding rules:

1. **maker ≠ verifier is structural.** The same skill/agent reference in both is invalid (the
   validator's R5) — self-verification is no verification. Pick the verifier to be a *different*
   agent or skill with the authority to reject the maker's work (a reviewer agent, typically).
2. **Cheap maker, strong verifier** is the recommended model split (the model-tiering hook). Set
   the optional `model:` hint on each ref: a cheaper model (`haiku`/`sonnet`) does the repetitive
   per-item making; a stronger model (`opus`) does the verification, where a missed defect is
   expensive. Omit `model:` to inherit the runtime's model. Resolve both refs from the project's
   composed catalog — makers are usually skills (`review-change`, `database-migration`), verifiers
   are usually the reviewer agents (`code-reviewer`, `diff-reviewer`, the stack-specific
   `*-reviewer`); both refs must resolve (R6).

### Phase 4 — Generate the runtime invocation (exact, verbatim)

Write the exact one-liner into `runtime_invocation`, matched to `runtime`:

- `claude-loop` → the native loop command with the intent, e.g. `/loop babysit my open PRs:
  review, fix CI, stop when none remain`.
- `cron` → a crontab line (`*/15 * * * * cd <repo> && FORGE_LOOP=<name> claude -p '<intent>'`).
- `gh-actions` → the workflow job YAML (`on.schedule` + the `claude -p` step).
- `headless` → the `claude -p` / `nohup claude` wrapper.

This string is what the loop-gate hook substring-matches to ALLOW unattended execution, so it must
be the *actual* command the user will run — not a paraphrase. Prefer prefixing scheduled/headless
forms with `FORGE_LOOP=<name>` so the gate recognizes them by name.

### Phase 5 — Validate + register

1. Run the validator on the new file and make it green:

   ```bash
   node lint/validate-loops.mjs .claude/loops/<name>.md
   ```

2. Add the file to `.forge.json` `files[]` with its checksum (the same registration every
   generated file gets, via `forge registry build --write`).
3. Append a `decision` memory entry recording **why this loop exists** (the repetition it
   replaces, the intake, the tier) in the `capture-learning` style — so the next session knows the
   loop is intentional, not cruft.

### Phase 6 — Dry-run exactly one iteration

Prove it before claiming it. Execute `intake_cmd`, take the **FIRST item only**, run the body
(maker) + verifier once against it, and write the **first dated ledger entry** with the verifier's
verdict. A loop that has never completed one verified iteration is **not** registered as done. If
the dry-run reveals the intake is wrong, the verifier can't decide, or the per-item outcome is
fuzzy — fix the definition and dry-run again. Only a green first iteration closes the skill.

---

## Anti-patterns

| PASS | FAIL |
|------|------|
| Ran `intake_cmd` and showed the items before writing the file | Authored the loop without ever running its intake (a guessed queue) |
| Verifier is a different agent/skill that can reject the maker | Verifier == maker — the loop grades its own homework (R5) |
| Every exit bounded: `cap`/`budget` paired with `queue-dry` | Exit-less "keep going until done" / `queue-dry` alone over an unbounded intake (R7) |
| T2 loop set to `apply: draft`; a human applies each change | T2 loop set to `apply: auto`, editing prod/auth/migration surfaces unattended (R4) |
| Registered only after one green dry-run iteration + ledger entry | Marked "done" with no dry-run — a loop that has never verified one item |
| `runtime_invocation` is the exact command the gate will see | A paraphrased invocation the loop-gate hook can't match |
| Cheap maker + strong verifier via `model:` hints | Strong model on the repetitive making, weak model on the verification |
| One sentence names intake AND per-item outcome before writing | Authoring a "loop" for a one-off task with no discoverable queue |
| Drafted done-criteria, then got the user to confirm them before the eval | Auto-adopted inferred criteria as the eval without the user's sign-off |
| Context dir has only examples ⇒ STOP and co-author the spec before bundling | Bundled over a dir with no written spec/taxonomy — indexing nothing |

## Related

- [docs/LOOPS-MODULE-DESIGN.md](../../docs/LOOPS-MODULE-DESIGN.md) §D1 (schema, single source of
  truth), §D3 (this skill's contract), §D9 (out of scope — no scheduler in Forge).
- [lint/validate-loops.mjs](../../lint/validate-loops.mjs) — the executable schema check
  (D2 R1–R11); run it in Phase 5.
- [lint/fixtures/loops/good-babysit.md](../../lint/fixtures/loops/good-babysit.md) — a valid loop
  definition; the output shape this skill fills.
- `rules/autonomy-ladder.md` — the T0/T1/T2 semantics Phase 2 classifies the loop body against;
  T2 ⇒ draft, never auto-apply.
- **ratchet** skill — the bounded run-until-green primitive a loop body often invokes for the
  "fix CI" leg; the smaller cousin of a full loop.
- **review-change** / **dual-review** skills and the `code-reviewer` / `diff-reviewer` agents — the
  usual makers and verifiers a loop body composes.
- **capture-learning** skill — the `decision` entry Phase 5 appends recording why the loop exists.
- **new-bundle** / **author-eval** skills — the two prerequisites Phase 0 drives when onboarding a
  new work-type: the WARM bundle the loop body cites and the done-definition eval (`done_eval`) the
  verifier grades against.
- `docs/METHOD.md` §3 (autonomy ladder), §4 (evidence before claims — the dry-run + ledger).
