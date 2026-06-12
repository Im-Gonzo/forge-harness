# Contract: add an endpoint / feature

**Inputs:** a `ctx` (carries the acting `tenantId`) first, then the feature's arguments.

**Invariants (both are release-blocking):**
- **BR-T1 — tenant isolation:** filter every row you read or write by `ctx.tenantId`; never touch another tenant's rows, including bulk paths.
- **BR-A1 — event on mutation:** every mutation emits `emitEvent(ctx, 'order.<verb>', payload)` — one event per affected row.

**Exit criteria:** the feature ships with tests proving both invariants, and `npm test` is green.
