/**
 * Public surface of the orders service. Import from here in app code.
 */
export { makeCtx } from './lib/ctx.js';
export { seedTenants } from './tenants/registry.js';
export { currentTenant, allTenants } from './tenants/service.js';
export { placeOrder, findOrder, myOrders, archiveOrder } from './orders/service.js';
export { registerCustomer, myCustomers } from './customers/service.js';
export { config } from './config.js';
