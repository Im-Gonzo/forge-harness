// @ts-check
/**
 * Forge — telemetry emitter (SPEC-05, BR-TEL-001..012, ADR-0011).
 *
 * The load-bearing `emit(event)` helper that every hook imports with a RELATIVE
 * path so the hot path stays ZERO-DEPENDENCY and node-builtins-only. It records
 * ONE redacted JSONL line per decision/run site into a machine-local store —
 * BUT ONLY when the user has opted in. A fresh install records nothing.
 *
 * The five load-bearing guarantees (all tested by tests/manager/eval-tel.test.mjs
 * and tests/meta/telemetry-no-network.mjs):
 *
 *   1. OPT-IN / DEFAULT-OFF (BR-TEL-001/002). With no config.json and no env
 *      override, emit() is a pure no-op: it touches no file and creates no dir.
 *      `FORGE_TELEMETRY=1|0` overrides the config either way (env beats config).
 *   2. FAIL-OPEN (BR-TEL-003). The whole body is wrapped in try/catch; ANY failure
 *      (unwritable dir, full disk, throwing serializer) returns normally. emit() is
 *      always called AFTER a hook's decision is computed, so by construction it can
 *      never alter a deny/allow or an exit code.
 *   3. NO NETWORK (BR-TEL-004). There is NO fetch / http / net / dns / tls / socket
 *      / child_process code path anywhere. emit() performs EXACTLY ONE appendFileSync
 *      and no other exfiltrating I/O. The no-network meta-test greps this file.
 *   4. REDACTION-ON-WRITE (BR-TEL-005/006). A CLOSED per-event-type PAYLOAD_ALLOW
 *      allow-list. Every payload field not on the event's list is DROPPED *before*
 *      serialization. The store NEVER contains file contents, secret values, raw
 *      paths, commands, prompts, or env — only hashes, lengths, counts, enums,
 *      booleans, durations. `project` is a hash "h:<sha8>"; `session_id` is
 *      sanitized to [A-Za-z0-9_-].
 *   5. FIXED SCHEMA + ROTATION (BR-TEL-007/010). Every line carries exactly the
 *      fixed keys (absent values are null, never omitted). Events land in a per-UTC-
 *      day file events-YYYY-MM-DD.jsonl; when the day file reaches the size cap
 *      (default 16 MiB) it is sealed to *.full and a fresh file is started.
 *
 * Conventions: Node ESM, single file, ZERO dependencies (only node: builtins).
 */

// Default import (the CJS exports object) so a test/observer that patches
// `fs.appendFileSync` is honored — the named-binding form captures appendFileSync at
// import time and misses a later spy. We still call EXACTLY ONE appendFileSync per emit.
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event schema version (BR-TEL-007). */
const SCHEMA_V = 1;

/** The fixed key order/set every emitted line carries (BR-TEL-007). */
const SCHEMA_KEYS = [
  'v', 'ts', 'event_type', 'artifact_id', 'session_id', 'project',
  'decision', 'rule', 'tool', 'duration_ms', 'payload', 'forge_version', 'pid',
];

/** Legal `decision` values (null also legal). */
const DECISION_ENUM = new Set(['allow', 'deny', 'pass', 'fail', 'skip']);

/** Default per-day size cap before sealing (16 MiB) — overridable via config. */
const DEFAULT_MAX_BYTES_PER_DAY = 16 * 1024 * 1024;

/**
 * PAYLOAD_ALLOW — the CLOSED allow-list keyed by event_type (BR-TEL-005).
 *
 * Every payload field NOT named here for a given event_type is dropped before the
 * line is serialized. An event_type with NO entry serializes with payload:{}.
 *
 * INVARIANT (asserted by the no-network meta-test, BR-TEL-006): no list below ever
 * contains a forbidden raw-value field name (value/content/command/path/prompt/
 * env/secret/cwd/file_path). A secret/prompt has NO home here — only its hash/len.
 *
 * Frozen so it cannot be mutated at runtime.
 */
export const PAYLOAD_ALLOW = Object.freeze({
  'session.start': Object.freeze(['tailored']),
  'hook.allow': Object.freeze(['matcher']),
  'hook.deny': Object.freeze(['matcher']),
  'secret.catch': Object.freeze(['label', 'value_sha256', 'value_len']),
  'citation.gate': Object.freeze(['target_sha256', 'first_touch']),
  'loop.gate': Object.freeze(['command_sha256', 'mode']),
  'config.protect': Object.freeze(['config_kind']),
  'noverify.block': Object.freeze(['flag']),
  'typecheck.run': Object.freeze(['duration_ms', 'exit_code', 'fail_count']),
  'agent.invoke': Object.freeze(['prompt_len', 'prompt_sha256']),
  'skill.invoke': Object.freeze(['prompt_len', 'prompt_sha256']),
  'validator.run': Object.freeze(['duration_ms', 'finding_count']),
  'eval.run': Object.freeze(['duration_ms', 'case_id_sha256', 'passed']),
});

// ---------------------------------------------------------------------------
// Path resolution (machine-local; ADR-0003 / mirrors store.machineStateHome)
// ---------------------------------------------------------------------------

/**
 * The machine-local telemetry directory `<home>/.claude/forge/telemetry`. Reads
 * $HOME/$USERPROFILE at CALL time (so a sandbox HOME swap targets the temp store),
 * falling back to os.homedir(). Pure path join; does not create the directory.
 * @returns {string}
 */
export function telemetryDir() {
  const home = process.env.HOME || process.env.USERPROFILE || homedir() || '';
  return join(home, '.claude', 'forge', 'telemetry');
}

// ---------------------------------------------------------------------------
// Hashing / sanitizing helpers
// ---------------------------------------------------------------------------

/** Lowercase hex sha256 of a UTF-8 string. Mirrors bin/forge.mjs#sha256hex. */
export function sha256hex(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** Short (8 hex) project hash, prefixed "h:" — never a real path (BR-TEL-006). */
function hashProject(value) {
  return 'h:' + sha256hex(value == null ? '' : value).slice(0, 8);
}

/** Sanitize a session id to [A-Za-z0-9_-] (BR-TEL-007). Empty → 'unknown'. */
function sanitizeSession(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return 'unknown';
  const s = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return s || 'unknown';
}

// ---------------------------------------------------------------------------
// Enablement gate (env beats config; default OFF — BR-TEL-001/002)
// ---------------------------------------------------------------------------

/**
 * Resolve whether telemetry is enabled, in order:
 *   1. FORGE_TELEMETRY env: "1"→on, "0"→off (beats config either way).
 *   2. config.json {enabled} under telemetryDir().
 *   3. default OFF.
 * Returns the parsed config (or null) alongside the boolean so callers can read
 * maxBytesPerDay without a second disk read. Fail-open: any error → off/null.
 * @param {string} dir telemetry dir
 * @returns {{ enabled: boolean, config: any }}
 */
function resolveEnabled(dir) {
  const env = process.env.FORGE_TELEMETRY;
  let config = null;
  try {
    const cfgPath = join(dir, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed === 'object') config = parsed;
    }
  } catch {
    config = null;
  }
  if (env === '1') return { enabled: true, config };
  if (env === '0') return { enabled: false, config };
  const enabled = Boolean(config && config.enabled === true);
  return { enabled, config };
}

// ---------------------------------------------------------------------------
// Redaction-on-write + schema normalization (BR-TEL-005/006/007)
// ---------------------------------------------------------------------------

/**
 * Reduce an event's payload to EXACTLY the allow-listed keys for its event_type.
 * Drops every field not on the closed list; an unknown event_type → {} (BR-TEL-005).
 * @param {string} eventType
 * @param {any} payload
 * @returns {Record<string, any>}
 */
function redactPayload(eventType, payload) {
  const allow = PAYLOAD_ALLOW[eventType];
  if (!Array.isArray(allow)) return {};
  const src = payload && typeof payload === 'object' ? payload : {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of allow) {
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
  }
  return out;
}

/**
 * Normalize a caller event into the fixed schema record (BR-TEL-007). Hashes the
 * project, sanitizes the session id, coerces the decision to the enum (or null),
 * and applies redact-on-write. Absent values become null, never omitted.
 * @param {any} ev
 * @param {string} forgeVersion
 * @returns {Record<string, any>}
 */
function normalize(ev, forgeVersion) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const eventType = typeof e.event_type === 'string' ? e.event_type : 'unknown';
  let decision = e.decision;
  if (decision !== null && !DECISION_ENUM.has(decision)) decision = null;
  let durationMs = e.duration_ms;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) durationMs = null;
  const rec = {
    v: SCHEMA_V,
    ts: new Date().toISOString(),
    event_type: eventType,
    artifact_id: typeof e.artifact_id === 'string' && e.artifact_id ? e.artifact_id : null,
    session_id: sanitizeSession(e.session_id),
    project: hashProject(e.project),
    decision: decision == null ? null : decision,
    rule: typeof e.rule === 'string' && e.rule ? e.rule : null,
    tool: typeof e.tool === 'string' && e.tool ? e.tool : null,
    duration_ms: durationMs,
    payload: redactPayload(eventType, e.payload),
    forge_version: forgeVersion,
    pid: process.pid,
  };
  // Re-key into the fixed order so every line is byte-uniform.
  /** @type {Record<string, any>} */
  const ordered = {};
  for (const k of SCHEMA_KEYS) ordered[k] = rec[k];
  return ordered;
}

// ---------------------------------------------------------------------------
// Daily file resolution + size-cap sealing (BR-TEL-010)
// ---------------------------------------------------------------------------

/** UTC date stamp YYYY-MM-DD for today (the per-day file key). */
function utcDayStamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve today's current-day file, sealing it to *.full first if it is at/over
 * the size cap. Sealing is itself fail-open: a seal failure degrades to appending
 * to the existing file (never an error). Returns the absolute path to append to.
 * @param {string} dir
 * @param {number} maxBytes
 * @returns {string}
 */
function resolveDayFile(dir, maxBytes) {
  const stamp = utcDayStamp();
  const current = join(dir, `events-${stamp}.jsonl`);
  let size = 0;
  try {
    size = fs.statSync(current).size;
  } catch {
    size = 0; // absent → fresh file
  }
  if (size >= maxBytes) {
    // Seal to the next free events-YYYY-MM-DD.NN.full slot, then start fresh.
    for (let n = 0; n < 1000; n++) {
      const seq = String(n).padStart(2, '0');
      const sealed = join(dir, `events-${stamp}.${seq}.full`);
      if (!fs.existsSync(sealed)) {
        try {
          fs.renameSync(current, sealed);
        } catch {
          // Seal failed → keep appending to the existing file (fail-open).
        }
        break;
      }
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// emit() — the public surface
// ---------------------------------------------------------------------------

/**
 * Append ONE redacted JSONL line for `event` to the machine-local telemetry store,
 * but ONLY when telemetry is opted-in. Default-off is a pure no-op. The entire body
 * is wrapped in try/catch so any failure is swallowed (fail-open, BR-TEL-003) — and
 * because callers invoke emit() AFTER computing their decision, a telemetry failure
 * can never change correctness.
 *
 * Performs EXACTLY ONE appendFileSync and no network I/O (BR-TEL-004).
 *
 * @param {any} event A partial event: { event_type, tool?, rule?, decision?,
 *   session_id?, project?, artifact_id?, duration_ms?, payload? }.
 * @returns {void}
 */
export function emit(event) {
  try {
    const dir = telemetryDir();

    // 1. GATE (no-op fast path). Off → return before any file op (BR-TEL-001).
    const { enabled, config } = resolveEnabled(dir);
    if (!enabled) return;

    // 2. Normalize + redact-on-write (BR-TEL-005/006/007).
    const rec = normalize(event, readForgeVersion());

    // 3. Rotate if needed (BR-TEL-010).
    const maxBytes = resolveMaxBytes(config);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* dir may already exist or be unwritable; the append below will fail-open */
    }
    const file = resolveDayFile(dir, maxBytes);

    // 4. Append exactly one line (BR-TEL-004). One filesystem write; no network.
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // 5. Swallow everything (BR-TEL-003). Telemetry never blocks a hook.
  }
}

/** Resolve the size cap from config (test-lowered maxBytesPerDay honored). */
function resolveMaxBytes(config) {
  const v = config && config.maxBytesPerDay;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_BYTES_PER_DAY;
}

/**
 * Best-effort read of the forge VERSION (sibling of hooks/lib → ../../VERSION).
 * Fail-open to '0.0.0'. Cached after first read so emit() stays sub-ms on the hot path.
 * @returns {string}
 */
let _cachedVersion = null;
function readForgeVersion() {
  if (_cachedVersion !== null) return _cachedVersion;
  try {
    const here = new URL('.', import.meta.url).pathname;
    const raw = fs.readFileSync(join(here, '..', '..', 'VERSION'), 'utf8');
    const v = (raw || '').trim();
    _cachedVersion = v ? (v.endsWith('-design') ? v.slice(0, -'-design'.length) : v) : '0.0.0';
  } catch {
    _cachedVersion = '0.0.0';
  }
  return _cachedVersion;
}
