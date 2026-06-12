# store-work — WARM bundle

refs: docs/SPEC.md (BR-001, BR-002, BR-004)

## invisible-20 checklist

- [ ] BR-001 (single write path): every mutation calls `appendAudit('note.<verb>', payload)`
      from `src/audit.js` — exactly one audit line per mutation.
      Check: a test asserts the new mutation's audit line appears in `audit.log`.
- [ ] BR-002 (typed errors): any operation on a missing id throws `NotFoundError`.
      Check: a test asserts the throw with `assert.throws(..., NotFoundError)`.
- [ ] BR-004 (tests): the change ships with test coverage in `test.js`; `npm test` green.
