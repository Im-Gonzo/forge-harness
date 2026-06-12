import { table } from '../lib/store.js';
import { nextId } from '../lib/ids.js';
import { now } from '../lib/clock.js';
import { emitEvent } from '../events/emit.js';

const TABLE = 'orders';

/**
 * @typedef {object} Order
 * @property {string} id
 * @property {string} tenantId
 * @property {string} sku
 * @property {number} qty
 * @property {'open'|'archived'} status
 * @property {number} createdAt - epoch ms
 */

/**
 * Create an order for the acting tenant.
 * @param {{tenantId: string}} ctx
 * @param {{sku: string, qty: number, createdAt?: number}} input
 * @returns {Order}
 */
export function createOrder(ctx, input) {
  const order = {
    id: nextId('ord'),
    tenantId: ctx.tenantId,
    sku: input.sku,
    qty: input.qty,
    status: 'open',
    createdAt: input.createdAt ?? now(),
  };
  table(TABLE).set(order.id, order);
  emitEvent(ctx, 'order.created', { id: order.id });
  return order;
}

/**
 * Fetch one order the acting tenant owns, or undefined.
 * @param {{tenantId: string}} ctx
 * @param {string} id
 * @returns {Order | undefined}
 */
export function getOrder(ctx, id) {
  const row = table(TABLE).get(id);
  if (!row || row.tenantId !== ctx.tenantId) return undefined;
  return row;
}

/**
 * List the acting tenant's orders.
 * @param {{tenantId: string}} ctx
 * @returns {Order[]}
 */
export function listOrders(ctx) {
  const out = [];
  for (const row of table(TABLE).values()) {
    if (row.tenantId === ctx.tenantId) out.push(row);
  }
  return out;
}

/**
 * Set an order's status for the acting tenant. Returns the updated order, or
 * undefined if the id is not the acting tenant's.
 * @param {{tenantId: string}} ctx
 * @param {string} id
 * @param {'open'|'archived'} status
 * @returns {Order | undefined}
 */
export function setOrderStatus(ctx, id, status) {
  const row = table(TABLE).get(id);
  if (!row || row.tenantId !== ctx.tenantId) return undefined;
  row.status = status;
  emitEvent(ctx, `order.${status === 'archived' ? 'archived' : 'updated'}`, { id: row.id });
  return row;
}
