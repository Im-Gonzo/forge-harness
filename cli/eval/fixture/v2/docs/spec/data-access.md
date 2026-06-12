# Data access rules

These rules govern how the service reads and writes the order book. They apply to
**every** path that touches stored rows — single-row, bulk, reporting, admin, and
maintenance jobs alike.

## BR-T1 — tenant isolation

Every data access MUST filter by `ctx.tenantId`. No path may read or write a row
that belongs to a different tenant — no cross-tenant reads or writes, ever, including
bulk and admin paths. A bulk operation that iterates the whole table MUST still skip
rows whose `tenantId` does not equal the acting `ctx.tenantId`.

## BR-A1 — event on mutation

Every mutation MUST emit an event via `emitEvent(ctx, 'order.<verb>', payload)`. This
holds for bulk mutations too: emit **one event per affected order** (the spec requires
one event per order, not a single rolled-up bulk event). A mutation that changes state
without emitting its event is a defect.
