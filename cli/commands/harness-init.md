---
description: Generate a Forge harness tailored to the current project. Confirms first, then profiles → composes → writes a thin .claude/ + .forge.json. Never overwrites without a diff.
argument-hint: "[--profile <name>] (optional: override the auto-picked base profile)"
allowed-tools: Bash, Read, Skill
---

# /harness-init — tailor a Forge harness to this project

Generate a project-specific `.claude/` (constitution + tuned rules + hook wiring + seeds) and the `.forge.json`
marker, by running the `skills/bootstrap-harness/` skill. This command is a **thin frontend** — the real work
lives in that skill and in the `forge` CLI (`forge init --apply`). It honors Forge's invariants
(`../docs/ARCHITECTURE.md` §7): **detect-and-offer never auto-mutates**, generation is **additive, never
destructive**, and user-edited files are sacred.

## Preflight — STOP if already tailored

Run first, before anything else:

```bash
forge doctor . 2>/dev/null || true
test -f .claude/.forge.json && echo "FORGE_MARKER_PRESENT"
```

- If `.claude/.forge.json` **exists** → this project is already tailored. **Do NOT regenerate.** Report the
  recorded profile + Forge version from the marker, and point the user to **/harness-sync** (to upgrade /
  add components) or **/harness-doctor** (to health-check). Stop here.
- If absent → continue.

## Confirm before writing (non-negotiable)

Never write a single file before the user confirms. The flow is **detect → offer → init**:

1. State that no harness exists here and that `/harness-init` will generate one.
2. Run the profile + compose steps **read-only** first (below) so the user sees *what* will be written and *why*
   — the picked profile, the selected modules with one-line reasons, and the exact file list.
3. Ask for explicit confirmation (`yes` / `proceed`). Only then write.

If the user passed `$ARGUMENTS` (e.g. `--profile python-next-fullstack`), carry it through as the base-profile
override; the composer may still justify module add/drops on top of it.

## Procedure

1. **Profile (deterministic, read-only).** The skill runs `bootstrap/profile-project.mjs` to emit
   `.claude/profile-project.json` — pure stack facts (languages, package managers, frameworks, test runner,
   database, lint/format, monorepo, CI, the *real* commands to wire, existing docs). Scripts gather facts; the
   model composes (`../docs/ARCHITECTURE.md` §7.3). Preview with `forge profile` if you want the facts alone.

2. **Compose (LLM judgment) via the skill.** Invoke **`skills/bootstrap-harness/`**. It reads the facts +
   `../manifests/profiles.json` + `../manifests/modules.json` and decides: base profile → `+`/`−` module deltas
   from `moduleSelectionRules` (each with a one-line reason) → the union of components. Report the decision to
   the user **before** writing (`../docs/BOOTSTRAP.md` §2).

3. **Constitution — extend, never clobber.** If an `AGENTS.md` / `CLAUDE.md` already exists, the skill
   *extends/aligns* with it (reads its invariants); it never blindly overwrites. Generating or altering a
   top-level `AGENTS.md` is confirmed **separately** and only after the user sees a **diff**. A constitution
   cites pointers — it does not restate normative text.

4. **Generate (write, confirmed) via `forge init --apply`.** After confirmation, the skill calls:

   ```bash
   forge init . [--profile <name>] --apply
   ```

   This renders into `<project>/.claude/`: the constitution, `rules/` with `paths:` globs tuned to the stack,
   `settings.json` hook wiring built from the **detected real commands** (merged with any existing
   `settings.json`, plus `permissions.deny` for secrets), `memory/` seeds, and `bundles/` if the profile
   includes them. Global agents/skills are **referenced, not copied** — only customized/generated artifacts land
   in the project (`../docs/ARCHITECTURE.md` §2 boundary rule). Without `--apply`, `forge init` is a dry-run that
   prints the plan; use it to preview.

5. **Mark.** `forge init --apply` writes `.claude/.forge.json` (forgeVersion, profile, modules, generatedAt,
   per-file checksums + `userEditable`) — the idempotency marker that makes `/harness-sync` and `/harness-doctor`
   work (`../docs/BOOTSTRAP.md` §4).

6. **Validate + report.** Run `forge validate` on the result, then list **every generated file** to the user. If
   any existing file would be touched, show its diff and re-confirm before applying.

## Guardrails

- **Confirmation gate:** no writes before explicit `yes`. This command embodies invariant #2.
- **Additive only:** never delete; never overwrite a user-edited file. Existing `AGENTS.md` / `CLAUDE.md` /
  `settings.json` are extended/merged, with a diff shown first.
- **Idempotent:** marker present ⇒ defer to **/harness-sync**, never regenerate.
- **Evidence before claims:** "generated / validated" comes from a fresh `forge validate` run shown in the
  output, never from memory.

## After init

- Re-run later to upgrade or add components for newly-detected stack → **/harness-sync**.
- Read-only health check (marker valid, references resolve, hooks exist, version drift) → **/harness-doctor**.
