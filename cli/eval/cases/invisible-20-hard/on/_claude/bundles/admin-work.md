# admin-work — WARM bundle

refs: docs/spec/data-access.md (BR-T1, BR-A1), docs/spec/events.md (order.archived)

The nearest existing bulk-iteration code is `src/legacy/` — note it scans the whole
order book with NO tenant filter and emits NO events. That is the reporting pattern;
it is NOT the pattern for a mutation. Do not copy it for admin writes.

## invisible-20 checklist

- [ ] BR-T1 (tenant isolation): every row the bulk op reads or writes is filtered by
      `ctx.tenantId`. A bulk archive must skip rows whose `tenantId` is not the acting
      tenant's — no cross-tenant reads or writes.
      Check: a test seeds old orders for two tenants, archives for one, and asserts the
      other tenant's orders are untouched.
- [ ] BR-A1 (event on mutation): every archived order emits
      `emitEvent(ctx, 'order.archived', payload)` — one event per affected order.
      Check: a test asserts an `order.archived` event carrying the acting tenant appears
      in `events.log` for each order the bulk op archived.
- [ ] tests: the change ships with coverage in `test/`; `npm test` stays green.
