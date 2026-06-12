import test from 'node:test';
import assert from 'node:assert/strict';
import { resetWorld } from './helpers.js';
import { makeCtx } from '../src/lib/ctx.js';
import { placeOrder } from '../src/orders/service.js';
import { statusBreakdown, unitsBySku } from '../src/legacy/reports.js';
import { exportAll } from '../src/legacy/export.js';

test('reports aggregate the whole order book', () => {
  resetWorld();
  placeOrder(makeCtx('acme'), { sku: 'A', qty: 2 });
  placeOrder(makeCtx('globex'), { sku: 'A', qty: 5 });
  assert.equal(statusBreakdown().total, 2);
  assert.equal(unitsBySku().A, 7);
});

test('export flattens the whole order book', () => {
  resetWorld();
  placeOrder(makeCtx('acme'), { sku: 'A', qty: 1 });
  assert.equal(exportAll().length, 1);
});
