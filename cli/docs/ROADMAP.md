# Forge — Roadmap

> Status: **Phases 1–3 ✅; Phase 5 dogfood + CI/meta-tests ✅; Phase 4 live install PENDING explicit go-ahead**
> (manifests pass the real `claude plugin validate`; the install was safety-gated). Phases are sequenced so each
> is independently reviewable and the risky step (touching the real `~/.claude`) comes last and gated.

## Phase 1 — Blueprint  ✅ (this build)

Design docs + declarative manifests. No executable code.

- `README.md`, `VERSION`
- `docs/ARCHITECTURE.md`, `docs/BOOTSTRAP.md`, `docs/METHOD.md`, `docs/ROADMAP.md`
- `manifests/profiles.json`, `manifests/modules.json`

**Exit criteria:** docs internally consistent, cross-links resolve, manifests valid JSON with profiles→modules
resolving. Human review of the blueprint.

## Phase 2 — Walking skeleton  ✅

The minimum that makes detect → offer → init work end-to-end on a scratch project, **without** installing into the
real `~/.claude`. **Built and verified** (see Exit criteria below — all met): plugin packaging + 6 schemas +
`detect-project.mjs`/`profile-project.mjs` + 10 self-validators (`lint/run-all.mjs` 10/10 PASS) + the 3
`/harness-*` commands + `bootstrap-harness` skill & templates + `bin/forge.mjs` CLI + 2 seed rules.
`forge init` generates a schema-conformant `.claude/` + `.forge.json`, is additive (re-apply preserves edits),
and `forge doctor` reports healthy.

- `.claude-plugin/plugin.json`, `hooks/hooks.json` (wires `detect-project` on SessionStart)
- `bootstrap/detect-project.mjs`, `bootstrap/profile-project.mjs`, `bootstrap/templates/`
- `commands/`: `harness-init`, `harness-sync`, `harness-doctor` (plugin-root; declared in plugin.json)
- `skills/bootstrap-harness/` (plugin-root; declared in plugin.json)
- `lint/` self-validators + `schemas/` (Tier 1: `validate-xref`,
  `check-unicode-safety`, `validate-no-personal-paths`, `validate-manifests`)
- `bin/forge.mjs` (CLI: `profile`, `validate`, `doctor`)
- minimal seed: the `prompt-defense-baseline` rule + one stack rule under `rules/`, so a generated harness is non-empty

**Exit criteria:** on a throwaay repo, `node bootstrap/profile-project.mjs` emits correct facts; the
`bootstrap-harness` skill generates a valid `.claude/` + `.forge.json`; `forge validate` passes on Forge's own
assets.

## Phase 3 — Seed the library  ✅

Populated the plugin-root asset dirs with the real assets (Tiers 1–2), generalized to reusable.
**Built & verified** (2 agent waves, 11 agents): 6 agents (code/diff/python/typescript/database/security
reviewers, all read-only), 11 skills, 5 quality hooks wired into `hooks.json`, 17 rule packs (common + per-stack),
3 context bundles, the memory-integrity validator, and orchestration/eval/memory skills. **`validate-manifests
--strict` passes with 0 warnings — every manifest component resolves to a real file.** `forge init` on a
fullstack repo composes the full tailored set (23 files); `run-all` 11/11 PASS. 85 files total.

- `review` module: `code-reviewer` (anti-noise), `dual-review` (Tier 2)
- `eval` module: `run-eval` / `author-eval` with graders + pass@k/^k (Tier 3, high-value)
- `hooks-quality`: `edit-citation-gate`, `config-protection`, `block-no-verify`, `stop-typecheck` (Tier 2)
- `rules-common` + per-stack `python` / `typescript` / `database` rule packs (`paths:`-globbed)
- `context-bundles`: bundle templates + `bundle-lint` + negative fixture
- `memory`: entry schema (confidence + evidence), `curate-memory`, `validate-memory-integrity`

**Exit criteria:** every component named in `manifests/modules.json` resolves to a real, validator-passing file;
CI green.

## Phase 4 — Global install + live test  ✅ (installed & verified; user-authorized)

Forge is **installed globally** on this machine (user scope) via the official CLI:
`claude plugin marketplace add <forge>` + `claude plugin install forge@forge`. `claude plugin validate .` passed
the real Claude Code validator (v2.1.165) first.

**Verified:** `claude plugin list` → `forge@forge … OK enabled`; inventory = 14 skills + 6 agents + 3 hooks
(SessionStart/PreToolUse/Stop, "no model context cost", ~2,550 always-on tok). **Additive** — existing
`frontend-design`/`rust-analyzer-lsp` plugins still enabled; the 158 global agents / 29 skills untouched. The CLI
**copied** Forge into `~/.claude/plugins/cache/forge/forge/0.1.0`. Proxy live-test of the installed SessionStart
detector: emits the STALE-REPLAY-guarded `/harness-init` offer in a harness-less project, silent when `.forge.json`
exists — detect→offer works.

**Notes:** (1) hooks/commands/agents go live in the **next** session (plugins load at session start). (2) The
install is a **copy** — repo edits need `claude plugin update forge@forge` to take effect. (3) Global PreToolUse
hooks now fire in every new session: `config-protection`/`block-no-verify`/`secret-scan` (all fail-open);
`edit-citation-gate`/`stop-typecheck` only activate in Forge-tailored projects (`.forge.json`). (4) Rollback:
`claude plugin uninstall forge@forge` + `claude plugin marketplace remove forge`. `bin/forge.mjs install/uninstall`
remains a no-CLI fallback.

**Remaining:** live end-to-end `/harness-init` on a fresh scratch project in a NEW session.

## Phase 5 — Hardening & dogfood  ◑ (dogfood ✅ + CI/meta-tests ✅; the rest pending)

- ✅ **Dogfood**: ran `forge profile`/`init` dry-runs against a real fullstack project (non-destructive) +
  an isolated full-apply on its scaffolded stack. Drove the **spec-aware `intended` profiler hint** (now built):
  the profiler surfaces python/postgres/fastapi from the project's specs even though only a TS/Next shell is materialized.
- ✅ **CI + meta-tests**: `.github/workflows/ci.yml` (staged — runs `lint/run-all.mjs --strict` + `tests/run-meta.mjs`
  once forge is a git repo) and 5 behavioral meta-tests in `tests/meta/` asserting governance prose is present
  (reviewer anti-noise, reviewers read-only, agent frontmatter, skill governance, prompt-defense) — `run-meta` 5/5 PASS.
- ⬜ Remaining: live `/harness-sync` onto a real project (after Phase 4 install); `validate-workflow-security`; optional Tier 4
  (slash-command PRP layer, `skill-comply` for business-rule compliance, GAN generate<->evaluate loop).

## Sequencing rationale

1. Blueprint before code — cheap to redirect on paper.
2. Skeleton proves the *novel* mechanic (self-tailoring) before investing in library breadth.
3. Library breadth before global install — never install something the validators haven't passed.
4. Global install last and gated — it's the only step that's hard to reverse.
5. Dogfood on our own project validates the whole loop on a real codebase.
