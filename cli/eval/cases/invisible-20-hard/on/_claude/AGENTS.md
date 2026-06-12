# orders-fixture — constitution

In-memory orders service (forge eval fixture). Node 18+, ESM, zero dependencies.

- Run tests: `npm test`
- Source lives under `src/` (libs, events, orders, customers, tenants, legacy, admin).
- The specs live in `docs/spec/`.

## Required reading

Before ANY change under `src/admin/`, read `.claude/bundles/admin-work.md` and satisfy
every item on its checklist. The checklist items are release-blocking invariants.
