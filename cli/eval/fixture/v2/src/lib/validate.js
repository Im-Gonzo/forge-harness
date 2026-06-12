/**
 * Tiny input-validation helpers shared across service layers.
 */

/**
 * Assert a value is a non-empty string.
 * @param {unknown} v
 * @param {string} name
 * @returns {string}
 */
export function requireString(v, name) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return v;
}

/**
 * Assert a value is a positive integer.
 * @param {unknown} v
 * @param {string} name
 * @returns {number}
 */
export function requirePositiveInt(v, name) {
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return v;
}
