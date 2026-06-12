import fs from 'node:fs';
import path from 'node:path';
import { now } from '../lib/clock.js';

const EVENTS_LOG = path.join(process.cwd(), 'events.log');

/**
 * Append one event line (JSONL) to events.log.
 * @param {{tenantId: string}} ctx
 * @param {string} type - dotted event type, e.g. "order.created"
 * @param {object} payload
 * @returns {void}
 */
export function emitEvent(ctx, type, payload) {
  const line = JSON.stringify({ ts: now(), tenantId: ctx.tenantId, type, payload });
  fs.appendFileSync(EVENTS_LOG, line + '\n');
}

/**
 * Read every event currently in events.log (test/diagnostic helper).
 * @returns {Array<{ts: number, tenantId: string, type: string, payload: object}>}
 */
export function readEvents() {
  if (!fs.existsSync(EVENTS_LOG)) return [];
  return fs
    .readFileSync(EVENTS_LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Test-only: clear the events log. @returns {void} */
export function _resetEvents() {
  fs.rmSync(EVENTS_LOG, { force: true });
}
