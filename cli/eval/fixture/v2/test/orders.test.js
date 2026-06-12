import test from 'node:test';
import assert from 'node:assert/strict';
import { resetWorld, readEvents } from './helpers.js';
import { makeCtx } from '../src/lib/ctx.js';
import { placeOrder, findOrder, myOrders, archiveOrder } from '../src/orders/service.js';

test('placeOrder creates an open order scoped to the acting tenant', () => {
  resetWorld();
  const ctx = makeCtx('acme');
  const o = placeOrder(ctx, { sku: 'WIDGET', qty: 3 });
  assert.equal(o.status, 'open');
  assert.equal(o.tenantId, 'acme');
  assert.deepEqual(
    findOrder(ctx, o.id),
    o,
    'the acting tenant can read its own order back',
  );
});

test('findOrder hides other tenants rows', () => {
  resetWorld();
  const acme = makeCtx('acme');
  const globex = makeCtx('globex');
  const o = placeOrder(acme, { sku: 'WIDGET', qty: 1 });
  assert.equal(findOrder(globex, o.id), undefined, 'globex cannot read acme order');
});

test('myOrders lists only the acting tenant orders', () => {
  resetWorld();
  const acme = makeCtx('acme');
  const globex = makeCtx('globex');
  placeOrder(acme, { sku: 'A', qty: 1 });
  placeOrder(acme, { sku: 'B', qty: 2 });
  placeOrder(globex, { sku: 'C', qty: 9 });
  assert.equal(myOrders(acme).length, 2);
  assert.equal(myOrders(globex).length, 1);
});

test('archiveOrder flips status and is tenant-scoped', () => {
  resetWorld();
  const acme = makeCtx('acme');
  const globex = makeCtx('globex');
  const o = placeOrder(acme, { sku: 'A', qty: 1 });
  assert.equal(archiveOrder(globex, o.id), undefined, 'globex cannot archive acme order');
  const archived = archiveOrder(acme, o.id);
  assert.equal(archived.status, 'archived');
});

test('every order mutation emits exactly one event carrying the tenant', () => {
  resetWorld();
  const ctx = makeCtx('acme');
  const o = placeOrder(ctx, { sku: 'A', qty: 1 });
  archiveOrder(ctx, o.id);
  const evs = readEvents();
  assert.deepEqual(
    evs.map((e) => e.type),
    ['order.created', 'order.archived'],
  );
  assert.ok(evs.every((e) => e.tenantId === 'acme'), 'each event carries the acting tenant');
});
