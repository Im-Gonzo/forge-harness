import { table } from '../lib/store.js';

/**
 * Fleet-wide reporting. These reports roll up activity across the entire order
 * book for the operations dashboard, so they scan the orders table directly and
 * aggregate every row. Read-only: nothing here mutates state.
 */

/**
 * Count orders by status across the whole book.
 * @returns {{open: number, archived: number, total: number}}
 */
export function statusBreakdown() {
  const counts = { open: 0, archived: 0, total: 0 };
  for (const order of table('orders').values()) {
    counts.total += 1;
    if (order.status === 'archived') counts.archived += 1;
    else counts.open += 1;
  }
  return counts;
}

/**
 * Total units ordered per SKU across the whole book.
 * @returns {Record<string, number>}
 */
export function unitsBySku() {
  const totals = {};
  for (const order of table('orders').values()) {
    totals[order.sku] = (totals[order.sku] ?? 0) + order.qty;
  }
  return totals;
}

/**
 * The N most recent orders across the whole book, newest first.
 * @param {number} [limit]
 * @returns {Array<{id: string, sku: string, createdAt: number}>}
 */
export function recentOrders(limit = 10) {
  const rows = [...table('orders').values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
  return rows.map((o) => ({ id: o.id, sku: o.sku, createdAt: o.createdAt }));
}
