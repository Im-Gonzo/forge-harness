import { listOrders } from './store.js';

/**
 * The acting tenant's open orders.
 * @param {{tenantId: string}} ctx
 * @returns {import('./store.js').Order[]}
 */
export function openOrders(ctx) {
  return listOrders(ctx).filter((o) => o.status === 'open');
}

/**
 * The acting tenant's orders created before a given epoch.
 * @param {{tenantId: string}} ctx
 * @param {number} beforeMs
 * @returns {import('./store.js').Order[]}
 */
export function ordersCreatedBefore(ctx, beforeMs) {
  return listOrders(ctx).filter((o) => o.createdAt < beforeMs);
}
