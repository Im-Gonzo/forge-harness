# Forge self-validators (`lint/`)

Forge validates Forge (invariant #4: *no asset ships that fails the self-validators*). These
zero-dependency Node scripts lint Forge's own assets and are wired into CI. They catch a
high-value defect class: **broken cross-references that no linter caught**.

## The validator contract

Every validator follows the same contract:

- **Node ESM `.mjs`, ZERO dependencies, self-contained.** No shared-lib import (siblings are written
  in parallel). Schema checking is a hand-rolled draft-07 *subset* walker — **not AJV** — covering
  `type`, `required`, `properties`, `additionalProperties:false`, `items`, `enum`, `pattern`,
  `minimum`/`maximum`, `minLength`, `minItems`, `minProperties`, `uniqueItems`, `propertyNames.enum`
  (and `$ref` to local `#/definitions` where a schema needs it).
- **Invocation:** `node lint/<name>.mjs [--strict] [rootDir]`. Default `rootDir` is the Forge repo
  root, resolved relative to the script.
- **Output:** `LEVEL path:line message` lines, then a one-line summary. `LEVEL` is `ERROR` or `WARN`.
- **Exit codes:** `0` = pass (no errors), `1` = fail (≥1 error). Under `--strict`, warnings are
  promoted to errors.
- **Excludes** `node_modules/`, `.git/`, and generated `.claude/`.
- **Absence of an asset class is NOT an error.** Empty `bundles/`, no asset dirs yet, etc. → pass.

## The validators

| Validator | Checks |
|---|---|
| `validate-manifests.mjs` | THE composition-integrity check. Structural: `manifests/modules.json` ⟶ `schemas/modules.schema.json`, `manifests/profiles.json` ⟶ `schemas/profiles.schema.json`. Semantic: every module a profile (and `moduleSelectionRules.add`/`.drop`) names exists in `modules.json`; `defaultProfile` is real; module component keys ∈ `componentKinds`; every component resolves to a real asset file. In Phase 2 the asset dirs are empty, so unresolved components are **WARN "(planned)"**; `--strict` promotes them to errors. |
| `validate-hooks.mjs` | Structural: `hooks/hooks.json` ⟶ `schemas/hooks.schema.json`. Semantic: event names are valid (`SessionStart`/`PreToolUse`/`PostToolUse`/`Stop`/`PreCompact`/`SessionEnd`, …); every hook `command` that references a repo script path (e.g. `${CLAUDE_PLUGIN_ROOT}/bootstrap/detect-project.mjs`) points at a file that exists. |
| `validate-bundles.mjs` | For each `bundles/*.md`: parses YAML frontmatter (dependency-free reader) and validates it against `schemas/bundle.schema.json` plus the `REQUIRED_KEYS` / invariant rules (B-1 required keys, B-2 pointer shape, B-3 invariants ⊆ 1..10 non-empty, B-4 `human_gate` boolean & true for gated work-types). `bundles/` empty in Phase 2 → passes. |
| `check-unicode-safety.mjs` | No invisible/zero-width chars or Unicode-tag smuggling in shipped text assets (prompt-injection defense); `--write` autofix. |

## Running them

Run a single validator:

```sh
node lint/validate-manifests.mjs            # warns on planned (unbuilt) assets
node lint/validate-manifests.mjs --strict   # planned assets become errors
node lint/validate-hooks.mjs
node lint/validate-bundles.mjs
```

Run **all** of them (the runner the CLI calls):

```sh
node lint/run-all.mjs            # discover + run every validate-*/check-* sibling
node lint/run-all.mjs --strict   # pass --strict through to each
node lint/run-all.mjs --strict /path/to/forge   # explicit root
```

`run-all.mjs` auto-discovers every `validate-*.mjs` / `check-*.mjs` in `lint/` (never itself), runs
each as a child process via `spawnSync` (passing through `--strict` and the rootDir), prints each
validator's output and a final pass/fail summary, and exits `1` if any validator failed or errored.
It is robust to siblings that don't exist yet: missing files are **skipped with a note**, not crashes.
