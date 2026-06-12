/**
 * Indirection over the wall clock so tests can pin "now" without monkey-patching
 * Date. Production code reads time through here.
 */
let frozen = null;

/** @returns {number} epoch milliseconds */
export function now() {
  return frozen == null ? Date.now() : frozen;
}

/** Test-only: pin now() to a fixed epoch. @param {number} ms @returns {void} */
export function _freeze(ms) {
  frozen = ms;
}

/** Test-only: restore the real clock. @returns {void} */
export function _unfreeze() {
  frozen = null;
}

/** Convert a day count to milliseconds. @param {number} days @returns {number} */
export function days(n) {
  return n * 24 * 60 * 60 * 1000;
}
