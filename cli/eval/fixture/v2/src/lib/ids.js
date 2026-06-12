let counter = 0;

/**
 * Monotonic id generator for in-memory rows. Deterministic within a process so
 * tests can rely on insertion order.
 * @param {string} [prefix]
 * @returns {string}
 */
export function nextId(prefix = 'id') {
  counter += 1;
  return `${prefix}_${counter}`;
}

/** Test-only: reset the id counter. @returns {void} */
export function _resetIds() {
  counter = 0;
}
