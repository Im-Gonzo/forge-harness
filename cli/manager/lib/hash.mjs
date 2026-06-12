// @ts-check
/**
 * hash — the single content-identity helper for the manager (ADR-0005, SPEC-00 §lib).
 *
 * The registry keys every artifact by a `contentHash` (raw file bytes; for a hook,
 * the canonical JSON of its `hooks.json` entry — SPEC-01). That hash MUST be the
 * exact same function `bin/forge.mjs#sha256hex` already uses, or the manager and the
 * CLI would disagree about artifact identity. This module mirrors that helper so the
 * one definition can be shared by every manager lib.
 *
 * Conventions: Node ESM, ZERO dependencies (node: builtins only). Fail-open at the
 * public boundary: a hash of an unencodable input degrades to the hash of its string
 * coercion rather than throwing.
 */

import { createHash } from 'node:crypto';

/**
 * Lowercase hex SHA-256 of a string or Buffer.
 *
 * Mirrors `bin/forge.mjs#sha256hex`: a UTF-8 string hashes identically here. A
 * `Buffer` (or any `Uint8Array`) is hashed by its raw bytes — used for binary or
 * pre-canonicalised inputs (e.g. a hook's canonical-JSON bytes).
 *
 * @param {string | Buffer | Uint8Array} input Bytes to hash. A string is encoded as UTF-8.
 * @returns {string} 64-char lowercase hex SHA-256 digest.
 */
export function sha256hex(input) {
  const h = createHash('sha256');
  if (typeof input === 'string') {
    h.update(input, 'utf8');
  } else {
    // Buffer / Uint8Array — hash the raw bytes. Coerce anything else via String()
    // so the boundary never throws (fail-open).
    h.update(input instanceof Uint8Array ? input : Buffer.from(String(input), 'utf8'));
  }
  return h.digest('hex');
}
