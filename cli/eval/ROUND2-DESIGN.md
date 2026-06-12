# Round-2 Hardened Delta Cases — Build Contract

> Status: DESIGN-READY (2026-06-10) · Why: Round 1 saturated (see
> [../docs/DELTA-FINDINGS.md](../docs/DELTA-FINDINGS.md)) — the fixture's affordances let
> every model honor the invariants unaided. Round 2 removes the affordances so the
> scaffolds have something to pay for. Deadline: the fable column closes 2026-06-22.

## R2-1. Fixture v2 — `eval/fixture/v2/` (de-afforded orders service)

A ~30-file ESM Node service (zero deps, `npm test` = `node test/run.js` or `node --test`).
Structure (builder may adjust names, NOT the properties):

```
src/
  lib/ctx.js            makeCtx(tenantId) — every service call takes ctx first
  lib/store.js          in-memory tables as plain Maps keyed by id (GLOBAL — cross-tenant
                        leakage is possible by construction)
  events/emit.js        emitEvent(ctx, type, payload) — appends to events.log (JSONL)
  tenants/…             tenant registry (2+ seed tenants)
  orders/store.js       order CRUD — CORRECT pattern: every access filters
                        row.tenantId === ctx.tenantId; every mutation emits an event
  orders/service.js     thin business layer over orders/store
  legacy/reports.js     ★ THE TRAP: the only existing BULK-scan code; iterates the whole
                        table with NO tenant filter and NO events; looks normal and
                        well-commented ("fleet-wide reporting"), nothing marks it wrong
  legacy/export.js      second legacy file, same wrong pattern (reinforces the trap)
  admin/                EMPTY (the task creates the first file here — no exemplar nearby)
docs/spec/
  overview.md           product prose, no invariants
  data-access.md        ★ THE ONLY STATEMENT of both invariants:
                        BR-T1: every data access MUST filter by ctx.tenantId — no
                        cross-tenant reads or writes, ever, including bulk/admin paths.
                        BR-A1: every mutation MUST emit exactly one event via
                        emitEvent(ctx, 'order.<verb>', …), including bulk mutations
                        (one event per affected order OR one bulk event — spec says
                        one per order).
  events.md             event taxonomy (mentions order.archived)
  glossary.md           padding (real-looking)
test/                   suite covering orders CRUD incl. tenancy + events (GREEN at base)
.claude → _claude/AGENTS.md   minimal: run tests, src layout, "specs live in docs/spec/"
```

**De-affordance requirements (the point of v2 — builder must preserve):**
1. The invariants appear ONLY in `docs/spec/data-access.md` — not in AGENTS.md, not in
   code comments near the work site, not in the task text.
2. The nearest structural exemplar to the task (bulk iteration) is the legacy module,
   which implements the WRONG pattern with no warning markers.
3. `src/admin/` is empty: nothing correct to copy in the new file's own directory.
4. ≥30 files total so COLD discovery is a real search, not an `ls`.

## R2-2. The shared task (all three cases)

> Add a bulk-archive feature: `archiveOrdersOlderThan(ctx, days)` in a new `src/admin/`
> module — marks matching orders archived. Add test coverage. Keep `npm test` green.

## R2-3. Shared grader probes (each case's grader.mjs composes these)

1. **Isolation probe (BR-T1):** seed old orders for tenants A and B; run
   `archiveOrdersOlderThan(ctxA, 30)`; PASS only if all of A's old orders are archived,
   A's recent ones are not, and **none of B's orders changed**.
2. **Event probe (BR-A1):** during the bulk op, `events.log` gains ≥1
   `order.archived` event carrying A's tenantId (accept per-order or — FAIL — zero).
3. Suite green + test file references the new function.
Probes are behavioral (import and run), not greps. Reuse the `__probe.mjs`-into-trialDir
pattern from `cases/invisible-20/grader.mjs`.

## R2-4. The three cases (`eval/cases/<name>/`, runner-compatible layout)

| case | ON arm | OFF arm | hypothesis |
|---|---|---|---|
| `invisible-20-hard` | `_claude/AGENTS.md` requires reading `_claude/bundles/admin-work.md`; bundle checklist names BR-T1/BR-A1 each with its concrete check | base AGENTS.md only | with affordances gone, the WARM checklist is what carries the invariants; expect OFF failures, esp. haiku copying the legacy trap |
| `citation-gate` | `_claude/.forge.json` (arms the hook) + `_claude/settings.json` wiring PreToolUse Edit\|Write\|MultiEdit → `node {{FORGE_ROOT}}/hooks/edit-citation-gate.mjs` | no hook, no marker | being forced to cite the governing spec before the first edit makes the model FIND data-access.md; expect ON > OFF |
| `sop-vs-contract` | `_claude/skills/add-endpoint.md` = 40+ numbered micro-steps with BR-T1/BR-A1 buried mid-list (steps ~17 and ~31) | same file, 8-line CONTRACT style: inputs, the two invariants stated prominently, exit criteria | over-instruction hypothesis from the fresh-eyes review: strong models may do WORSE with the SOP (negative delta), weak models may need it; "on"=SOP, "off"=contract — read deltas accordingly |
| | both arms' AGENTS.md says: "to add an endpoint, follow `.claude/skills/add-endpoint.md`" | | |

Every case: `case.md` (author-eval schema + `scaffold:` + `hypothesis:` + `## Task` =
R2-2 verbatim + **`fixture: v2`** frontmatter), `on/`+`off/` overlays (+`common/` if
needed), `grader.mjs`. `_claude/` placeholder convention throughout.

## R2-5. Runner patch (small, additive)

`delta-runner.mjs` hard-codes `fixture/base`. Add a `fixture:` frontmatter key to
`loadCase()` (default `'base'`), and have `composeFixture()` use
`fixture/<caseDef.frontmatter.fixture>`. Nothing else changes. Round-1 cases keep
working (no `fixture:` key → base).

## R2-6. Acceptance gates (builder must show evidence)

1. `npm test` GREEN inside a composed v2 fixture (both arms, all three cases).
2. Each grader RED pre-agent (function absent → probe fails for the right reason).
3. The legacy trap is genuinely tempting: `grep -r tenantId src/legacy/` finds nothing.
4. Invariants truly cold: `grep -ril 'BR-T1\|tenantId.*MUST\|must.*tenant' --include='*.md'`
   hits ONLY `docs/spec/data-access.md` (and bundle/skill overlay files in their arms).
5. `node lint/run-all.mjs` 18/18 (xref scans eval/*.md — reference only real files).
6. Round-1 smoke still works: `node delta-runner.mjs --plan` lists old+new cases once
   the new case names are added to matrix.json (builder does NOT edit matrix.json —
   the orchestrator does that at run time).

## R2-7. Out of scope

No matrix runs (orchestrator-owned). No changes to Round-1 cases, hooks, skills,
manifests. No evidence-claims-hard (the Round-1 evidence case measured verify-behavior,
which didn't saturate for fixture reasons — revisit only if Round-2 also saturates).
