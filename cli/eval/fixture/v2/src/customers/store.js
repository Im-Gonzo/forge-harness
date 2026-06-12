import { table } from '../lib/store.js';
import { nextId } from '../lib/ids.js';
import { emitEvent } from '../events/emit.js';

const TABLE = 'customers';

/**
 * @typedef {object} Customer
 * @property {string} id
 * @property {string} tenantId
 * @property {string} name
 */

/**
 * Register a customer for the acting tenant.
 * @param {{tenantId: string}} ctx
 * @param {{name: string}} input
 * @returns {Customer}
 */
export function addCustomer(ctx, input) {
  const row = { id: nextId('cust'), tenantId: ctx.tenantId, name: input.name };
  table(TABLE).set(row.id, row);
  emitEvent(ctx, 'customer.added', { id: row.id });
  return row;
}

/**
 * List the acting tenant's customers.
 * @param {{tenantId: string}} ctx
 * @returns {Customer[]}
 */
export function listCustomers(ctx) {
  const out = [];
  for (const row of table(TABLE).values()) {
    if (row.tenantId === ctx.tenantId) out.push(row);
  }
  return out;
}
