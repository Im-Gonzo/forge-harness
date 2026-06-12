---
name: bootstrap-harness
description: Tailor a Forge harness to the current project — profile the stack deterministically, compose a base profile + module deltas with one-line reasons, author/align the constitution against any existing AGENTS.md, then render the .claude/ scaffold + .forge.json. Confirms first, additive only, never blind-overwrites.
---

# bootstrap-harness — compose and generate a project's Forge harness

The composer half of `/harness-init`. Scripts gather facts exhaustively; **you** make the composition
judgment a script can't (`docs/METHOD.md` §7). Honor three invariants throughout: **detect-and-offer never
auto-mutates** (you write nothing before the user says yes), **generation is additive** (never delete, never
clobber a user-edited file), and **evidence before claims** (`docs/METHOD.md` §4 — "generated/validated" comes
from a fresh command run shown in the output, never from memory).

> **STOP if already tailored.** Before anything: `test -f .claude/.forge.json && echo MARKER_PRESENT`.
> If the marker exists, this project is already done — report its `profile` + `forgeVersion` and defer to
> **/harness-sync** (upgrade/add) or **/harness-doctor** (health check). Do **not** regenerate.

Forge root is the plugin dir (where `manifests/`, `bootstrap/`, `schemas/` live). The target project is the
argument (default `.`). Commands below assume you are in the target project and reference the Forge root as
`$FORGE` — resolve it once (e.g. the plugin install dir) and reuse it.

---

## Phase 1 — Profile (deterministic, read-only)

Run the profiler. It scans read-only and writes pure stack facts to `.claude/profile-project.json`
(`docs/BOOTSTRAP.md` §1). It makes **no** decisions.

```bash
node "$FORGE/bootstrap/profile-project.mjs" . --write
```

Read the result back and keep it open — it drives every later decision:

```bash
cat .claude/profile-project.json
```

Note the load-bearing fields (schema: `schemas/profile-project.schema.json`):
`languages`, `packageManager`, `frameworks`, `testRunner`, `database`, `lintFormat`, `monorepo`, `ci`,
`hasTests`, `commands` (the **real** invocations — `test`/`typecheck`/`lint`/`format`, namespaced
`be_*`/`fe_*` when both stacks are present), and `docs` (`constitution`, `specs[]` — so you extend, never
overwrite). Treat the facts as evidence, not gospel: if a fact looks wrong, say so before composing.

---

## Phase 2 — Compose (LLM judgment — this is the part a script can't do)

Read the manifests, then decide. This is the irreducible human-judgment step.

```bash
cat "$FORGE/manifests/profiles.json" "$FORGE/manifests/modules.json"
```

**2a. Pick the BEST base profile** for the facts (a key in `profiles.json`). Match on the dominant stack:

| Facts | Base profile |
|---|---|
| python core + a Next/React UI + Postgres, spec-driven | `python-next-fullstack` |
| python web only (FastAPI/Django/Flask), no UI | `python-fastapi` |
| TypeScript/Next front end only, no python | `next-ts` |
| security-heavy posture, otherwise unremarkable stack | `security` |
| nothing classifies confidently | `generic` (the `defaultProfile`) |

If `$ARGUMENTS` carried `--profile <name>`, honor it as the base override (still apply 2b on top). When no
profile is a confident fit, fall back to `generic` — never force a mismatch.

State the pick in one line, e.g.: `Base profile: python-next-fullstack — python(fastapi)+typescript(next)+postgres, spec dirs present.`

**2b. Apply `moduleSelectionRules`, one line per add/drop.** Start from the base profile's `modules`, then
walk `profiles.json#moduleSelectionRules.add` against the facts and union in any that match. The model may
justify *additional* add/drop beyond the rules — each needs a one-line reason. Examples:

- `+database — facts.database == "postgres"` (rule)
- `+eval — facts.hasTests == true` (rule)
- `+python — facts.languages includes "python"` (rule)
- `+typescript — facts.languages includes "typescript"` (rule)
- `+security — repo handles secrets/auth and posture warrants it` (judgment)
- `−context-bundles — no spec/ADR corpus to index; bundles would be empty` (judgment, only if dropping a base module)

Every module in the final set MUST be a key in `modules.json` (the marker validator enforces this). Dedup.

**2c. Resolve components.** Union the `components` of every selected module from `modules.json`. You don't
copy global agents/skills — they're **referenced**, not copied (`docs/BOOTSTRAP.md` §3). Only customized,
generated files land in the project: the constitution, tuned `rules/`, `settings.json`, `memory/`, `bundles/`.

**2d. Report the plan before writing.** Show the user: the picked profile, the final module list with the
one-line reason for each delta, and the exact file list `forge init` will write. This is the preview gate.

---

## Phase 3 — Author the constitution (extend, never clobber)

The constitution is HOT context (`docs/METHOD.md` §1): one screen, states rules + points to specs, never a
manual. Two cases, decided by `docs.constitution` in the facts:

**Case A — an `AGENTS.md`/`CLAUDE.md` already exists** (`facts.docs.constitution` is non-null):
*extend/align, never blind-overwrite.* Read it, extract its existing invariants, and propose only additive
edits (e.g. a "Build / test / run" block with the detected commands, a pointers row, a note that Forge
tailored the harness). Show a **diff** and get separate confirmation before touching it — altering a
top-level constitution is confirmed apart from the `.claude/` scaffold (`docs/BOOTSTRAP.md` §3).

```bash
test -n "<docs.constitution>" && git -C . diff --no-index --no-color -- <existing> <(proposed) || true
```

Never restate normative text the existing doc already owns — single source of truth. If it already has a
strong invariants section, leave it; just add the toolchain contract + pointers if missing.

**Case B — no constitution exists** (`facts.docs.constitution` is null): generate one from
`bootstrap/templates/AGENTS.md.tmpl` using the detected facts. The renderer (`forge init`) substitutes the
template variables; your job is to make sure the **non-negotiable invariants** section is seeded with a
concrete TODO for the project's own cross-cutting concerns (tenancy, the single write path, audit) — a
generic invariants list is worthless. Surface that TODO to the user.

In both cases the constitution cites pointers only and notes it was generated by Forge `{{FORGE_VERSION}}` /
profile `{{PROFILE}}`.

---

## Phase 4 — Generate the mechanical scaffold (write, confirmed)

Only after the user confirms the Phase 2 plan (and, separately, any constitution diff), render the scaffold:

```bash
forge init . --profile <picked-profile> --apply
```

This is the mechanical half — it renders `bootstrap/templates/` into `<project>/.claude/`:
`settings.json` (hook wiring from the detected commands + `permissions.deny` for secrets, merged with any
existing settings), the selected `rules/` files with `paths:` globs tuned to the stack, the `memory/` seeds
(`index.md` + `entry.md` schema), the `bundles/` seed(s) when `context-bundles` is selected, and the
`.claude/.forge.json` **marker** (written in code by the CLI, not from a template — `schemas/marker.schema.json`).

Preview first if unsure — without `--apply`, `forge init` is a dry-run that prints the plan:

```bash
forge init . --profile <picked-profile>      # dry-run, prints what it would write
```

If the renderer leaves any command variable empty (e.g. the project has no typecheck), the corresponding
hook line degrades gracefully — it is emitted commented-out / dropped so `settings.json` stays valid JSON
(see the template notes). Do not hand-edit the rendered output to "fix" a missing command; fix the project's
toolchain or leave the hook off.

---

## Phase 5 — Validate and report every file written

Evidence before claims: prove the result with a fresh run, then enumerate what landed.

```bash
forge validate . 2>/dev/null || true
git -C . status --porcelain          # or: find .claude -type f -newer .claude/profile-project.json
```

Report to the user, file by file:

- the picked **profile** and final **modules** (with the deltas + reasons from Phase 2);
- **every file written** under `.claude/` (constitution, `settings.json`, `rules/*`, `memory/index.md`,
  `memory/` entry-schema seed, `bundles/*`), plus the top-level constitution if Case A/B touched it;
- the **marker** path `.claude/.forge.json` and its recorded `forgeVersion` + `profile`;
- the `forge validate` outcome (the actual command + result, not "should be fine");
- any **TODO** left for the user (the invariants section, an empty command that disabled a hook).

---

## Safety contract (recap — non-negotiable)

- **Confirm before writing.** Phases 1–2 are read-only; nothing is written until the user says `yes`. The
  constitution diff (Phase 3, Case A) is confirmed *separately* from the scaffold.
- **Additive only.** Never delete a file. Never overwrite a user-edited file or an existing constitution —
  diff and propose. `settings.json` is merged, not replaced.
- **Idempotent.** Marker present ⇒ stop and defer to `/harness-sync`; never regenerate over a tailored repo.
- **Fail-open & honest.** If a step errors, report it and stop — do not claim success. Hooks the scaffold
  wires must fail open; the bootstrap itself must never leave the repo half-written silently.
