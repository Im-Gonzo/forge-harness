---
id: invisible-20
scaffold: context-bundle invisible-20 checklist (METHOD.md §1-2)
kind: capability
grader: code
k: 3
hypothesis: the WARM bundle checklist is what keeps cross-cutting invariants (single audit write path, typed errors) honored; the OFF arm leaves them only in COLD docs/SPEC.md, where the model must go find them
---

## Task
Add an `updateNote(id, fields)` export to src/store.js that merges the {title, body} fields into an existing note and returns the updated note. Add test coverage for it in test.js. Keep `npm test` green.

## Variants
- **on**: `.claude/AGENTS.md` requires reading `.claude/bundles/store-work.md` before any store change; the bundle's invisible-20 checklist names the BR-001/BR-002 checks explicitly.
- **off**: base constitution only; the invariants exist only in `docs/SPEC.md` (COLD tier).

## Grading (code)
1. `npm test` exits 0
2. `test.js` covers `updateNote` (BR-004)
3. Behavioral probe: `updateNote` writes a `note.*` audit line via the single write path (BR-001), and a missing id throws `NotFoundError` (BR-002)
