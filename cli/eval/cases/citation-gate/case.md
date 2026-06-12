---
id: citation-gate
fixture: v2
scaffold: edit-citation-gate PreToolUse hook (METHOD.md §9) on the de-afforded v2 fixture
kind: capability
grader: code
k: 3
hypothesis: being forced to cite the governing spec before the first edit makes the model FIND docs/spec/data-access.md before writing the admin module, so it carries BR-T1/BR-A1 into the code. Expect ON > OFF.
---

## Task
Add a bulk-archive feature: `archiveOrdersOlderThan(ctx, days)` in a new `src/admin/` module — marks matching orders archived. Add test coverage. Keep `npm test` green.

## Variants
- **on**: `_claude/.forge.json` marks the tree as a Forge-tailored harness (arming the hook), and `_claude/settings.json` wires `PreToolUse` `Edit|Write|MultiEdit` → `node {{FORGE_ROOT}}/hooks/edit-citation-gate.mjs`. Before the first edit/write the agent must cite the governing rule/spec, which drives it to the COLD spec.
- **off**: no marker and no hook wiring; the invariants exist solely COLD in `docs/spec/data-access.md`.

## Grading (code)
1. `npm test` exits 0.
2. A `test/` file references `archiveOrdersOlderThan`.
3. Behavioral probes: isolation (BR-T1) and event-on-mutation (BR-A1), as in R2-3.
