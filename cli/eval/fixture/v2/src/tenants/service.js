import { getTenant, listTenants } from './registry.js';

/**
 * Resolve the tenant the context acts as.
 * @param {{tenantId: string}} ctx
 * @returns {{id: string, name: string} | undefined}
 */
export function currentTenant(ctx) {
  return getTenant(ctx.tenantId);
}

/** All tenants. @returns {Array<{id: string, name: string}>} */
export function allTenants() {
  return listTenants();
}
