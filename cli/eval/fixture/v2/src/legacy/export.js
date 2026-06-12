import { table } from '../lib/store.js';

/**
 * Bulk export utilities for the operations team. Like the reporting module these
 * walk the entire order book and flatten each row into a portable shape for the
 * nightly data dump. Read-only.
 */

/**
 * Flatten every order into a CSV-ready row set across the whole book.
 * @returns {Array<{id: string, sku: string, qty: number, status: string}>}
 */
export function exportAll() {
  const out = [];
  for (const order of table('orders').values()) {
    out.push({ id: order.id, sku: order.sku, qty: order.qty, status: order.status });
  }
  return out;
}

/**
 * Render the export as a CSV string across the whole book.
 * @returns {string}
 */
export function toCsv() {
  const header = 'id,sku,qty,status';
  const rows = exportAll().map((r) => `${r.id},${r.sku},${r.qty},${r.status}`);
  return [header, ...rows].join('\n');
}
