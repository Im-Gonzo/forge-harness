#!/usr/bin/env node
// @ts-check
/**
 * telemetry-no-network — the forge-validates-forge meta-test for telemetry
 * (SPEC-05, BR-TEL-004 / BR-TEL-006, ADR-0011 / ADR-0014).
 *
 * Two static guarantees over the telemetry surface, asserted as SOURCE invariants
 * so "local-only / no exfiltration" and "redaction allow-list integrity" are
 * TESTED, not merely promised:
 *
 *   (A) NO NETWORK SURFACE. The three telemetry sources
 *         hooks/lib/telemetry.mjs        (the emitter)
 *         hooks/invoke-telemetry.mjs     (the Task|Skill start hook)
 *         manager/telemetry.mjs          (the CLI readers)
 *       contain ZERO network identifiers after comment-stripping: no fetch(, no
 *       node:http/https, no node:net/dgram/dns/tls, no child_process, no Socket /
 *       createConnection / .connect(, no WebSocket / XMLHttpRequest. A telemetry
 *       source that ever reaches for a socket fails this test (BR-TEL-004).
 *
 *   (B) PAYLOAD_ALLOW INTEGRITY. Every taxonomy event_type has a CLOSED allow-list,
 *       and NO list ever whitelists a forbidden raw-value field name
 *       (value/content/command/path/prompt/env/secret/cwd/file_path). A secret,
 *       a prompt, or a raw path has no home in the store by construction
 *       (BR-TEL-005 / BR-TEL-006).
 *
 * Mirrors the static halves of EVAL-TEL-004 / EVAL-TEL-006 so a regression is
 * caught by `node tests/run-meta.mjs` as well as by the node:test suite. NO
 * MODEL CALLS, NO NETWORK: a pure source scan + a frozen-object inspection.
 *
 * Zero deps. node:assert. Exit 1 on any failure.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

const SOURCES = [
  ['hooks/lib/telemetry.mjs', path.join(FORGE_ROOT, 'hooks', 'lib', 'telemetry.mjs')],
  ['hooks/invoke-telemetry.mjs', path.join(FORGE_ROOT, 'hooks', 'invoke-telemetry.mjs')],
  ['manager/telemetry.mjs', path.join(FORGE_ROOT, 'manager', 'telemetry.mjs')],
];

// The forbidden network identifiers (same shape as the eval's FORBIDDEN_NET). The
// regexes are specific so a benign word in a comment is not matched (comments are
// stripped first); a network specifier inside a string literal IS still caught.
const FORBIDDEN_NET = [
  ['fetch(', /\bfetch\s*\(/],
  ['node:http(s)', /['"]node:https?['"]|require\(\s*['"]https?['"]\s*\)|from\s+['"]node:https?['"]/],
  ['node:net', /['"]node:net['"]|from\s+['"]node:net['"]/],
  ['node:dgram', /['"]node:dgram['"]/],
  ['node:dns', /['"]node:dns['"]/],
  ['node:tls', /['"]node:tls['"]/],
  ['child_process', /node:child_process|require\(\s*['"]child_process['"]\s*\)|from\s+['"]child_process['"]/],
  ['Socket/connect', /\bnew\s+(?:net\.)?Socket\b|\.createConnection\b|\.connect\s*\(/],
  ['WebSocket', /\bWebSocket\b/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
];

// Field names that MUST NEVER be whitelisted by PAYLOAD_ALLOW for any event type.
const FORBIDDEN_PAYLOAD_FIELDS = [
  'value', 'content', 'command', 'path', 'prompt', 'env', 'secret', 'cwd', 'file_path',
];

/** Strip `//…` and block comments from JS source (best-effort). */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readSrc(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

let failures = 0;
/** @param {string} msg */
function check(cond, msg) {
  if (cond) return;
  failures++;
  process.stderr.write(`ERROR [telemetry-no-network]: ${msg}\n`);
}

// (A) No-network static scan.
for (const [label, abs] of SOURCES) {
  const raw = readSrc(abs);
  check(raw.length > 0, `${label} must exist (no-network scan target)`);
  const code = stripComments(raw);
  for (const [id, re] of FORBIDDEN_NET) {
    check(!re.test(code), `${label} must contain no network identifier: ${id}`);
  }
}

// (B) PAYLOAD_ALLOW integrity — import the frozen allow-list and inspect it.
const mod = await import(path.join(FORGE_ROOT, 'hooks', 'lib', 'telemetry.mjs'));
const PAYLOAD_ALLOW = mod.PAYLOAD_ALLOW;
check(PAYLOAD_ALLOW && typeof PAYLOAD_ALLOW === 'object', 'PAYLOAD_ALLOW must be exported as an object');

// Every taxonomy event_type referenced in SPEC-05 has a closed list.
const REQUIRED_TYPES = [
  'session.start', 'hook.allow', 'hook.deny', 'secret.catch', 'citation.gate',
  'config.protect', 'noverify.block', 'typecheck.run', 'agent.invoke',
  'skill.invoke', 'validator.run', 'eval.run',
];
for (const t of REQUIRED_TYPES) {
  check(Array.isArray(PAYLOAD_ALLOW[t]), `PAYLOAD_ALLOW must have a closed list for event_type "${t}"`);
}

// No list whitelists a forbidden raw-value field name (BR-TEL-006).
for (const [etype, fields] of Object.entries(PAYLOAD_ALLOW || {})) {
  const list = Array.isArray(fields) ? fields : [];
  for (const bad of FORBIDDEN_PAYLOAD_FIELDS) {
    check(!list.includes(bad), `PAYLOAD_ALLOW[${etype}] must NOT whitelist forbidden field "${bad}"`);
  }
}

if (failures > 0) {
  process.stderr.write(`telemetry-no-network: FAIL (${failures} issue(s))\n`);
  process.exit(1);
}
process.stdout.write('telemetry-no-network: PASS (no network surface; PAYLOAD_ALLOW closed & clean)\n');
process.exit(0);
