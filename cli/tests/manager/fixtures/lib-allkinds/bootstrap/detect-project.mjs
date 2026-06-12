#!/usr/bin/env node
/**
 * detect-project — all-kinds fixture ENGINE script.
 *
 * One engine script under bootstrap/ so the registry resolves kind=engine with
 * id "bootstrap/detect-project" (path-relative under bootstrap/) and path
 * "bootstrap/detect-project.mjs". Trivial no-op; cataloged, never run by the
 * registry build.
 *
 * Zero deps; fail-open.
 */

function main() {
  // A real engine script would inspect the project; the fixture does nothing.
  process.exit(0);
}

main();
