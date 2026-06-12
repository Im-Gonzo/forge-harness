#!/usr/bin/env node
/**
 * validate-sample — all-kinds fixture VALIDATOR.
 *
 * One auto-discoverable validator (validate-*.mjs) under lint/ so the registry
 * resolves kind=validator with id "validate-sample" and path
 * "lint/validate-sample.mjs". It is intentionally trivial and always PASSes;
 * the registry only catalogs it — it is never executed by the registry build.
 *
 * Zero dependencies; self-contained.
 */

const NAME = 'validate-sample';

function main() {
  // Nothing to validate in a fixture; this exists to be discovered, not run.
  console.log(`${NAME}: 0 file(s), 0 error(s), 0 warning(s) — PASS`);
  process.exit(0);
}

main();
