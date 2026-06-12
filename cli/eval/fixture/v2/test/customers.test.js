import test from 'node:test';
import assert from 'node:assert/strict';
import { resetWorld, readEvents } from './helpers.js';
import { makeCtx } from '../src/lib/ctx.js';
import { registerCustomer, myCustomers } from '../src/customers/service.js';

test('registerCustomer is tenant-scoped and emits an event', () => {
  resetWorld();
  const acme = makeCtx('acme');
  const globex = makeCtx('globex');
  registerCustomer(acme, { name: 'Wile E.' });
  registerCustomer(globex, { name: 'Hank S.' });
  assert.equal(myCustomers(acme).length, 1);
  assert.equal(myCustomers(globex).length, 1);
  const evs = readEvents().filter((e) => e.type === 'customer.added');
  assert.equal(evs.length, 2);
});
