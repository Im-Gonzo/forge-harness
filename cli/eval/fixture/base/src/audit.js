import fs from 'node:fs';
import path from 'node:path';

const AUDIT_LOG = path.join(process.cwd(), 'audit.log');

/**
 * Append one audit line. The ONLY sanctioned write path for mutations (BR-001).
 * @param {string} action - dotted verb, e.g. "note.create"
 * @param {object} payload - minimal identifying payload
 * @returns {void}
 */
export function appendAudit(action, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), action, payload });
  fs.appendFileSync(AUDIT_LOG, line + '\n');
}
