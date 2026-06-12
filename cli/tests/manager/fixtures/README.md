# Forge Harness Manager — test fixtures

Self-contained, deterministic fixtures for the v0.2 registry/versioning/CLI evals.

**FROZEN.** Downstream agents (registry build, `validate-registry`, the CLI runner, the
eval graders) read these **read-only**. Do not edit a fixture to make a test pass — edit the
code under test. Every fixture is zero-runtime-dep and hand-authored to be reproducible
(no timestamps, no machine-specific paths, no generated hashes baked in).

Fixture shapes mirror the real Forge library (`agents/*.md` frontmatter, `rules/**`,
`skills/<id>/SKILL.md`, `commands/*.md`, `bundles/*.md`, `lint/validate-*.mjs`,
`tests/meta/*.mjs`, `bootstrap/*.mjs`, `hooks/hooks.json`, `manifests/modules.json`) so the
registry scan surface (SPEC-01 §Design) and kind→path resolution are exercised against
realistic inputs.

## Fixture → EVAL map

| Fixture | What it contains | EVAL cases served |
|---|---|---|
| `lib-min/` | 2 agents (`code-reviewer`, `diff-reviewer`), 1 top-level rule (`review-discipline`), 1 hook id in `hooks/hooks.json` (`forge:edit-citation-gate`), a `manifests/modules.json` naming them all (no orphans/planned), and a `VERSION`. | EVAL-REG-001 (registry location, no lock), -002 (stale = ERROR), -004 (record shape + `modules[]` reverse-index), -006 (idempotent build), -007 (mutation log shape), -009 (read-only query verbs); EVAL-VER-002 (3-part identity, seed `rev:1`/`0.1.0`), -003 (semver levels), -004 (bump → rev+log), -006 (per-artifact changelog), -007 (advisory bump gate). Used as the base library by any case that needs "a few valid in-module artifacts". |
| `lib-allkinds/` | Exactly one artifact of EACH kind: agent (`code-reviewer`), skill (`skills/review-change/SKILL.md`), command (`harness-doctor`), **nested** rule (`rules/common/citations.md`), bundle (`work-module`, integer `version: 1`), validator (`lint/validate-sample.mjs`), meta-test (`tests/meta/sample-meta.mjs`), engine (`bootstrap/detect-project.mjs`), and a hook id (`forge:detect-project`) in `hooks/hooks.json`. `manifests/modules.json` names all of them. | EVAL-REG-003 (scan surface + kind→path resolution; hook recorded as `hooks/hooks.json#<id>`); also exercises EVAL-VER-008's bundle `version: 3`→`"3.0.0"` mapping shape (here `version: 1`→`"1.0.0"`). |
| `lib-planned-and-orphan/` | `manifests/modules.json` names `agents/code-reviewer` (present → active) and `agents/planned-reviewer` (**no file** → planned). `agents/orphan-reviewer.md` is present on disk but named by **no** module (orphan flag, not a status). | EVAL-REG-005 (planned vs orphan classification: planned is not an error; orphan is a flag, not `status:"planned"`). |
| `lib-one-bad/` | 3 valid artifacts (agents `code-reviewer`+`diff-reviewer`, rule `review-discipline`) plus ONE malformed agent `agents/broken-frontmatter.md` (unclosed `---` fence, unterminated string/list, missing colon). `manifests/modules.json` names only the valid ones. | EVAL-REG-010 (fail-open build: records all valid artifacts, emits exactly one `{level,path,line,message,source:"validate-registry"}` finding for the bad one, never aborts). |
| `versions-aligned/` | `VERSION`, `package.json`, `.claude-plugin/plugin.json` ALL reading `0.1.0`. | EVAL-REG-008 negative half + EVAL-VER-001 negative half (aligned tree → **no** VERSION triple-drift finding). The positive (drift) half uses the **real repo root** `0.1.0-design`/`0.1.0`/`0.1.0`. |
| `validate-fixture.mjs` | Throwaway zero-dep validator: prints EXACTLY one finding to STDERR — `WARN agents/x.md:12 dangling ref "y"` — and one `validate-fixture: …— PASS` summary to STDOUT; exits 0; deterministic across argv (so its before/after byte-diff is empty). Mirrors `lint/validate-agents.mjs` output style. **Never** gains a `--json` mode — the `--json` envelope is synthesized at the parent runner by parsing this line. | EVAL-CLI-001 (parent `--json` envelope from `run-all`, parsed from `LEVEL path:line`, child unchanged). |
| `cli-001-tree/` | A runnable root for EVAL-CLI-001: `lint/validate-fixture.mjs` (byte-identical copy of the throwaway validator, so `node lint/run-all.mjs --json <root>` discovers it) and `agents/x.md` (the artifact the finding names; line 12 carries the dangling-ref location). | EVAL-CLI-001 (the `<fixtureRoot>` the parent runner is pointed at). |

## Notes for downstream agents

- **Versions:** every library fixture seeds `VERSION = 0.1.0` so a fresh build's mirror is
  stable. Drift is tested against the real repo, not these fixtures.
- **Frontmatter:** valid `.md` artifacts carry `owner`/`description`/`tags`/`criticality`
  and an advisory `version:` key — present to prove tolerant parsing (BR-VER-008), not
  authoritative (the registry's `version` wins).
- **Hooks** are recorded by id with `path: "hooks/hooks.json#<id>"`; the fixture
  `hooks.json` files use the same `{matcher,hooks[],description,id}` shape as the real
  `hooks/hooks.json`.
- **The one bad file** in `lib-one-bad/` is the *only* intentionally malformed artifact in
  any fixture; every other artifact is well-formed.
- **`source` field:** for `validate-fixture.mjs`, the parent runner stamps
  `source:"validate-fixture.mjs"` (the child's filename); the registry's own findings use
  `source:"validate-registry"`.
