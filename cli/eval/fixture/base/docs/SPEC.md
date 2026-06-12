# Notes service — spec

- **BR-001 (single write path):** EVERY mutation of the store MUST call `appendAudit(action, payload)`
  from `src/audit.js`, with `action` of the form `note.<verb>`. No mutation may change store state
  without exactly one audit line.
- **BR-002 (typed errors):** any operation that references a missing note id MUST throw `NotFoundError`.
- **BR-003 (docs):** every exported function carries JSDoc with `@param` / `@returns`.
- **BR-004 (tests):** every behavior change ships with a test in `test.js`; `npm test` must stay green.
