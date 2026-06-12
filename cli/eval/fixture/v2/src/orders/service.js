import { createOrder, getOrder, listOrders, setOrderStatus } from './store.js';

/**
 * Place a new order.
 * @param {{tenantId: string}} ctx
 * @param {{sku: string, qty: number, createdAt?: number}} input
 * @returns {import('./store.js').Order}
 */
export function placeOrder(ctx, input) {
  if (!input || !input.sku || !(input.qty > 0)) {
    throw new Error('placeOrder: sku and a positive qty are required');
  }
  return createOrder(ctx, input);
}

/**
 * Fetch an order.
 * @param {{tenantId: string}} ctx
 * @param {string} id
 * @returns {import('./store.js').Order | undefined}
 */
export function findOrder(ctx, id) {
  return getOrder(ctx, id);
}

/**
 * Every order the acting tenant can see.
 * @param {{tenantId: string}} ctx
 * @returns {import('./store.js').Order[]}
 */
export function myOrders(ctx) {
  return listOrders(ctx);
}

/**
 * Archive a single order by id.
 * @param {{tenantId: string}} ctx
 * @param {string} id
 * @returns {import('./store.js').Order | undefined}
 */
export function archiveOrder(ctx, id) {
  return setOrderStatus(ctx, id, 'archived');
}
