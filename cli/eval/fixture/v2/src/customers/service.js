import { addCustomer, listCustomers } from './store.js';

/**
 * Register a customer.
 * @param {{tenantId: string}} ctx
 * @param {{name: string}} input
 * @returns {import('./store.js').Customer}
 */
export function registerCustomer(ctx, input) {
  if (!input || !input.name) throw new Error('registerCustomer: name is required');
  return addCustomer(ctx, input);
}

/**
 * The acting tenant's customers.
 * @param {{tenantId: string}} ctx
 * @returns {import('./store.js').Customer[]}
 */
export function myCustomers(ctx) {
  return listCustomers(ctx);
}
