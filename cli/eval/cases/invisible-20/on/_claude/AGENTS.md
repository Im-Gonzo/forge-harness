# notes-fixture — constitution

Tiny in-memory notes service (forge eval fixture). Node 18+, ESM, zero dependencies.

- Run tests: `npm test`
- Source: `src/store.js` (CRUD), `src/audit.js` (audit log)
- The spec lives in `docs/SPEC.md`.

## Required reading

Before ANY change to `src/store.js`, read `.claude/bundles/store-work.md` and satisfy
every item on its checklist. The checklist items are release-blocking invariants.
