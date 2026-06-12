# Forge — Architecture

> Status: **Phase 1 (blueprint)**. This describes the target system. Most paths below do not exist yet; see
> [ROADMAP.md](./ROADMAP.md) for what gets built when. Sibling docs: [BOOTSTRAP.md](./BOOTSTRAP.md) (the
> self-tailoring engine), [METHOD.md](./METHOD.md) (the encoded dev method).

## 1. The problem Forge solves

Strong project harnesses tend to be project-locked, and sprawling external frameworks bury the *enforcement
machinery* worth keeping under bulk you don't want. So the same harness keeps getting re-derived per project.
Forge is the fix: **one framework, installed globally once, that knows how to tailor itself to each new
project.**

Two design goals, in tension, both satisfied by a two-layer split:

- **Everything available everywhere** → a broad global library.
- **Lean, project-appropriate config** → a thin generated per-project activation.

## 2. The two layers

### GLOBAL — the library (a Claude Code plugin)

Installed once at `~/.claude/plugins/forge/`. Contributes its assets **additively** through the plugin
mechanism, so it never overwrites the user's existing global assets (today: 158 agents, 29 skills, an existing
`settings.json`). It contains:

- the full reusable **library**: agents, skills, commands, rules, hook scripts, bundle templates;
- the **bootstrap engine** that profiles a project and composes a tailored harness;
- the **self-validators** that lint Forge's own assets;
- the **manifests** (`profiles.json`, `modules.json`) describing what composes into what.

Why a plugin (not a direct `~/.claude` merge): plugins are additive (no clobber), their `hooks/hooks.json` is
auto-loaded by Claude Code, and they're trivially uninstalled.

### PROJECT — the tailored activation (generated `.claude/`)

Generated into `<project>/.claude/` by the bootstrap engine. It is **thin** — it activates and points at the
global library rather than copying it — and **project-specific**:

- a generated **constitution** (`AGENTS.md` / `CLAUDE.md`): the project's invariants, stack, and toolchain
  contract;
- **selected rules** with `paths:` globs tuned to the detected stack;
- **hook wiring** (`settings.json`) using the project's *real* commands (e.g. `uv run mypy .`, `pnpm test`);
- seed **memory** and **context bundles**;
- a **`.forge.json` marker** recording profile + Forge version + selected modules + checksums, enabling
  idempotent updates (see [BOOTSTRAP.md](./BOOTSTRAP.md)).

> Boundary rule: **broad capability lives global; project truth lives in the project.** A project never vendors a
> copy of an agent it didn't customize — it references the global one. Only customized or generated artifacts
> (constitution, tuned rules, seeds, marker) live in `<project>/.claude/`.

## 3. Target directory layout (global library / repo)

The Forge repo *is* the plugin payload. Phase-1 files are marked ✅; everything else is planned.

```
forge/
  README.md                      ✅ what Forge is, navigation
  VERSION                        ✅ 0.1.0-design
  docs/
    ARCHITECTURE.md              ✅ this file
    BOOTSTRAP.md                 ✅ the self-tailoring engine
    METHOD.md                    ✅ the encoded dev method
    ROADMAP.md                   ✅ phased build plan
  manifests/
    profiles.json                ✅ profile -> module set
    modules.json                 ✅ module -> components
  .claude-plugin/
    plugin.json                  ✅ plugin manifest (declares commands/skills roots; NO agents field)
    marketplace.json             ✅ optional local marketplace entry
  hooks/
    hooks.json                   ✅ auto-loaded; wires detect-project (+ quality hooks later)
  schemas/                       ✅ JSON Schemas for manifests, marker, hooks, bundle, profile
  bin/
    forge.mjs                    ✅ CLI: profile | validate | init | doctor | sync (install/uninstall = Phase 4 stubs)
  bootstrap/
    detect-project.mjs           ✅ SessionStart detector (nudge if no .forge.json)
    profile-project.mjs          ✅ deterministic stack profiler -> profile-project.json
    templates/                   ✅ AGENTS.md + settings.json + memory + bundle templates ({{VAR}} placeholders)
  agents/                        ⬜ code-reviewer, *-reviewer, ... (auto-discovered at PLUGIN ROOT) — Phase 3
  skills/                        ◑ bootstrap-harness ✅; run-eval, review-change, ... ⬜ Phase 3 (declared in plugin.json)
  commands/                      ✅ harness-init, harness-sync, harness-doctor (declared in plugin.json)
  rules/                         ◑ prompt-defense-baseline + common/evidence-before-claims ✅; full set ⬜ Phase 3
  bundles/                       ⬜ context-bundle templates + bundle-lint fixture — Phase 3
  memory/                        ⬜ memory entry schema + seed/index templates — Phase 3 (templates live in bootstrap/templates/)
  lint/                          ✅ 10 self-validators + run-all.mjs (validate-*, check-unicode-safety)
  .github/workflows/             ⬜ CI: validate Forge's own assets — Phase 5
```

> **Plugin discovery rule (load-bearing).** Claude Code's plugin validator **rejects an `agents` field** in
> `plugin.json`; agent `.md` files are auto-discovered only from the **plugin-root `agents/`** dir (like `hooks/`).
> `commands` and `skills` *do* accept custom path arrays but, for consistency and to match known-good plugins,
> Forge keeps all discoverable assets at the plugin root rather than under a wrapper dir. `rules/`,
> `bundles/`, and `memory/` are **template libraries** the bootstrap composer copies into a project's `.claude/`;
> they are not globally auto-loaded.

## 4. Composition model (manifests)

Three nouns, smallest to largest:

- **component** — one asset (an agent, a skill, a rule pack, a hook, a bundle, a validator).
- **module** — a coherent set of components that ship together (e.g. `review`, `python`, `database`). Defined in
  [`manifests/modules.json`](../manifests/modules.json).
- **profile** — a named module set for a kind of project (e.g. `python-next-fullstack`). Defined in
  [`manifests/profiles.json`](../manifests/profiles.json).

The composer resolves: detected facts → base **profile** → `+`/`−` modules from `moduleSelectionRules` → the
union of their **components** → generated project `.claude/`. `validate-manifests` enforces that every module a
profile names exists, and every component a module names resolves to a real file (once the asset dirs are
populated).

## 5. Self-validation

Forge lints itself. The `lint/` validators (Phase 2) fix a high-value class of defect — broken cross-references
that no linter catches:

| Validator | Checks |
|---|---|
| `validate-agents` / `validate-skills` / `validate-commands` / `validate-rules` | frontmatter present & well-formed; required fields; non-empty |
| `validate-xref` | every slash-command reference, agent/skill path reference, and relative doc link **resolves to a real file** |
| `check-unicode-safety` | no invisible/zero-width chars or tag-smuggling (prompt-injection defense); `--write` autofix |
| `validate-no-personal-paths` | no leaked `/home/<user>` / `C:\Users\<user>` in shipped assets |
| `validate-manifests` | profiles → modules → components all resolve (zero-dep schema check against `schemas/`) |
| `bundle-lint` | context bundles satisfy the bundle schema; ships a negative fixture that must fail |

All wired into CI (`.github/workflows/`) so an asset regression is a failing build, not silent drift.

## 6. Key invariants of Forge itself

1. **Additive, never destructive.** Global install must not overwrite existing `~/.claude` assets; project
   generation must not clobber user-edited files (checksum-guarded, see BOOTSTRAP §marker).
2. **Detect-and-offer, never auto-mutate.** The SessionStart hook only injects a nudge; file generation runs
   only after explicit user confirmation.
3. **Deterministic collection + LLM judgment.** Scripts gather facts exhaustively; the model composes. No
   composition decision is hidden inside a script, no fact-gathering is left to the model's memory.
4. **Forge validates Forge.** No asset ships that fails the self-validators.
5. **Fail-open hooks.** Every hook exits 0 on parse/IO error and logs to stderr; only intentional gates block.
