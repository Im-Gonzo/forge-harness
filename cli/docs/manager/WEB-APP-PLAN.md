# Forge Web — Harness Resource Manager (build plan)

> A **local** Next.js web app (`forge-web/`, sibling to `forge/`) that manages the forge harness as
> editable resources, over the manager CLI's `--json` backbone. Status: **BUILT — Phases 0–2 complete &
> verified** (2026-06-06). 7 live dashboards + editable graphs + dual-mode CRUD for all resource kinds;
> `next build` clean, harness byte-clean. Run: `cd forge-web && npm run dev`.

## Locked decisions
- **Scope:** library CRUD (agents/skills/commands/rules/hooks/bundles/memory) **+** manager **dashboards**
  (registry, dependency graph, context-budget, telemetry, eval, validation). Multi-project **fleet
  management is de-scoped** (a fleet panel may render read-only but no fleet features).
- **Build order:** viewer-first. Graphs are **editable from the start**, so the additive write-path
  (write → validate → registry rebuild) lands in **Phase 0**, not later.
- **Graphs editable:** dependency + composition graphs support drag-to-reassign / fix-dangling-ref-in-place.
- **Home:** the sibling `forge-web/` Next.js app pointing at a configurable `FORGE_ROOT`;
  runs locally. NOT bundled into the zero-dep forge plugin (it has deps).

## Architecture
```
forge-web/  (Next.js App Router · TS · Tailwind · shadcn/ui)   FORGE_ROOT → ../forge
  app/                home(status) · registry · graph · budget · telemetry · eval · validation
                      · resources/[kind]/[id]   + app/api/* (route handlers = the bridge surface)
  lib/forge-bridge/   typed wrappers over `forge <cmd> --json` (cwd=FORGE_ROOT) · fs read/write
                      · frontmatter parse↔serialize · writeResource() = write→validate→registry build
  lib/types.ts        resource model derived from forge/schemas/*.json
  components/         React Flow (@xyflow/react) graphs · Recharts charts · Monaco raw editor
                      · schema-driven forms · shadcn primitives
```
**Bridge contract (the only forge touch-point):**
- Reads: `runForge(cmd, args)` spawns `node <FORGE_ROOT>/bin/forge.mjs <cmd> --json` **with `cwd:
  FORGE_ROOT`** (critical — the CLI resolves `.forge/registry.json` relative to cwd) and returns the
  parsed C3 envelope.
- Writes: additive file write → `forge validate --json` (surface findings inline) → `forge registry
  build --write`. Advisory WARNs shown, never blocking (ADR-0007 holds in the UI).
- The UI **never** reimplements forge logic; the `--json` backbone is the API.

## Dual-mode editing pattern (every editable resource)
Tabs: **Visual** (schema-driven form / graph) · **Raw** (Monaco on the file) · **Validate/Preview**
(live `forge validate --json` + additive-write diff). Visual ↔ Raw are two projections of one file.

| Resource | Visual editor highlight |
|---|---|
| Agent | tools/model pickers + routing mini-graph |
| Skill | form + section editor |
| Command | form (desc/argument-hint/allowed-tools) |
| Rule | **live "which files match these `paths:` globs"** + budget cost |
| Hook | **lifecycle board** (event columns → hook cards) + "test vs sample stdin" |
| Bundle | 16-field structured form (invariants 1–10, ADR/spec/BR pointer **resolve-status**, `human_gate`) |
| Memory | **confidence slider (0–1)** + `[[wiki-link]]` graph |
| Profiles/Modules | **composition graph** (profile→module→component, drag-to-assign) |

## Manager dashboards (read, over `--json`)
- **Registry** — table of all artifacts (uid/kind/version/revision/status/criticality/modules/hash/eval).
- **Dependency graph** — React Flow; dangling refs red, orphans flagged; click edge → edit the source.
- **Context budget** — treemap/bars of always-on token cost per artifact + per profile (`forge analyze`).
- **Telemetry** — time-series over the JSONL (opt-in). **Eval** — coverage + grades + run-live trigger.
- **Validation/health** — `forge validate --json` findings (click → file:line); `forge status` = home.

## Phased dispatch
- **Phase 0 — Scaffold & bridge (sequential foundation).** create-next-app + ALL deps (@xyflow/react,
  @monaco-editor/react, recharts, gray-matter, shadcn, lucide) + design system + config + the
  `forge-bridge` + types + read APIs + the **home `forge status` dashboard**. *Gate: app builds; home
  shows live registry (69 artifacts) + validate status from the real forge repo via the bridge.*
- **Phase 1 — Viewer + editable graphs (∥ agent per dashboard).** registry table · **editable**
  dependency graph · **editable** composition graph · budget · telemetry · eval · validation. Disjoint
  routes/components over the Phase-0 foundation; graph edits use the write-path.
- **Phase 2 — Resource CRUD (∥ agent per resource type).** dual-mode editors + create/delete +
  validate + registry rebuild for agents/skills/commands/rules/hooks/bundles/memory.

Proportionality: Phase 0+1 is the proportionate first target — a genuinely useful viewer+graph editor
that proves the architecture before the heavier per-resource CRUD.

## Build discipline (carried from the manager)
Single-writer on shared files (package.json, layout, theme) in Phase 0; parallel agents only on disjoint
routes thereafter. `isMain`-style guards N/A (browser/Next), but the **vacuity check** carries: gate
audits run `next build` AND exercise the bridge against the real repo (not just "it compiles"). Tests:
API-contract tests + Playwright e2e where feasible.
