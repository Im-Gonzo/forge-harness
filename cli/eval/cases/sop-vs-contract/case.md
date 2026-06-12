---
id: sop-vs-contract
fixture: v2
scaffold: procedural SOP skill vs short contract skill, same task, de-afforded v2 fixture
kind: capability
grader: code
k: 3
hypothesis: over-instruction (fresh-eyes review). The ON arm is a 40+ step SOP with BR-T1/BR-A1 buried mid-list (steps ~17 and ~31); the OFF arm is an 8-line contract that states the two invariants prominently. Strong models may do WORSE with the SOP (negative delta — the invariants drown); weaker models may need the structure. Read deltas accordingly: "on"=SOP, "off"=contract.
---

## Task
Add a bulk-archive feature: `archiveOrdersOlderThan(ctx, days)` in a new `src/admin/` module — marks matching orders archived. Add test coverage. Keep `npm test` green.

## Variants
- **on**: `_claude/skills/add-endpoint.md` is a 40+ numbered micro-step SOP; BR-T1 (tenant isolation) and BR-A1 (event on mutation) are buried mid-list at steps ~17 and ~31.
- **off**: the same `_claude/skills/add-endpoint.md` path, but an 8-line CONTRACT — inputs, the two invariants stated up front, exit criteria.
- Both arms' `_claude/AGENTS.md` says: "to add an endpoint, follow `.claude/skills/add-endpoint.md`".

## Grading (code)
1. `npm test` exits 0.
2. A `test/` file references `archiveOrdersOlderThan`.
3. Behavioral probes: isolation (BR-T1) and event-on-mutation (BR-A1), as in R2-3.
