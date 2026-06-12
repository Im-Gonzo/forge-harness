#!/usr/bin/env node
/**
 * sample-meta — all-kinds fixture META-TEST.
 *
 * One meta-test under tests/meta/ so the registry resolves kind=meta-test with
 * id "sample-meta" and path "tests/meta/sample-meta.mjs". Trivial and always
 * passes; the registry catalogs it but never runs it.
 *
 * Zero deps. node:assert.
 */

import assert from 'node:assert';

assert.ok(true, 'fixture meta-test placeholder');
console.log('sample-meta: PASS');
