// @ts-check
/**
 * eval-tel.test.mjs — executable acceptance specs for Telemetry & Monitoring
 * (SPEC-05, BR-TEL-001..014, ADR-0011). Covers the **Phase-v0.4 EVAL-TEL** cases
 * from docs/manager/evals/EVAL-TEL.md:
 *
 *   EVAL-TEL-001  opt-in: default OFF records nothing (no dir, no line)        [GATE]
 *   EVAL-TEL-002  env override beats config (FORGE_TELEMETRY=0/1)
 *   EVAL-TEL-003  fail-open: a broken emit never blocks the hook decision
 *   EVAL-TEL-004  no network surface (static scan + one-appendFileSync probe)  [GATE]
 *   EVAL-TEL-005  redaction-on-write via the closed PAYLOAD_ALLOW allow-list
 *   EVAL-TEL-006  a secret value never appears in JSONL (only hash + length)   [GATE]
 *   EVAL-TEL-007  event schema is fixed and uniform
 *   EVAL-TEL-008  taxonomy coverage at the real decision sites
 *   EVAL-TEL-009  honest durations; unknown null (never 0); no token/cost field
 *   EVAL-TEL-010  daily rotation + a hard size cap (seal to *.full)
 *   EVAL-TEL-011  lazy retention pruning (no daemon)
 *   EVAL-TEL-012  storage is machine-local & physically un-committable (.gitignore *)
 *   EVAL-TEL-013  readers degrade gracefully when off/empty (exit 0, off message)
 *   EVAL-TEL-014  consumers tolerate the empty store (efficiency → static-only)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HONEST RED — none of the v0.4 telemetry surface exists yet:
 *   - hooks/lib/telemetry.mjs        emit(event) + PAYLOAD_ALLOW (zero-dep; redact-on-write)
 *   - hooks/invoke-telemetry.mjs     PreToolUse Task|Skill → agent.invoke/skill.invoke
 *   - manager/telemetry.mjs          forge stat|monitor|telemetry on|off|status|prune|wipe (run()/summarize())
 *   - bin/forge.mjs telemetry/monitor/stat bodies (today: a "planned v0.4" notice / unknown verb)
 *   - the five hook decision sites + CLI validator.run/eval.run emit() call points
 *
 * For an unbuilt MODULE we dynamic-import INSIDE the test body wrapped in try/catch,
 * then assert the module + the named export exist — a missing module becomes an
 * assertion FAILURE (RED), never a crash that aborts the node:test runner. The
 * telemetry emitter is by CONTRACT a library helper (no top-level process.exit(),
 * no model call), so importing it is safe once it exists; the manager reader module
 * MUST have an isMain() guard (mirrors registry/status/fleet/efficiency) so it never
 * exits at import time either. We NEVER import a HOOK script (secret-scan.mjs et al.)
 * — those call process.exit(0) at top level, which would silently kill the runner —
 * we drive them across a PROCESS BOUNDARY via spawnSync with a stubbed stdin payload.
 * For CLI behavior we spawnSync `node bin/forge.mjs …` and assert on stdout/exit.
 *
 * NO MODEL CALLS, NO NETWORK: every case is deterministic, offline, fixture-driven.
 * The no-network case (EVAL-TEL-004) is itself a static source scan plus a behavioral
 * one-appendFileSync probe — it never opens a socket.
 *
 * Zero runtime deps (node: builtins only). Each test is self-cleaning: a fresh temp
 * HOME (and FORGE_ROOT-relative sandbox) is SYNTHESIZED into os.tmpdir() via
 * fs.mkdtempSync; the real repo, the real ~/.claude, and the frozen fixtures are
 * NEVER mutated. The telemetry store always resolves under <tempHOME>/.claude/forge/
 * telemetry/ (store.machineStateHome() + bin resolveClaudeHome() both read $HOME).
 * Run model: `node --test tests/manager/`.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const FORGE_BIN = path.join(FORGE_ROOT, 'bin', 'forge.mjs');

// The v0.4 telemetry surface this file targets (all RED today).
const TELEMETRY_EMIT_MODULE = path.join(FORGE_ROOT, 'hooks', 'lib', 'telemetry.mjs');
const INVOKE_TELEMETRY_HOOK = path.join(FORGE_ROOT, 'hooks', 'invoke-telemetry.mjs');
const TELEMETRY_READER_MODULE = path.join(FORGE_ROOT, 'manager', 'telemetry.mjs');

// Existing hook scripts driven across a process boundary (NEVER imported — they
// process.exit(0) at top level).
const SECRET_SCAN_HOOK = path.join(FORGE_ROOT, 'hooks', 'secret-scan.mjs');
const CITATION_GATE_HOOK = path.join(FORGE_ROOT, 'hooks', 'edit-citation-gate.mjs');
const CONFIG_PROTECTION_HOOK = path.join(FORGE_ROOT, 'hooks', 'config-protection.mjs');
const BLOCK_NO_VERIFY_HOOK = path.join(FORGE_ROOT, 'hooks', 'block-no-verify.mjs');

// The fixed event schema (BR-TEL-007). Every emitted line MUST carry EXACTLY these
// keys (absent values are null, never omitted).
const SCHEMA_KEYS = [
  'v', 'ts', 'event_type', 'artifact_id', 'session_id', 'project',
  'decision', 'rule', 'tool', 'duration_ms', 'payload', 'forge_version', 'pid',
];
const DECISION_ENUM = new Set(['allow', 'deny', 'pass', 'fail', 'skip']); // null also legal

// The forbidden network identifiers the no-network meta-scan greps for (BR-TEL-004).
// Authored as `[label, RegExp]`; the regexes are deliberately specific so a benign
// substring (e.g. the word "fetch" inside a comment about NOT fetching) is matched
// only as an actual code identifier/specifier — comments are stripped first.
const FORBIDDEN_NET = [
  ['fetch(', /\bfetch\s*\(/],
  ['node:http', /['"]node:https?['"]|require\(\s*['"]https?['"]\s*\)|from\s+['"]node:https?['"]/],
  ['node:net', /['"]node:net['"]|from\s+['"]node:net['"]/],
  ['node:dgram', /['"]node:dgram['"]/],
  ['node:dns', /['"]node:dns['"]/],
  ['node:tls', /['"]node:tls['"]/],
  ['child_process', /node:child_process|require\(\s*['"]child_process['"]\s*\)|from\s+['"]child_process['"]/],
  ['Socket', /\bnew\s+(?:net\.)?Socket\b|\.createConnection\b|\.connect\s*\(/],
  ['WebSocket', /\bWebSocket\b/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
];

// Field names that MUST NEVER be whitelisted by PAYLOAD_ALLOW for any event type
// (BR-TEL-006 meta-assertion). A secret/raw value must never have a home.
const FORBIDDEN_PAYLOAD_FIELDS = [
  'value', 'content', 'command', 'path', 'prompt', 'env', 'secret', 'cwd', 'file_path',
];

// ---------------------------------------------------------------------------
// Sandbox helpers — a fresh temp HOME per test. The telemetry store always lands
// under <HOME>/.claude/forge/telemetry/. Nothing here touches the real repo, the
// real ~/.claude, or the frozen fixtures.
// ---------------------------------------------------------------------------

/** Make a fresh temp HOME sandbox; return { home, telDir }. @param {string} tag */
function mkHome(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `forge-tel-${tag}-`));
  return { home, telDir: path.join(home, '.claude', 'forge', 'telemetry') };
}

/** Remove a sandbox dir best-effort (fail-open in teardown). @param {string} root */
function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Write a file, creating parent dirs. @param {string} abs @param {string} body */
function writeFileAbs(abs, body) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

/** A child env with a sandbox HOME and telemetry forced to a known state. */
function envWith(home, extra = {}) {
  return { ...process.env, HOME: home, USERPROFILE: home, ...extra };
}

/** Read every JSONL/full telemetry line in the store dir as parsed records. */
function readAllEvents(telDir) {
  /** @type {any[]} */
  const out = [];
  let names;
  try {
    names = fs.readdirSync(telDir);
  } catch {
    return out; // store absent → no events
  }
  for (const name of names) {
    if (!/^events-.*\.(jsonl|full)$/.test(name) && !name.endsWith('.jsonl') && !name.endsWith('.full')) {
      continue;
    }
    if (!/\.(jsonl|full)$/.test(name)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(telDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      out.push({ _file: name, _raw: t, rec: safeParse(t) });
    }
  }
  return out;
}

/** Concatenate the raw bytes of the whole store (for a literal grep). */
function readStoreRaw(telDir) {
  let names;
  try {
    names = fs.readdirSync(telDir);
  } catch {
    return '';
  }
  let blob = '';
  for (const name of names) {
    try {
      blob += fs.readFileSync(path.join(telDir, name), 'utf8') + '\n';
    } catch {
      /* ignore */
    }
  }
  return blob;
}

/** @param {string} s @returns {any|null} */
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** @param {string} s hex sha256 of a UTF-8 string */
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** True if the dir exists. @param {string} p */
function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Dynamic-import helpers — turn "module not built" into an assertion failure
// (HONEST RED), never a thrown crash that aborts the runner. We ONLY ever import
// the library emitter and the manager reader (both contractually free of a
// top-level process.exit()); hook scripts are spawned, never imported.
// ---------------------------------------------------------------------------

/**
 * Import an as-yet-unbuilt module by absolute path; resolve to its namespace or
 * `null` if it does not exist / fails to load. A cache-buster query keeps repeat
 * imports across cases independent (re-reads the emitter's gate fresh per env).
 * @param {string} absPath
 * @returns {Promise<any|null>}
 */
async function tryImport(absPath) {
  try {
    return await import(absPath + `?t=${process.hrtime.bigint()}`);
  } catch {
    return null;
  }
}

/**
 * Resolve a callable export from a module namespace, tolerant of the eventual
 * export name. Returns the function or null.
 * @param {any|null} mod @param {string[]} names @returns {Function|null}
 */
function resolveExport(mod, names) {
  if (!mod || typeof mod !== 'object') return null;
  for (const n of names) {
    if (typeof mod[n] === 'function') return mod[n];
    if (mod.default && typeof mod.default[n] === 'function') return mod.default[n];
  }
  if (typeof mod.default === 'function') return mod.default;
  return null;
}

/** Resolve PAYLOAD_ALLOW (a frozen object) from the emitter namespace, or null. */
function resolvePayloadAllow(mod) {
  if (!mod || typeof mod !== 'object') return null;
  const cand = mod.PAYLOAD_ALLOW ?? (mod.default && mod.default.PAYLOAD_ALLOW);
  return cand && typeof cand === 'object' ? cand : null;
}

/**
 * Resolve emit() from the emitter namespace. Tolerant of the eventual export name
 * (`emit` is the SPEC name). @param {any|null} mod @returns {Function|null}
 */
function resolveEmit(mod) {
  return resolveExport(mod, ['emit', 'emitEvent']);
}

/**
 * Import the emitter and return { emit, PAYLOAD_ALLOW, mod } or null when unbuilt.
 * The import runs with $HOME already pointed at the sandbox, so emit()'s gate +
 * store path resolve under the temp HOME. @returns {Promise<{emit:Function,PAYLOAD_ALLOW:any,mod:any}|null>}
 */
async function loadEmitter() {
  const mod = await tryImport(TELEMETRY_EMIT_MODULE);
  const emit = resolveEmit(mod);
  if (!emit) return null;
  return { emit, PAYLOAD_ALLOW: resolvePayloadAllow(mod), mod };
}

/**
 * Run emit(event) with $HOME swapped to a sandbox for the duration of the call,
 * then restore. The emitter reads process.env.HOME at call time (store.machineStateHome
 * pattern), so this in-process swap targets the sandbox store deterministically.
 * @param {Function} emit @param {string} home @param {any} event
 * @param {Record<string,string|undefined>} [env] extra env (e.g. FORGE_TELEMETRY)
 */
function emitUnderHome(emit, home, event, env = {}) {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    FORGE_TELEMETRY: process.env.FORGE_TELEMETRY,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    emit(event);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Source-scan helper (no-network meta-test). Strips line + block comments and
// string-literal noise is intentionally KEPT (a network specifier lives in a
// string), so we strip ONLY comments before grepping for forbidden identifiers.
// ---------------------------------------------------------------------------

/** Strip line and block comments from JS source (best-effort). @param {string} src */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating `://` in urls)
}

/** Read a source file or return '' (so a missing file is HONEST RED downstream). */
function readSrc(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Hook drivers — spawn the real hook with a stubbed stdin payload + sandbox HOME.
// Returns { status, stdout, stderr, decision } where decision is the parsed
// permissionDecision (or null). NEVER imports the hook (it process.exit()s).
// ---------------------------------------------------------------------------

/**
 * @param {string} hookAbs @param {any} payload @param {string} home
 * @param {Record<string,string>} [extraEnv]
 * @param {string} [cwd]
 * @returns {{status:number|null, stdout:string, stderr:string, decision:string|null}}
 */
function runHook(hookAbs, payload, home, extraEnv = {}, cwd) {
  const res = spawnSync('node', [hookAbs], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: cwd || home,
    env: envWith(home, extraEnv),
  });
  const stdout = res.stdout || '';
  let decision = null;
  const parsed = safeParse(stdout.trim());
  if (parsed && parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.permissionDecision === 'string') {
    decision = parsed.hookSpecificOutput.permissionDecision;
  }
  return { status: res.status, stdout, stderr: res.stderr || '', decision };
}

/**
 * Run `node bin/forge.mjs <args…>` with a sandbox HOME. Returns status/stdout/stderr
 * and (when `--json` is present) the parsed C3 envelope or null.
 * @param {string[]} args @param {string} home @param {string} [cwd]
 * @returns {{status:number|null, stdout:string, stderr:string, env:any|null}}
 */
function runForge(args, home, cwd) {
  const res = spawnSync('node', [FORGE_BIN, ...args], {
    encoding: 'utf8',
    cwd: cwd || home,
    env: envWith(home),
  });
  let env = null;
  if (args.includes('--json')) env = safeParse((res.stdout || '').trim());
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', env };
}

/**
 * Enable telemetry in the sandbox via the real CLI (`forge telemetry on`). RED today
 * (the verb is a planned-notice), so callers that DEPEND on a real config fall through
 * to a direct write of config.json as a belt-and-suspenders so the EMITTER cases can
 * still exercise the on-path against the same on-disk contract once emit() lands. The
 * presence of config.json {enabled:true} is the SPEC-05 on-signal.
 * @param {string} home @param {string} telDir @param {number} [retentionDays]
 */
function enableTelemetry(home, telDir, retentionDays = 30) {
  // Try the real consent command first (this is the GREEN path once built).
  runForge(['telemetry', 'on'], home);
  // If the CLI did not materialize config.json yet (RED), write the documented
  // on-config directly so the emitter cases are still meaningfully driven. This is
  // a fixture, not the code under test: emit()'s gate reads this exact file.
  const cfg = path.join(telDir, 'config.json');
  try {
    if (!fs.existsSync(cfg)) {
      fs.mkdirSync(telDir, { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ enabled: true, retentionDays }, null, 2) + '\n', 'utf8');
    }
  } catch {
    /* ignore */
  }
}

// A representative, fully-formed event used across schema/redaction cases.
/** @param {Partial<any>} over */
function sampleEvent(over = {}) {
  return {
    event_type: 'secret.catch',
    tool: 'Write',
    rule: 'secret-scan',
    decision: 'deny',
    session_id: 'abc123_session',
    project: '/Users/someone/secret/path',
    payload: { label: 'Anthropic API key', value_sha256: sha256hex('x'), value_len: 51 },
    ...over,
  };
}

// ===========================================================================
// EVAL-TEL-001 — Opt-in: default OFF records nothing. [GATE] (BR-TEL-001)
// Grader: code, pass^k=1.00.
// ===========================================================================
test('EVAL-TEL-001 [GATE] — default off: emit() writes nothing and creates no telemetry dir', async () => {
  const { home, telDir } = mkHome('001');
  try {
    const loaded = await loadEmitter();
    assert.ok(loaded, 'hooks/lib/telemetry.mjs must exist and export emit()');
    const { emit } = loaded;

    // Fresh HOME: no config.json, FORGE_TELEMETRY unset → emit() MUST be a pure no-op.
    emitUnderHome(emit, home, sampleEvent(), { FORGE_TELEMETRY: undefined });

    assert.ok(!dirExists(telDir), 'telemetry/ directory must NOT exist after a default-off emit');
    assert.strictEqual(readAllEvents(telDir).length, 0, 'zero JSONL lines written when off');
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// EVAL-TEL-002 — Env override beats config. (BR-TEL-002)
// ===========================================================================
test('EVAL-TEL-002 — FORGE_TELEMETRY env beats config.json (0 over enabled; 1 over absent)', async () => {
  // Case (a): config {enabled:true} but FORGE_TELEMETRY=0 → zero lines.
  const a = mkHome('002a');
  // Case (b): no config but FORGE_TELEMETRY=1 → exactly one line.
  const b = mkHome('002b');
  try {
    const loaded = await loadEmitter();
    assert.ok(loaded, 'hooks/lib/telemetry.mjs must exist and export emit()');
    const { emit } = loaded;

    // (a) on-config, env forces OFF.
    fs.mkdirSync(a.telDir, { recursive: true });
    fs.writeFileSync(path.join(a.telDir, 'config.json'), JSON.stringify({ enabled: true, retentionDays: 30 }) + '\n');
    emitUnderHome(emit, a.home, sampleEvent(), { FORGE_TELEMETRY: '0' });
    assert.strictEqual(readAllEvents(a.telDir).length, 0, 'FORGE_TELEMETRY=0 over {enabled:true} → zero lines');

    // (b) no config, env forces ON.
    emitUnderHome(emit, b.home, sampleEvent(), { FORGE_TELEMETRY: '1' });
    assert.strictEqual(readAllEvents(b.telDir).length, 1, 'FORGE_TELEMETRY=1 with no config → exactly one line');
  } finally {
    cleanup(a.home);
    cleanup(b.home);
  }
});

// ===========================================================================
// EVAL-TEL-003 — Fail-open: a broken emit never blocks. (BR-TEL-003)
// Driven across the PROCESS BOUNDARY at secret-scan's deny path.
//
// HONEST RED: this case must NOT pass before the emit is WIRED into the hook —
// today secret-scan denies+exit-0 with no telemetry call at all, so a naive
// "deny survives a broken store" check would pass vacuously (a mis-spec the
// evals/README forbids). So we FIRST prove the wiring exists (a deny with a
// WRITABLE store produces exactly one secret.catch event), which is RED today,
// THEN prove fail-open (a deny with a BROKEN store leaves the decision/exit
// untouched). It goes GREEN only when secret-scan calls a fail-open emit().
// ===========================================================================
test('EVAL-TEL-003 — a broken emit never changes the hook decision or exit code (emit must be wired + fail-open)', async () => {
  const payload = {
    tool_name: 'Write',
    tool_input: { file_path: 'config.js', content: 'const k = "AKIA1234567890ABCD99";' },
  };

  // -- Part 1: WIRING. With telemetry ON and a WRITABLE store, the deny path MUST
  //    record a secret.catch event. This is RED until secret-scan calls emit().
  const wired = mkHome('003wired');
  try {
    enableTelemetry(wired.home, wired.telDir);
    const rw = runHook(SECRET_SCAN_HOOK, payload, wired.home, { FORGE_TELEMETRY: '1' });
    assert.strictEqual(rw.status, 0, 'secret-scan exits 0 on deny');
    assert.strictEqual(rw.decision, 'deny', 'secret-scan denies the planted secret');
    const evs = readAllEvents(wired.telDir).map((e) => e.rec).filter(Boolean);
    const sec = evs.filter((e) => e.event_type === 'secret.catch');
    assert.strictEqual(sec.length, 1, 'the deny path emits exactly one secret.catch event (proves emit() is wired)');
  } finally {
    cleanup(wired.home);
  }

  // -- Part 2: FAIL-OPEN. Same deny, but the store is forced unwritable (a FILE
  //    sits where the telemetry dir should be → any mkdir/append inside emit()
  //    throws). emit() must swallow it; the decision + exit code stay correct.
  const broken = mkHome('003broken');
  try {
    enableTelemetry(broken.home, broken.telDir);
    try {
      fs.rmSync(broken.telDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    fs.mkdirSync(path.dirname(broken.telDir), { recursive: true });
    fs.writeFileSync(broken.telDir, 'not-a-directory', 'utf8'); // a FILE where the dir should be → append throws

    const rb = runHook(SECRET_SCAN_HOOK, payload, broken.home, { FORGE_TELEMETRY: '1' });
    assert.strictEqual(rb.status, 0, 'secret-scan exits 0 even though emit() failed (fail-open)');
    assert.strictEqual(rb.decision, 'deny', 'the deny decision is written despite the broken emit');
    // The thrown emit must not pollute stderr into a crash signature.
    assert.ok(!/throw|TypeError|ENOENT.*unhandled|UnhandledPromiseRejection/i.test(rb.stderr),
      'no unhandled telemetry crash leaks into stderr');
  } finally {
    cleanup(broken.home);
  }
});

// ===========================================================================
// EVAL-TEL-004 — No network surface (local-only, by construction). [GATE] (BR-TEL-004)
// (a) Static scan of the three telemetry sources for forbidden identifiers.
// (b) Behavioral probe: emit() performs exactly ONE appendFileSync and opens no socket.
// ===========================================================================
test('EVAL-TEL-004 [GATE] — telemetry sources contain no network identifiers; emit() does one appendFileSync', async () => {
  // (a) STATIC SCAN. All three sources must exist (a missing source is RED) and
  // must contain ZERO forbidden network identifiers after comment-stripping.
  const sources = [
    ['hooks/lib/telemetry.mjs', TELEMETRY_EMIT_MODULE],
    ['hooks/invoke-telemetry.mjs', INVOKE_TELEMETRY_HOOK],
    ['manager/telemetry.mjs', TELEMETRY_READER_MODULE],
  ];
  for (const [label, abs] of sources) {
    const raw = readSrc(abs);
    assert.ok(raw.length > 0, `${label} must exist (no-network scan target)`);
    const code = stripComments(raw);
    for (const [id, re] of FORBIDDEN_NET) {
      assert.ok(!re.test(code), `${label} must contain no network identifier: ${id}`);
    }
  }

  // (b) BEHAVIORAL PROBE. With telemetry ON, a single emit() must perform EXACTLY
  // one appendFileSync and never construct a socket. We spy on fs.appendFileSync
  // and trap any socket open by stubbing the (already-import-free) net surface.
  const { home, telDir } = mkHome('004');
  try {
    enableTelemetry(home, telDir);
    const loaded = await loadEmitter();
    assert.ok(loaded, 'hooks/lib/telemetry.mjs must exist and export emit()');
    const { emit } = loaded;

    let appends = 0;
    let socketOpened = false;
    const realAppend = fs.appendFileSync;
    // A socket-trap: if the emitter ever reaches for a connection primitive on the
    // global, flip the flag. (The emitter is zero-network by construction, so these
    // remain untouched; the trap proves it behaviorally, not just by source.)
    const realFetch = /** @type {any} */ (globalThis).fetch;
    try {
      // @ts-ignore — test spy
      fs.appendFileSync = (...args) => {
        appends++;
        return realAppend.apply(fs, args);
      };
      // @ts-ignore — socket trap
      globalThis.fetch = () => {
        socketOpened = true;
        throw new Error('telemetry must not fetch');
      };

      emitUnderHome(emit, home, sampleEvent(), { FORGE_TELEMETRY: '1' });
    } finally {
      fs.appendFileSync = realAppend;
      // @ts-ignore — restore
      globalThis.fetch = realFetch;
    }

    assert.strictEqual(appends, 1, 'emit() performs EXACTLY one appendFileSync');
    assert.strictEqual(socketOpened, false, 'emit() opens no network connection');
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// EVAL-TEL-005 — Redaction-on-write via the closed PAYLOAD_ALLOW allow-list.
// (BR-TEL-005)
// ===========================================================================
test('EVAL-TEL-005 — payload is reduced to the event_type allow-list; unknown type → {}', async () => {
  const { home, telDir } = mkHome('005');
  try {
    enableTelemetry(home, telDir);
    const loaded = await loadEmitter();
    assert.ok(loaded, 'hooks/lib/telemetry.mjs must exist and export emit() + PAYLOAD_ALLOW');
    const { emit, PAYLOAD_ALLOW } = loaded;
    assert.ok(PAYLOAD_ALLOW && typeof PAYLOAD_ALLOW === 'object', 'PAYLOAD_ALLOW must be exported');

    // A secret.catch event carrying BOTH whitelisted fields AND planted extras.
    const allow = Array.isArray(PAYLOAD_ALLOW['secret.catch']) ? PAYLOAD_ALLOW['secret.catch'] : [];
    emitUnderHome(emit, home, {
      event_type: 'secret.catch',
      tool: 'Write',
      decision: 'deny',
      session_id: 's1',
      project: '/raw/project/path',
      payload: {
        label: 'Anthropic API key',
        value_sha256: sha256hex('S'),
        value_len: 51,
        raw_path: '/raw/project/path/config.js', // NON-whitelisted → must be dropped
        command: 'echo $SECRET', // NON-whitelisted → must be dropped
      },
    }, { FORGE_TELEMETRY: '1' });

    // An event_type ABSENT from PAYLOAD_ALLOW → payload:{}.
    emitUnderHome(emit, home, {
      event_type: 'totally.unknown.type',
      session_id: 's1',
      payload: { anything: 'at all', value: 'leak-me' },
    }, { FORGE_TELEMETRY: '1' });

    const events = readAllEvents(telDir).map((e) => e.rec).filter(Boolean);
    const sec = events.find((e) => e.event_type === 'secret.catch');
    const unk = events.find((e) => e.event_type === 'totally.unknown.type');
    assert.ok(sec, 'secret.catch line was written');
    assert.ok(unk, 'unknown-type line was written');

    // The serialized payload contains EXACTLY the allow-listed keys, no extras.
    const secKeys = Object.keys(sec.payload || {}).sort();
    assert.deepStrictEqual(secKeys, [...allow].sort(),
      'secret.catch payload contains exactly its allow-listed keys');
    assert.ok(!('raw_path' in (sec.payload || {})), 'raw_path was dropped');
    assert.ok(!('command' in (sec.payload || {})), 'command was dropped');

    // Unknown event type → empty payload.
    assert.deepStrictEqual(unk.payload, {}, 'unknown event_type serializes with payload:{}');
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// EVAL-TEL-006 — A secret value never appears in JSONL (only hash + length).
// [GATE] (BR-TEL-006, BR-TEL-005)
// ===========================================================================
test('EVAL-TEL-006 [GATE] — a known secret flows in as sha256+len; the literal never appears in the store', async () => {
  const { home, telDir } = mkHome('006');
  const SECRET = 'sk-ant-FAKE0fixture0secret0value0DO0NOT0LEAK0123456';
  const RAW_PATH = '/Users/victim/project/.env.production';
  const RAW_COMMAND = `export ANTHROPIC_API_KEY=${SECRET}`;
  try {
    enableTelemetry(home, telDir);
    const loaded = await loadEmitter();
    assert.ok(loaded, 'hooks/lib/telemetry.mjs must exist and export emit() + PAYLOAD_ALLOW');
    const { emit, PAYLOAD_ALLOW } = loaded;
    assert.ok(PAYLOAD_ALLOW && typeof PAYLOAD_ALLOW === 'object', 'PAYLOAD_ALLOW must be exported');

    // Drive the secret + raw path + raw command through a secret.catch emit. Only
    // value_sha256 + value_len are whitelisted; everything else must be dropped.
    emitUnderHome(emit, home, {
      event_type: 'secret.catch',
      tool: 'Write',
      decision: 'deny',
      session_id: 's-006',
      project: RAW_PATH,
      payload: {
        label: 'Anthropic API key',
        value_sha256: sha256hex(SECRET),
        value_len: SECRET.length,
        value: SECRET, // planted raw secret → MUST be dropped
        raw_path: RAW_PATH, // planted raw path → MUST be dropped
        command: RAW_COMMAND, // planted raw command → MUST be dropped
      },
    }, { FORGE_TELEMETRY: '1' });

    const events = readAllEvents(telDir).map((e) => e.rec).filter(Boolean);
    const sec = events.find((e) => e.event_type === 'secret.catch');
    assert.ok(sec, 'secret.catch line written');
    assert.strictEqual(sec.payload.value_sha256, sha256hex(SECRET), 'value_sha256 == sha256(S)');
    assert.strictEqual(sec.payload.value_len, SECRET.length, 'value_len == S.length');

    // The WHOLE store must not contain the literal secret / raw path / raw command,
    // and the project field must be a hash, never the raw path.
    const blob = readStoreRaw(telDir);
    assert.ok(blob.length > 0, 'store has content');
    assert.ok(!blob.includes(SECRET), 'the literal secret value never appears anywhere in the store');
    assert.ok(!blob.includes(RAW_PATH), 'a raw filesystem path never appears in the store');
    assert.ok(!blob.includes(RAW_COMMAND), 'a raw command string never appears in the store');
    assert.match(String(sec.project), /^h:[0-9a-f]{8}$/, 'project is a hashed "h:<sha8>", never the raw path');

    // META-ASSERTION: PAYLOAD_ALLOW whitelists NO forbidden field name for ANY type.
    for (const [etype, fields] of Object.entries(PAYLOAD_ALLOW)) {
      const list = Array.isArray(fields) ? fields : [];
      for (const bad of FORBIDDEN_PAYLOAD_FIELDS) {
        assert.ok(!list.includes(bad), `PAYLOAD_ALLOW[${etype}] must NOT whitelist forbidden field "${bad}"`);
      }
    }
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// EVAL-TEL-007 — Event schema is fixed and uniform. (BR-TEL-007)
// ===========================================================================
test('EVAL-TEL-007 — every line is valid JSON with exactly the fixed keys; enums/forms hold', async () => {
  const { home, telDir } = mkHome('007');
  try {
    enableTelemetry(home, telDir);
    const loaded = await loadEmitter();
    assert.ok(loaded, 'hooks/lib/telemetry.mjs must exist and export emit()');
    const { emit } = loaded;

    emitUnderHome(emit, home, sampleEvent({ session_id: 'good_session-01', artifact_id: null }), { FORGE_TELEMETRY: '1' });

    const lines = readAllEvents(telDir);
    assert.strictEqual(lines.length, 1, 'exactly one line written');
    const { rec } = lines[0];
    assert.ok(rec && typeof rec === 'object', 'the line is valid JSON');

    // EXACTLY the fixed keys — none missing, none extra.
    assert.deepStrictEqual(Object.keys(rec).sort(), [...SCHEMA_KEYS].sort(),
      'line carries exactly the fixed schema keys (absent values are null, never omitted)');

    // Field forms.
    assert.match(String(rec.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ts is ISO-8601 with ms precision');
    assert.ok(rec.decision === null || DECISION_ENUM.has(rec.decision), 'decision is in {allow,deny,pass,fail,skip,null}');
    assert.match(String(rec.project), /^h:[0-9a-f]{8}$/, 'project is the hashed "h:<sha8>" form');
    assert.match(String(rec.session_id), /^[A-Za-z0-9_-]+$/, 'session_id is sanitized to [A-Za-z0-9_-]');
    assert.ok(rec.artifact_id === null || typeof rec.artifact_id === 'string', 'artifact_id is a uid string or null');
    assert.strictEqual(rec.v, 1, 'schema version v is 1');
    assert.ok(Number.isInteger(rec.pid), 'pid is an integer');
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// EVAL-TEL-008 — Taxonomy coverage at the real decision sites. (BR-TEL-008)
// Each hook site is driven across a process boundary; the CLI sites via forge.
// ===========================================================================
test('EVAL-TEL-008 — each decision site emits exactly one event of the expected type + redacted shape', async () => {
  const { home, telDir } = mkHome('008');
  try {
    enableTelemetry(home, telDir);

    // --- secret-scan deny → secret.catch {label, value_sha256, value_len} ---
    runHook(SECRET_SCAN_HOOK, {
      tool_name: 'Write',
      tool_input: { file_path: 'c.js', content: 'aws_secret_access_key = "abcdefghij0123456789ABCDEFGHIJ0123456789xx"' },
    }, home);

    // --- config-protection deny → config.protect {config_kind} ---
    // (Modify an EXISTING tsconfig.json — first-create is allowed, so seed it first.)
    const cwd = path.join(home, 'proj');
    writeFileAbs(path.join(cwd, 'tsconfig.json'), '{ "compilerOptions": {} }\n');
    runHook(CONFIG_PROTECTION_HOOK, {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'tsconfig.json'), old_string: '{}', new_string: '{ "strict": false }' },
    }, home, {}, cwd);

    // --- block-no-verify deny → noverify.block {flag} ---
    runHook(BLOCK_NO_VERIFY_HOOK, {
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m wip --no-verify' },
    }, home, {}, cwd);

    // --- edit-citation-gate first-touch → citation.gate {target_sha256, first_touch} ---
    // (Project-gated: requires a .claude/.forge.json marker in cwd.)
    writeFileAbs(path.join(cwd, '.claude', '.forge.json'), JSON.stringify({ forgeVersion: '0.1.0', profile: 'generic', modules: ['x'], facts: 'f.json', files: [] }) + '\n');
    runHook(CITATION_GATE_HOOK, {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src', 'a.ts'), old_string: 'a', new_string: 'b' },
    }, home, {}, cwd);

    // --- invoke-telemetry Task → agent.invoke {prompt_len, prompt_sha256} ---
    runHook(INVOKE_TELEMETRY_HOOK, {
      tool_name: 'Task',
      tool_input: { prompt: 'do a code review please', subagent_type: 'code-reviewer' },
    }, home, {}, cwd);
    // --- invoke-telemetry Skill → skill.invoke {prompt_len, prompt_sha256} ---
    runHook(INVOKE_TELEMETRY_HOOK, {
      tool_name: 'Skill',
      tool_input: { prompt: 'run the deep research skill' },
    }, home, {}, cwd);

    // Collect and assert one-event-per-type with the redacted payload shape.
    const events = readAllEvents(telDir).map((e) => e.rec).filter(Boolean);
    /** @param {string} t */
    const byType = (t) => events.filter((e) => e.event_type === t);

    const expectShapes = {
      'secret.catch': ['label', 'value_sha256', 'value_len'],
      'config.protect': ['config_kind'],
      'noverify.block': ['flag'],
      'citation.gate': ['target_sha256', 'first_touch'],
      'agent.invoke': ['prompt_len', 'prompt_sha256'],
      'skill.invoke': ['prompt_len', 'prompt_sha256'],
    };
    for (const [etype, shape] of Object.entries(expectShapes)) {
      const got = byType(etype);
      assert.strictEqual(got.length, 1, `exactly one ${etype} event`);
      const keys = Object.keys(got[0].payload || {}).sort();
      assert.deepStrictEqual(keys, [...shape].sort(), `${etype} payload shape is exactly ${shape.join(',')}`);
    }

    // The two invoke events MUST carry duration_ms:null (start-only) and never a prompt.
    for (const t of ['agent.invoke', 'skill.invoke']) {
      const ev = byType(t)[0];
      assert.strictEqual(ev.duration_ms, null, `${t}.duration_ms is null (start-only)`);
      assert.ok(!('prompt' in (ev.payload || {})), `${t} never stores the prompt text`);
    }
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// EVAL-TEL-009 — Durations are honest; unknown is null (never 0); no token/cost.
// (BR-TEL-009)
// ===========================================================================
test('EVAL-TEL-009 — agent.invoke duration is null; typecheck.run duration is a real number; no token/cost fields', async () => {
  const { home, telDir } = mkHome('009');
  try {
    enableTelemetry(home, telDir);
    const loaded = await loadEmitter();
    assert.ok(loaded, 'hooks/lib/telemetry.mjs must exist and export emit()');
    const { emit } = loaded;

    // A start-only agent.invoke → duration_ms MUST be null (never 0).
    emitUnderHome(emit, home, {
      event_type: 'agent.invoke',
      tool: 'Task',
      session_id: 's-009',
      duration_ms: null,
      payload: { prompt_len: 10, prompt_sha256: sha256hex('hello') },
    }, { FORGE_TELEMETRY: '1' });

    // A typecheck.run timing a real short command → duration_ms a number >= 0.
    const t0 = Date.now();
    spawnSync('node', ['-e', 'process.exit(0)'], { encoding: 'utf8' });
    const measured = Date.now() - t0;
    emitUnderHome(emit, home, {
      event_type: 'typecheck.run',
      tool: null,
      decision: 'pass',
      session_id: 's-009',
      duration_ms: measured,
      payload: { duration_ms: measured, exit_code: 0, fail_count: 0 },
    }, { FORGE_TELEMETRY: '1' });

    const events = readAllEvents(telDir).map((e) => e.rec).filter(Boolean);
    const agent = events.find((e) => e.event_type === 'agent.invoke');
    const tc = events.find((e) => e.event_type === 'typecheck.run');
    assert.ok(agent && tc, 'both events written');
    assert.strictEqual(agent.duration_ms, null, 'agent.invoke.duration_ms === null (never fabricated, never 0)');
    assert.ok(typeof tc.duration_ms === 'number' && tc.duration_ms >= 0, 'typecheck.run.duration_ms is a number >= 0');

    // NO event anywhere carries a token / cost / model-latency field.
    const blob = readStoreRaw(telDir);
    for (const forbidden of ['tokens', 'cost', 'model_latency', 'input_tokens', 'output_tokens']) {
      assert.ok(!new RegExp(`"${forbidden}"`).test(blob), `no event carries a "${forbidden}" field`);
    }
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// EVAL-TEL-010 — Daily rotation and a hard size cap. (BR-TEL-010)
// Emits past a test-lowered cap; expects a sealed *.full sibling + a fresh
// current file, both valid JSONL.
// ===========================================================================
test('EVAL-TEL-010 — emitting past the size cap seals a *.full and continues a fresh file; both valid JSONL', async () => {
  const { home, telDir } = mkHome('010');
  try {
    enableTelemetry(home, telDir);
    const loaded = await loadEmitter();
    assert.ok(loaded, 'hooks/lib/telemetry.mjs must exist and export emit()');
    const { emit } = loaded;

    // Lower the size cap aggressively so a handful of events trip it. The cap is a
    // config-surfaced default; the emitter MUST honor a test-lowered cap. We pass it
    // via config.json so we drive the real rotation path, not a test-only hook.
    fs.writeFileSync(path.join(telDir, 'config.json'),
      JSON.stringify({ enabled: true, retentionDays: 30, maxBytesPerDay: 2048 }) + '\n');

    // Burst enough events to exceed 2 KiB across at least one seal.
    const bigPayload = { label: 'x'.repeat(200), value_sha256: sha256hex('y'), value_len: 7 };
    for (let i = 0; i < 60; i++) {
      emitUnderHome(emit, home, {
        event_type: 'secret.catch',
        tool: 'Write',
        decision: 'deny',
        session_id: `s-${i}`,
        payload: bigPayload,
      }, { FORGE_TELEMETRY: '1' });
    }

    const names = fs.readdirSync(telDir);
    const fulls = names.filter((n) => n.endsWith('.full'));
    const currents = names.filter((n) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    assert.ok(fulls.length >= 1, 'at least one sealed *.full file exists after exceeding the cap');
    assert.strictEqual(currents.length, 1, 'exactly one fresh current-day .jsonl continues after the seal');

    // BOTH the sealed and current files must be valid JSONL (every line parses).
    for (const n of [...fulls, ...currents]) {
      const text = fs.readFileSync(path.join(telDir, n), 'utf8');
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        assert.doesNotThrow(() => JSON.parse(t), `${n}: every line is valid JSON`);
      }
    }
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// EVAL-TEL-011 — Lazy retention pruning (no daemon). (BR-TEL-011)
// Back-date files via mtime; prune deletes only telemetry files past retention.
// ===========================================================================
test('EVAL-TEL-011 — prune deletes telemetry files older than retentionDays; spares newer + non-telemetry files', async () => {
  const { home, telDir } = mkHome('011');
  try {
    fs.mkdirSync(telDir, { recursive: true });
    fs.writeFileSync(path.join(telDir, 'config.json'), JSON.stringify({ enabled: true, retentionDays: 7 }) + '\n');

    const now = Date.now();
    const DAY = 86400 * 1000;
    // Old current + old sealed (both > 7 days) → MUST be pruned.
    const oldA = path.join(telDir, 'events-2000-01-01.jsonl');
    const oldB = path.join(telDir, 'events-2000-01-02.00.full');
    // New telemetry file (today) → MUST survive.
    const fresh = path.join(telDir, 'events-2099-01-01.jsonl');
    for (const p of [oldA, oldB, fresh]) fs.writeFileSync(p, JSON.stringify({ v: 1 }) + '\n');
    // Back-date the old ones by mtime; keep fresh "now".
    fs.utimesSync(oldA, new Date(now - 30 * DAY), new Date(now - 30 * DAY));
    fs.utimesSync(oldB, new Date(now - 30 * DAY), new Date(now - 30 * DAY));
    fs.utimesSync(fresh, new Date(now), new Date(now));

    // A control file in a SIBLING dir (outside telemetry/) → MUST be untouched.
    const control = path.join(home, '.claude', 'forge', 'fleet.json');
    writeFileAbs(control, '{"unrelated":true}\n');
    fs.utimesSync(control, new Date(now - 365 * DAY), new Date(now - 365 * DAY)); // old, but NOT telemetry

    const r = runForge(['telemetry', 'prune'], home);
    assert.strictEqual(r.status, 0, 'forge telemetry prune exits 0');

    assert.ok(!fs.existsSync(oldA), 'old current telemetry file (past retention) deleted');
    assert.ok(!fs.existsSync(oldB), 'old sealed *.full file (past retention) deleted');
    assert.ok(fs.existsSync(fresh), 'newer telemetry file survives prune');
    assert.ok(fs.existsSync(control), 'a non-telemetry sibling file is untouched');
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// EVAL-TEL-012 — Storage is machine-local & physically un-committable. (BR-TEL-012)
// ===========================================================================
test('EVAL-TEL-012 — telemetry on writes a .gitignore "*"; every path resolves under ~/.claude/forge/telemetry', async () => {
  const { home, telDir } = mkHome('012');
  try {
    const r = runForge(['telemetry', 'on'], home);
    assert.strictEqual(r.status, 0, 'forge telemetry on exits 0');

    const gitignore = path.join(telDir, '.gitignore');
    assert.ok(fs.existsSync(gitignore), '~/.claude/forge/telemetry/.gitignore exists after telemetry on');
    assert.match(fs.readFileSync(gitignore, 'utf8'), /(^|\n)\*\s*($|\n)/, '.gitignore contains "*"');

    // After an emit, every telemetry path resolves UNDER the machine-local telemetry
    // dir and NONE under the git-tracked forge/.forge/.
    const loaded = await loadEmitter();
    assert.ok(loaded, 'hooks/lib/telemetry.mjs must exist and export emit()');
    emitUnderHome(loaded.emit, home, sampleEvent(), { FORGE_TELEMETRY: '1' });

    const telReal = fs.realpathSync(telDir);
    for (const name of fs.readdirSync(telDir)) {
      const resolved = fs.realpathSync(path.join(telDir, name));
      assert.ok(resolved.startsWith(telReal), `telemetry path ${name} resolves under the machine-local telemetry dir`);
      assert.ok(!resolved.includes(path.join(FORGE_ROOT, '.forge') + path.sep) && resolved !== path.join(FORGE_ROOT, '.forge'),
        `telemetry path ${name} never resolves under the git-tracked forge/.forge/`);
    }
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// EVAL-TEL-013 — Readers degrade gracefully when off or empty. (BR-TEL-013)
// ===========================================================================
test('EVAL-TEL-013 — stat/monitor/telemetry status print an off/empty message and exit 0 (off and empty cases)', async () => {
  // (a) telemetry OFF (no config at all).
  const off = mkHome('013off');
  // (b) telemetry ON but EMPTY store.
  const empty = mkHome('013empty');
  try {
    enableTelemetry(empty.home, empty.telDir); // config on, but no events emitted
    // make sure no event files exist
    for (const n of fs.existsSync(empty.telDir) ? fs.readdirSync(empty.telDir) : []) {
      if (/\.(jsonl|full)$/.test(n)) fs.rmSync(path.join(empty.telDir, n), { force: true });
    }

    const offEmptyRe = /telemetry is off|no data|empty|run forge telemetry on/i;

    for (const [label, h] of [['off', off.home], ['empty', empty.home]]) {
      for (const cmd of [['stat'], ['monitor'], ['telemetry', 'status']]) {
        const r = runForge(cmd, h);
        assert.strictEqual(r.status, 0, `forge ${cmd.join(' ')} (${label}) exits 0 — never a stack trace`);
        const text = r.stdout + r.stderr;
        assert.match(text, offEmptyRe, `forge ${cmd.join(' ')} (${label}) prints an actionable off/empty message`);
        assert.ok(!/at\s+\w+.*\(.*:\d+:\d+\)|Error:\s|UnhandledPromiseRejection/.test(text),
          `forge ${cmd.join(' ')} (${label}) emits no stack trace`);

        // The --json envelope is well-formed with ok:true and empty data.
        const rj = runForge([...cmd, '--json'], h);
        assert.ok(rj.env && typeof rj.env === 'object', `forge ${cmd.join(' ')} --json (${label}) emits a parseable envelope`);
        assert.strictEqual(rj.env.ok, true, `--json ok:true for ${cmd.join(' ')} (${label})`);
        const data = rj.env.data;
        const emptyData =
          data == null ||
          (Array.isArray(data) && data.length === 0) ||
          (typeof data === 'object' && Object.keys(data).length === 0) ||
          (typeof data === 'object' && Array.isArray(data.events) && data.events.length === 0);
        assert.ok(emptyData, `--json data is empty for ${cmd.join(' ')} (${label})`);
      }
    }
  } finally {
    cleanup(off.home);
    cleanup(empty.home);
  }
});

// ===========================================================================
// EVAL-TEL-014 — Consumers tolerate the empty store (efficiency → static-only).
// (BR-TEL-014) — paired with EVAL-EFF. Telemetry-off must not break the dynamic
// detection path; it falls back to static-only and SAYS so.
// ===========================================================================
test('EVAL-TEL-014 — efficiency analyze degrades to static-only when telemetry is off/empty (never errors)', async () => {
  const { home } = mkHome('014');
  try {
    // A minimal target so analyze has SOMETHING to statically classify.
    const proj = path.join(home, 'proj');
    writeFileAbs(path.join(proj, 'manifests', 'modules.json'), JSON.stringify({ version: 1, modules: {} }) + '\n');
    writeFileAbs(path.join(proj, 'rules', 'plain.md'),
      ['---', 'name: plain', 'description: Always-on plain rule.', '---', '# Plain', '', 'No paths scope.', ''].join('\n'));

    // Telemetry OFF (fresh HOME, no config). analyze MUST NOT assume events exist.
    const r = runForge(['analyze', proj], home);
    assert.strictEqual(r.status, 0, 'forge analyze exits 0 with telemetry off');
    const text = r.stdout + r.stderr;
    assert.ok(!/Error:\s|UnhandledPromiseRejection|Cannot read|ENOENT.*telemetry/.test(text),
      'analyze does not error on an absent telemetry store');
    assert.match(text, /dynamic:\s*no telemetry\s*[—-]\s*static only|static[- ]only/i,
      'analyze reports it ran static-only (no telemetry)');
  } finally {
    cleanup(home);
  }
});
