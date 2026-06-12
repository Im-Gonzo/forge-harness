/**
 * In-memory tables. Each table is a plain Map keyed by row id and is process-
 * global — there is no per-tenant partitioning at this layer, so a caller that
 * forgets to scope a query sees every tenant's rows. Scoping is the caller's job.
 */
const tables = new Map();

/**
 * Get (creating if needed) the Map backing a named table.
 * @param {string} name
 * @returns {Map<string, object>}
 */
export function table(name) {
  let t = tables.get(name);
  if (!t) {
    t = new Map();
    tables.set(name, t);
  }
  return t;
}

/** Test-only: drop every table. @returns {void} */
export function _resetStore() {
  tables.clear();
}
