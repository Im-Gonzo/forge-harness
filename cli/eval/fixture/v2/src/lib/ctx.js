/**
 * Request context. Every service call takes a ctx as its first argument so the
 * acting tenant travels with the call.
 * @param {string} tenantId
 * @returns {{tenantId: string}}
 */
export function makeCtx(tenantId) {
  if (!tenantId) throw new Error('makeCtx: tenantId is required');
  return { tenantId };
}
