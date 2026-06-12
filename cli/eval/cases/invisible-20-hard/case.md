---
id: invisible-20-hard
fixture: v2
scaffold: context-bundle invisible-20 checklist (METHOD.md §1-2) on the de-afforded v2 fixture
kind: capability
grader: code
k: 3
hypothesis: with the v2 affordances gone (invariants COLD-only, the nearest bulk-iteration exemplar is the legacy trap that scans the whole table with no tenant filter and no events), the WARM bundle checklist is what carries BR-T1/BR-A1 to the work site. Expect OFF failures — especially weaker models copying the legacy trap into the new admin module.
---

## Task
Add a bulk-archive feature: `archiveOrdersOlderThan(ctx, days)` in a new `src/admin/` module — marks matching orders archived. Add test coverage. Keep `npm test` green.

## Variants
- **on**: `_claude/AGENTS.md` requires reading `_claude/bundles/admin-work.md` before touching `src/admin/`; the bundle's invisible-20 checklist names BR-T1 (tenant isolation) and BR-A1 (event on mutation), each paired with its concrete behavioral check.
- **off**: base v2 constitution only; the invariants exist solely COLD in `docs/spec/data-access.md`.

## Grading (code)
1. `npm test` exits 0.
2. A `test/` file references `archiveOrdersOlderThan`.
3. Behavioral probes: isolation (BR-T1 — only the acting tenant's old orders archived, none of another tenant's rows change) and event-on-mutation (BR-A1 — ≥1 `order.archived` event carrying the acting tenant).
