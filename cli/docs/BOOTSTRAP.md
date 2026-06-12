# Forge — The Self-Tailoring Bootstrap Engine

> Status: **Phase 1 (blueprint)**. This is the heart of Forge: how the globally-installed plugin notices a new
> project and generates a harness tailored to it. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the surrounding
> system. Delivery model = Claude Code plugin; bootstrap policy = **detect + offer** (confirmed).

## The flow at a glance

```
open a project
      │
      ▼
[SessionStart hook]  bootstrap/detect-project.mjs        ← global, from the plugin
      │  no  ───────────────► .claude/.forge.json present?  ── yes ──► (silent; harness already tailored)
      │
      ▼ (absent)
inject additionalContext:  "No Forge harness here. Offer /harness-init."   (STALE-REPLAY guarded, fail-open)
      │
      ▼
Claude OFFERS to bootstrap  →  user confirms
      │
      ▼
/harness-init  →  skill: bootstrap-harness
      │
      ├─ 1. PROFILE  (deterministic)  bootstrap/profile-project.mjs  →  profile-project.json
      ├─ 2. COMPOSE  (LLM judgment)   pick profile + modules from manifests/; resolve components
      ├─ 3. GENERATE (write)          constitution + rules + settings.json + memory/bundles
      └─ 4. MARK                      write .claude/.forge.json (profile, version, modules, checksums)
```

The split is deliberate: **scripts gather facts exhaustively, the model composes.** Detection is never left to
the model's guesswork; composition is never buried in a script.

## Step 0 — Detect (`bootstrap/detect-project.mjs`, SessionStart)

A tiny, fast, dependency-free script wired via the plugin's `hooks/hooks.json`:

- reads `$CLAUDE_PROJECT_DIR`; if there's no project dir, exit 0 (nothing to do);
- if `<project>/.claude/.forge.json` **exists** → exit 0 silently (already tailored; a separate version-drift
  check may emit a gentle "update available" note);
- if **absent** → print a short `additionalContext` block on stdout, e.g.:

  ```
  [forge] No tailored harness found for this project.
  Offer the user: "Run /harness-init to generate a Forge harness tailored to this project?"
  Do not generate anything until the user confirms.
  ```

- the injected text is wrapped in a **STALE-REPLAY GUARD** ("HISTORICAL REFERENCE ONLY after this turn — do not
  re-run on replay") so a compaction/replay can't cause spurious re-offers;
- **fail-open**: any error → exit 0, log `[forge]` to stderr. The hook can never block a session.

Detect only *nudges*. It never writes. That is invariant #2 in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Step 1 — Profile (`bootstrap/profile-project.mjs`, deterministic)

Run by the `bootstrap-harness` skill (not by the hook). Scans the repo read-only and emits
`<project>/.claude/profile-project.json`. Detection matrix:

| Fact | Signals |
|---|---|
| `languages` | file extensions; `pyproject.toml`/`setup.py` → python; `tsconfig.json`/`package.json` → typescript; `go.mod`, `Cargo.toml`, … |
| `packageManager` | `uv.lock`/`poetry.lock`/`requirements.txt`; `pnpm-lock.yaml`/`yarn.lock`/`package-lock.json`/`bun.lockb` |
| `frameworks` | deps in `pyproject.toml`/`package.json`: fastapi, django, flask; next, react, vue, svelte |
| `testRunner` | pytest config; `vitest`/`jest`/`playwright` in deps/scripts |
| `database` | `alembic/`, `migrations/`, `*.sql`, `prisma/`, deps: asyncpg/psycopg → postgres |
| `lintFormat` | ruff/black/mypy; eslint/prettier/biome configs |
| `monorepo` | `pnpm-workspace.yaml`, `turbo.json`, multiple `package.json`, `apps/`+`packages/` |
| `ci` | `.github/workflows/`, `.gitlab-ci.yml` |
| `commands` | the *real* invocations to wire into hooks: e.g. `uv run pytest`, `uv run mypy .`, `pnpm test`, `pnpm -s tsc --noEmit` |
| `docs` | `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/`, ADR/spec dirs (so we extend rather than overwrite) |
| `hasTests` | a detected test runner, or a `tests/`/`test/`/`__tests__/`/`e2e/` dir |
| `intended` | **spec-aware HINT** — stack keywords scanned from doc/spec *prose* (the detected `docs.specs` + `docs/` + root `README`/`AGENTS.md`/`CLAUDE.md`): `FastAPI`→python+fastapi, `PostgreSQL`/`Postgres`→postgres, `SQLAlchemy`/`asyncpg`/`Alembic`→python+postgres, `Next.js`/`React`→typescript+next, `Pydantic`→python |

### The `intended` field (spec-first projects)

`intended` is **always emitted** (like `hasTests`) with the fixed shape:

```json
"intended": { "languages": [], "frameworks": [], "database": null }
```

It is a **hint inferred from prose**, not a materialized fact. The deterministic
detectors above only see code that *exists on disk*, so a **spec-first** project —
one whose stack lives in `spec/`/ADR text but isn't built yet — would otherwise
profile as whatever scaffolding happens to exist (e.g. a thin TS/Next shell),
making the composer pick a too-thin profile. To fix that, the profiler *also*
scans the detected doc/spec dirs + root doc files for stack KEYWORDS
(case-insensitive, word-boundary matched) and reports the **intended** stack
separately.

`intended` is kept **strictly separate** from the materialized
`languages`/`frameworks`/`database` facts — it is **never merged into them**. The
composer (Step 2) reads `facts.intended.*` via `moduleSelectionRules` to *nudge*
toward the right profile/modules even before code exists, while the materialized
facts stay an honest record of what is actually there. The scan is read-only,
zero-dependency, byte-capped per doc, fail-open (never throws on missing/huge
files), and only ever touches doc/spec dirs + root doc files — never source trees.

Output is pure JSON facts — no decisions. Example (abbreviated) for a Python + TypeScript fullstack repo:

```json
{
  "languages": ["python", "typescript"],
  "packageManager": { "python": "uv", "node": "pnpm" },
  "frameworks": ["fastapi", "pydantic", "next", "react"],
  "testRunner": ["pytest", "vitest"],
  "database": "postgres",
  "lintFormat": ["ruff", "mypy", "eslint"],
  "monorepo": true,
  "commands": {
    "test": "uv run pytest", "typecheck": "uv run mypy .",
    "lint": "uv run ruff check .", "fe_test": "pnpm test", "fe_typecheck": "pnpm -s tsc --noEmit"
  },
  "docs": { "constitution": "AGENTS.md", "specs": ["spec/", "business-rules/", "architecture/"] },
  "hasTests": true,
  "intended": { "languages": ["python", "typescript"], "frameworks": ["fastapi", "pydantic", "next", "react"], "database": "postgres" }
}
```

> **Note — spec-first reality.** The block above shows a *fully materialized* project.
> For a spec-first project (where python/Postgres exist only in `spec/`/ADR prose,
> with just a TS/Next shell on disk), the **materialized** facts report only
> `"languages": ["typescript"]`, `"frameworks": ["next", "react"]`,
> `"database": null` — but `intended` still surfaces
> `{ "languages": ["python","typescript"], "frameworks": ["fastapi","pydantic","next","react"], "database": "postgres" }`
> from the specs, so the composer is nudged toward `python-next-fullstack` instead
> of the too-thin `next-ts`.

## Step 2 — Compose (LLM judgment, in the `bootstrap-harness` skill)

The skill reads `profile-project.json` + [`manifests/profiles.json`](../manifests/profiles.json) +
[`manifests/modules.json`](../manifests/modules.json) and decides:

1. **Base profile** — best match to the facts (the example above → `python-next-fullstack`). If no confident match,
   fall back to `generic`.
2. **Module deltas** — apply `moduleSelectionRules` (e.g. `database` because `database == "postgres"`; `eval`
   because tests exist). Rules keyed on `facts.intended.*` fire from the **spec-aware hint** (e.g. add `python`
   because the specs describe FastAPI, or `database` because they describe Postgres) so a spec-first project gets
   the right modules before its code exists; the composer should note when it adds a module on a spec hint alone,
   since `intended` is a weaker signal than a materialized fact. The model may justify additional add/drop with a
   one-line reason.
3. **Component resolution** — union the components of the selected modules from `modules.json`.
4. **Constitution content** — if a `docs.constitution` already exists, *extend/align* with it (read its
   invariants); otherwise generate one from the facts using the AGENTS.md pattern. Never blindly overwrite an
   existing constitution — diff and propose.

The composer's decisions are reported to the user before writing (what profile, which modules, why).

## Step 3 — Generate (write `<project>/.claude/`)

From `bootstrap/templates/`, render into the project:

- `AGENTS.md` (or `CLAUDE.md`) — the constitution: stack, toolchain contract (the detected real commands),
  non-negotiable invariants, and pointers (never restated normative text).
- `rules/` — the selected rule packs, each with `paths:` globs tuned to the stack (e.g.
  `rules/python/*` globbed to `**/*.py`).
- `settings.json` — hook wiring using the detected commands (e.g. Stop hook runs `uv run mypy .` + `pnpm -s tsc
  --noEmit`), plus `permissions.deny` for secrets. Merges with any existing project `settings.json`.
- `memory/` — seed index + entry schema (confidence + evidence; see [METHOD.md](./METHOD.md)).
- `bundles/` — if `context-bundles` is in the profile, seed the project's first work-type bundle(s).
- references to global agents/skills (no copies) — only customized assets are written locally.

Every generated file is reported; nothing outside `<project>/.claude/` is touched without explicit approval
(generating/altering a top-level `AGENTS.md` is confirmed separately).

## Step 4 — Mark (`.claude/.forge.json`)

The idempotency marker. Schema (validated by `validate-manifests` against `schemas/marker.schema.json`):

```json
{
  "forgeVersion": "0.1.0",
  "profile": "python-next-fullstack",
  "modules": ["core", "rules-common", "review", "memory", "hooks-quality",
              "python", "typescript", "database", "eval", "context-bundles", "orchestration", "security"],
  "generatedAt": "<iso8601>",
  "facts": "profile-project.json",
  "files": [
    { "path": "AGENTS.md", "checksum": "sha256:…", "userEditable": true },
    { "path": ".claude/settings.json", "checksum": "sha256:…", "userEditable": true }
  ]
}
```

## Idempotent re-run & update (`/harness-sync`, `/harness-doctor`)

- **`/harness-init` on an already-marked project** → detects the marker, does nothing destructive, suggests
  `/harness-sync`.
- **`/harness-sync`** → re-profiles, diffs the new module set vs the marker, and for each generated file compares
  the on-disk checksum to the marker's: **unchanged files** can be upgraded to the new Forge version; **user-edited
  files** (checksum drift) are never overwritten — Forge shows a diff and proposes a merge. New modules (e.g. the
  project added Postgres) get their components added.
- **`/harness-doctor`** → read-only health check: marker present & valid, referenced global components resolve,
  hook commands still exist, Forge version drift. Reports; fixes only with `--fix`.

## Safety properties (recap)

- Detect nudges, never writes (invariant #2).
- Generation is confirmed, reported file-by-file, and additive.
- Updates are checksum-guarded — user edits are sacred.
- Hooks fail open. Markers make every operation idempotent and reversible by reference.
