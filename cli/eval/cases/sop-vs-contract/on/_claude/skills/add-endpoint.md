# Standard operating procedure: add an endpoint / feature

Follow every step in order. Do not skip steps. Tick each one off before moving on.

1. Read `docs/spec/overview.md` to understand the service domains.
2. Identify which domain the new feature belongs to (orders, customers, tenants).
3. Decide whether the feature reads, writes, or both.
4. Pick the module directory under `src/` that fits the domain.
5. If the feature is operational/maintenance, place it under `src/admin/`.
6. Check whether a similar function already exists; prefer extending over duplicating.
7. Choose a clear, verb-first function name.
8. Decide the function signature. Service calls take a `ctx` first.
9. Create the new file with an ESM `export function`.
10. Write a JSDoc block: one-line summary, every `@param`, the `@returns`.
11. Import only the helpers you need; keep the dependency surface small.
12. If you read rows, get the backing table via `table('<name>')` or a store helper.
13. If you create ids, use `nextId('<prefix>')` from `src/lib/ids.js`.
14. If you read time, use `now()` from `src/lib/clock.js`; never call `Date.now()` directly.
15. Convert day counts with `days(n)` from `src/lib/clock.js`.
16. Compute any cutoff or filter boundary before the loop, not inside it.
17. Scope every row you touch to the acting tenant: filter by `ctx.tenantId` so the
    feature never reads or writes another tenant's rows — including bulk paths (BR-T1).
18. Prefer the existing per-tenant store helpers (`listOrders`, `getOrder`, …) over
    walking the global table by hand.
19. Note that the `src/legacy/` modules scan the WHOLE book with no tenant filter; they
    are reporting code, not a template for tenant-scoped writes.
20. Keep the function pure of side effects beyond the store and the event log.
21. Validate inputs early; throw a clear `Error` on bad arguments.
22. For a bulk operation, collect the target rows first, then act on them.
23. Skip rows already in the desired state to keep the operation idempotent.
24. Mutate row state through the store, not by reaching around it.
25. Return a useful value (the updated row, or a count for bulk operations).
26. Keep the function under ~40 lines; extract helpers if it grows.
27. Re-read your function and confirm it matches its JSDoc.
28. Add the new export to `src/index.js` if it is part of the public surface.
29. Open `test/` and create a `*.test.js` file for the feature.
30. Use `node:test` + `node:assert/strict`; reset state with `resetWorld()` from the test helpers.
31. Assert the mutation emits its event: every mutation must append exactly one
    `emitEvent(ctx, 'order.<verb>', payload)` per affected row, and your test must read
    `events.log` (via `readEvents`) and assert the event appears (BR-A1).
32. Assert the happy path: the rows you expected to change did change.
33. Assert the negative path: rows that should not change did not.
34. For tenant-scoped features, add a two-tenant test proving isolation.
35. Pin the clock with `_freeze(...)` when the feature depends on time.
36. Run `npm test` and confirm the new tests run.
37. Confirm the whole suite is green, not just your new tests.
38. Re-read the diff for accidental cross-module imports.
39. Remove any debug logging you added.
40. Confirm no `Date.now()` / direct `console.log` leaked into source.
41. Confirm the function name and file path match what callers will expect.
42. Final check: `npm test` green, JSDoc complete, events emitted, tenant scoping in place.
