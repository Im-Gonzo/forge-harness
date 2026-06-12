import test from 'node:test';
import assert from 'node:assert/strict';
import { resetWorld } from './helpers.js';
import { makeCtx } from '../src/lib/ctx.js';
import { currentTenant, allTenants } from '../src/tenants/service.js';

test('seed tenants are registered', () => {
  resetWorld();
  assert.ok(allTenants().length >= 2, 'at least two seed tenants');
});

test('currentTenant resolves the acting tenant', () => {
  resetWorld();
  assert.equal(currentTenant(makeCtx('acme')).name, 'Acme Corp');
});

test('makeCtx requires a tenantId', () => {
  assert.throws(() => makeCtx(''), /tenantId is required/);
});
