import { table } from '../lib/store.js';

const TABLE = 'tenants';

const SEED = [
  { id: 'acme', name: 'Acme Corp' },
  { id: 'globex', name: 'Globex Inc' },
  { id: 'initech', name: 'Initech LLC' },
];

/** Seed the tenant registry (idempotent). @returns {void} */
export function seedTenants() {
  const t = table(TABLE);
  for (const row of SEED) {
    if (!t.has(row.id)) t.set(row.id, { ...row });
  }
}

/**
 * Look up a tenant by id.
 * @param {string} id
 * @returns {{id: string, name: string} | undefined}
 */
export function getTenant(id) {
  return table(TABLE).get(id);
}

/** List every registered tenant. @returns {Array<{id: string, name: string}>} */
export function listTenants() {
  return [...table(TABLE).values()];
}
