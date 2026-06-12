#!/usr/bin/env node
// @ts-check
/**
 * Forge — telemetry READERS + consent CLI (SPEC-05, BR-TEL-011..013, ADR-0011).
 *
 * The manager-layer half of telemetry: the CLI commands that turn recording on/off,
 * report the store, prune/wipe it, and roll it up. The hot-path EMITTER lives in
 * `hooks/lib/telemetry.mjs` (zero-dep, imported by every hook). The readers live
 * here because they are CLI commands, not hook code.
 *
 * Surface (dispatched from bin/forge.mjs across a process boundary):
 *   forge telemetry on      → opt in: write config.json {enabled,retentionDays} + .gitignore "*"
 *   forge telemetry off     → stop recording (keeps the data)
 *   forge telemetry status  → enabled?/event count/day span/disk size (off-message if off)
 *   forge telemetry prune   → lazily delete files older than retentionDays (no daemon)
 *   forge telemetry wipe    → delete the JSONL/full files (keep config)
 *   forge stat   [--since 7d] [--json]  → rollup (hook fire counts, deny rates, typecheck %, …)
 *   forge monitor [--watch] [--json]    → at-a-glance snapshot (watch = self-scheduled setTimeout)
 *
 * HARD INVARIANTS honored here:
 *   - NO NETWORK (BR-TEL-004): no fetch/http/net/dns/tls/socket/child_process anywhere.
 *     This module reads/writes the machine-local store and nothing else. The
 *     no-network meta-test greps this file.
 *   - FAIL-OPEN: every public entry degrades to a safe empty result; never throws.
 *   - Readers DEGRADE GRACEFULLY when off/empty (BR-TEL-013): a clear off/empty
 *     message, an empty --json envelope, and exit 0 (never a stack trace).
 *   - LAZY PRUNE, NO DAEMON (BR-TEL-011, ADR-0010): retention is enforced only when
 *     stat/prune runs, and only on telemetry files under ~/.claude/forge/telemetry.
 *   - DUAL-MODE + isMain() guard: this module NEVER process.exit()s at import time,
 *     so the node:test runner is never killed (mirrors registry/status/fleet/efficiency).
 *
 * Conventions: Node ESM, ZERO runtime dependencies (node: builtins + relative libs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineStateHome, readJson, writeJsonAtomic } from './lib/store.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';

// ---------------------------------------------------------------------------
// Paths + small fail-open helpers
// ---------------------------------------------------------------------------

const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 86400 * 1000;

/** The machine-local telemetry dir `<home>/.claude/forge/telemetry`. */
function telemetryDir() {
  return path.join(machineStateHome(), 'telemetry');
}

/** Best-effort dir listing. Returns [] when the dir is absent/unreadable. */
function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** True if a path is a directory. */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True if a name is a telemetry event file (current jsonl or sealed full). */
function isEventFile(name) {
  return /^events-\d{4}-\d{2}-\d{2}(\.\d+)?\.(jsonl|full)$/.test(name);
}

/** Read every JSONL/full event line in the store as parsed records (skips malformed). */
function readAllEvents(dir) {
  /** @type {any[]} */
  const out = [];
  for (const name of listDir(dir)) {
    if (!isEventFile(name)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* skip malformed line — fail-open */
      }
    }
  }
  return out;
}

/** Resolve the on-disk config (or null). Fail-open. */
function readConfig(dir) {
  return readJson(path.join(dir, 'config.json'));
}

/** Whether telemetry is enabled (env beats config; default off) — mirrors the emitter. */
function isEnabled(dir) {
  const env = process.env.FORGE_TELEMETRY;
  if (env === '1') return true;
  if (env === '0') return false;
  const cfg = readConfig(dir);
  return Boolean(cfg && cfg.enabled === true);
}

/** Retention days from config (default 30). */
function retentionDays(dir) {
  const cfg = readConfig(dir);
  const v = cfg && cfg.retentionDays;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_RETENTION_DAYS;
}

/** Total on-disk byte size of the event files. */
function storeBytes(dir) {
  let total = 0;
  for (const name of listDir(dir)) {
    if (!isEventFile(name)) continue;
    try {
      total += fs.statSync(path.join(dir, name)).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Findings helper (C2/C4)
// ---------------------------------------------------------------------------

/** @returns {{ok:boolean, data:any, findings:any[], summary:object}} */
function result(ok, data, findings = []) {
  const list = Array.isArray(findings) ? findings : [];
  const summary = { errors: 0, warnings: 0, info: 0 };
  for (const f of list) {
    if (f && f.level === 'ERROR') summary.errors++;
    else if (f && f.level === 'WARN') summary.warnings++;
    else if (f && f.level === 'INFO') summary.info++;
  }
  return { ok: !!ok, data: data === undefined ? null : data, findings: list, summary };
}

// ---------------------------------------------------------------------------
// Consent commands: on / off / wipe
// ---------------------------------------------------------------------------

/** Opt in: write config.json {enabled:true,retentionDays} + .gitignore "*" (BR-TEL-012). */
function doOn(dir) {
  const prior = readConfig(dir) || {};
  const cfg = {
    enabled: true,
    retentionDays: typeof prior.retentionDays === 'number' ? prior.retentionDays : DEFAULT_RETENTION_DAYS,
  };
  // Carry forward a test-lowered cap if one was already set.
  if (typeof prior.maxBytesPerDay === 'number') cfg.maxBytesPerDay = prior.maxBytesPerDay;
  let wrote = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    wrote = writeJsonAtomic(path.join(dir, 'config.json'), cfg);
    // Defense in depth (BR-TEL-012): the store can never be committed.
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', 'utf8');
    } catch {
      /* ignore — gitignore is best-effort */
    }
  } catch {
    wrote = false;
  }
  return result(true, { enabled: true, retentionDays: cfg.retentionDays, wrote, dir });
}

/** Stop recording (keep the data): set {enabled:false}. */
function doOff(dir) {
  const prior = readConfig(dir) || {};
  const cfg = { ...prior, enabled: false };
  if (typeof cfg.retentionDays !== 'number') cfg.retentionDays = DEFAULT_RETENTION_DAYS;
  let wrote = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    wrote = writeJsonAtomic(path.join(dir, 'config.json'), cfg);
  } catch {
    wrote = false;
  }
  return result(true, { enabled: false, wrote, dir });
}

/** Delete the event files (keep config). Additive-safe: only event files. */
function doWipe(dir) {
  let removed = 0;
  for (const name of listDir(dir)) {
    if (!isEventFile(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed++;
    } catch {
      /* ignore */
    }
  }
  return result(true, { removed, dir });
}

/**
 * Lazily delete telemetry event files older than retentionDays (BR-TEL-011). Only
 * touches event files under the telemetry dir — never config, never anything else.
 * Fail-open. Returns the count pruned.
 */
function doPrune(dir) {
  const keepMs = retentionDays(dir) * DAY_MS;
  const cutoff = Date.now() - keepMs;
  let pruned = 0;
  for (const name of listDir(dir)) {
    if (!isEventFile(name)) continue;
    const abs = path.join(dir, name);
    let mtime = Date.now();
    try {
      mtime = fs.statSync(abs).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) {
      try {
        fs.rmSync(abs, { force: true });
        pruned++;
      } catch {
        /* ignore */
      }
    }
  }
  return result(true, { pruned, dir });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function doStatus(dir) {
  const enabled = isEnabled(dir);
  if (!enabled) {
    // Off → empty data (null) so the --json envelope reads as "no data" (BR-TEL-013).
    return result(true, null, [
      { level: 'INFO', code: 'TEL-OFF', message: 'telemetry is off — run forge telemetry on' },
    ]);
  }
  const events = readAllEvents(dir);
  if (events.length === 0) {
    return result(true, null, [
      { level: 'INFO', code: 'TEL-EMPTY', message: 'telemetry on but empty — no events recorded yet' },
    ]);
  }
  const days = new Set();
  for (const e of events) {
    if (e && typeof e.ts === 'string') days.add(e.ts.slice(0, 10));
  }
  const span = [...days].sort();
  return result(true, {
    enabled: true,
    events: events.length,
    dayFrom: span[0] || null,
    dayTo: span[span.length - 1] || null,
    bytes: storeBytes(dir),
  });
}

// ---------------------------------------------------------------------------
// stat — the rollup (prunes lazily first)
// ---------------------------------------------------------------------------

/** Parse a --since token (7d | 24h | YYYY-MM-DD) into a cutoff ms, or null (all). */
function parseSince(token) {
  if (!token) return null;
  const m = /^(\d+)([dh])$/.exec(String(token).trim());
  if (m) {
    const n = Number(m[1]);
    return Date.now() - n * (m[2] === 'd' ? DAY_MS : 3600 * 1000);
  }
  const d = Date.parse(String(token).trim());
  return Number.isFinite(d) ? d : null;
}

/** Percentile (p in [0,1]) of a numeric array. Returns null on empty. */
function percentile(values, p) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)));
  return xs[idx];
}

/** Build the stat rollup from the (already pruned) store. */
function doStat(dir, since) {
  const enabled = isEnabled(dir);
  // Prune lazily before rolling up (BR-TEL-011) — only when enabled (no dir churn off).
  if (enabled) doPrune(dir);

  let events = readAllEvents(dir);
  const cutoff = parseSince(since);
  if (cutoff != null) {
    events = events.filter((e) => e && typeof e.ts === 'string' && Date.parse(e.ts) >= cutoff);
  }

  if (!enabled || events.length === 0) {
    const msg = !enabled
      ? 'telemetry is off — run forge telemetry on'
      : 'telemetry on but empty — no data yet (events appear once hooks fire)';
    // Empty data (null) so the --json envelope reads as "no data" (BR-TEL-013).
    return result(true, null, [{ level: 'INFO', code: 'TEL-EMPTY', message: msg }]);
  }

  // Hook fire counts + deny rate per rule.
  /** @type {Record<string, {fires:number, denies:number}>} */
  const byRule = {};
  /** @type {Record<string, number>} */
  const byType = {};
  /** @type {Record<string, number>} */
  const invokes = {}; // agent/skill invoke counts keyed by artifact_id|event_type
  let typecheckRuns = 0;
  let typecheckFails = 0;
  /** @type {Record<string, number[]>} */
  const hookDurations = {};

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const type = typeof e.event_type === 'string' ? e.event_type : 'unknown';
    byType[type] = (byType[type] || 0) + 1;

    const rule = typeof e.rule === 'string' && e.rule ? e.rule : null;
    if (rule) {
      const r = byRule[rule] || (byRule[rule] = { fires: 0, denies: 0 });
      r.fires++;
      if (e.decision === 'deny') r.denies++;
      if (typeof e.duration_ms === 'number') {
        (hookDurations[rule] || (hookDurations[rule] = [])).push(e.duration_ms);
      }
    }

    if (type === 'typecheck.run') {
      if (e.decision === 'pass' || e.decision === 'fail') typecheckRuns++;
      if (e.decision === 'fail') typecheckFails++;
    }
    if (type === 'agent.invoke' || type === 'skill.invoke') {
      const key = (typeof e.artifact_id === 'string' && e.artifact_id) ? e.artifact_id : type;
      invokes[key] = (invokes[key] || 0) + 1;
    }
  }

  const denyRates = Object.entries(byRule).map(([rule, r]) => ({
    rule,
    fires: r.fires,
    denies: r.denies,
    denyRate: r.fires > 0 ? Number((r.denies / r.fires).toFixed(3)) : 0,
  }));

  const slowestHooks = Object.entries(hookDurations).map(([rule, ds]) => ({
    rule,
    p50: percentile(ds, 0.5),
    p95: percentile(ds, 0.95),
    n: ds.length,
  })).sort((a, b) => (b.p95 || 0) - (a.p95 || 0));

  const mostInvoked = Object.entries(invokes)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);

  const data = {
    enabled: true,
    events: events.length,
    since: since || null,
    byType,
    denyRates,
    typecheck: {
      runs: typecheckRuns,
      fails: typecheckFails,
      failPct: typecheckRuns > 0 ? Number(((typecheckFails / typecheckRuns) * 100).toFixed(1)) : 0,
    },
    mostInvoked,
    slowestHooks,
    trend: dailyTrend(events),
  };
  return result(true, data);
}

/** Daily event-count trend as a sparkline + per-day counts (last 14 days present). */
function dailyTrend(events) {
  /** @type {Record<string, number>} */
  const perDay = {};
  for (const e of events) {
    if (e && typeof e.ts === 'string') {
      const day = e.ts.slice(0, 10);
      perDay[day] = (perDay[day] || 0) + 1;
    }
  }
  const days = Object.keys(perDay).sort().slice(-14);
  const counts = days.map((d) => perDay[d]);
  return { days, counts, sparkline: sparkline(counts) };
}

/** Unicode block sparkline (no dependency). Empty → ''. */
function sparkline(counts) {
  if (!counts || counts.length === 0) return '';
  const blocks = '▁▂▃▄▅▆▇█';
  const max = Math.max(...counts, 1);
  return counts.map((c) => blocks[Math.min(blocks.length - 1, Math.floor((c / max) * (blocks.length - 1)))]).join('');
}

// ---------------------------------------------------------------------------
// monitor — at-a-glance snapshot (a thin projection of stat)
// ---------------------------------------------------------------------------

function doMonitor(dir) {
  const enabled = isEnabled(dir);
  if (!enabled) {
    return result(true, null, [
      { level: 'INFO', code: 'TEL-OFF', message: 'telemetry is off — run forge telemetry on' },
    ]);
  }
  const stat = doStat(dir, null);
  if (!stat.data || stat.data.events === 0) {
    return result(true, null, [
      { level: 'INFO', code: 'TEL-EMPTY', message: 'telemetry on but empty — no events recorded yet' },
    ]);
  }
  const d = stat.data;
  return result(true, {
    enabled: true,
    events: d.events,
    typecheckFailPct: d.typecheck.failPct,
    topDeny: d.denyRates.slice().sort((a, b) => b.denies - a.denies)[0] || null,
    topInvoke: d.mostInvoked[0] || null,
    trend: d.trend.sparkline,
  });
}

// ---------------------------------------------------------------------------
// C4 contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr; returns `{ ok, data, findings, summary }`.
 * Fail-open: any internal failure degrades to an empty result, never a throw.
 *
 * @param {string} subcmd on|off|status|prune|wipe (telemetry verbs) | stat | monitor
 * @param {any} args string[] | { positional, flags, opts }
 * @param {any} ctx { HOME?, dir? } — an in-process caller may inject a sandbox dir
 * @returns {Promise<{ok:boolean, data:any, findings:any[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const list = Array.isArray(args) ? args : [];
    const dir = (ctx && ctx.dir) || telemetryDir();
    const since = sinceFromArgs(list);
    switch (subcmd) {
      case 'on':
        return doOn(dir);
      case 'off':
        return doOff(dir);
      case 'status':
        return doStatus(dir);
      case 'prune':
        return doPrune(dir);
      case 'wipe':
        return doWipe(dir);
      case 'stat':
        return doStat(dir, since);
      case 'monitor':
        return doMonitor(dir);
      default:
        return result(true, { enabled: isEnabled(dir) }, [
          { level: 'INFO', code: 'TEL-USAGE', message: `unknown telemetry verb: ${subcmd || '(none)'}` },
        ]);
    }
  } catch {
    // Fail-open: never throw past the module surface (BR-TEL-013).
    return result(true, null, [
      { level: 'INFO', code: 'TEL-EMPTY', message: 'telemetry unavailable (no data)' },
    ]);
  }
}

/** Pull a `--since <token>` (or `--since=<token>`) from an arg list. */
function sinceFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--since') return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
    if (typeof a === 'string' && a.startsWith('--since=')) return a.slice('--since='.length);
  }
  return null;
}

/**
 * Compose a one-line status panel for `forge status` (SPEC-08). Renders a
 * `(no data — run forge telemetry on)` stub when off/empty.
 * @param {any} state the data payload from a stat/status run
 */
export function summarize(state) {
  if (!state || typeof state !== 'object' || state.enabled === false || !state.events) {
    return makePanel({ panel: 'telemetry', ok: false, lines: ['(no data)'], hint: 'run forge telemetry on' });
  }
  const lines = [`${state.events} event(s)`];
  if (state.typecheck) lines.push(`typecheck fail ${state.typecheck.failPct}%`);
  if (state.trend && state.trend.sparkline) lines.push(state.trend.sparkline);
  return makePanel({ panel: 'telemetry', ok: true, lines });
}

/** Panel object with a non-enumerable toString (mirrors efficiency.mjs#makePanel). */
function makePanel(p) {
  Object.defineProperty(p, 'toString', {
    value() {
      const body = Array.isArray(p.lines) ? p.lines.join(' ') : '';
      return `[${p.panel}] ${body}${p.hint ? ` (${p.hint})` : ''}`;
    },
    enumerable: false,
  });
  return p;
}

// ---------------------------------------------------------------------------
// Human render (print side) — PURE; the dual-mode block writes it
// ---------------------------------------------------------------------------

/** @param {string} subcmd @param {any} res @returns {string} */
function renderHuman(subcmd, res) {
  const d = res && res.data ? res.data : {};
  const lines = [];
  // Surface any INFO findings first (off/empty messages, BR-TEL-013).
  for (const f of res.findings || []) lines.push(`[forge:telemetry] ${f.message}`);

  switch (subcmd) {
    case 'on':
      lines.push(`telemetry ON (retention ${d.retentionDays} days) — store: ${d.dir}`);
      break;
    case 'off':
      lines.push('telemetry OFF — recording stopped (existing data kept).');
      break;
    case 'wipe':
      lines.push(`wiped ${d.removed || 0} telemetry file(s) (config kept).`);
      break;
    case 'prune':
      lines.push(`pruned ${d.pruned || 0} telemetry file(s) past retention.`);
      break;
    case 'status':
      if (d.enabled && d.events) {
        lines.push(`telemetry ON — ${d.events} event(s), ${d.dayFrom}..${d.dayTo}, ${formatBytes(d.bytes)}`);
      } else if (d.enabled) {
        lines.push('telemetry ON — empty store (no events yet).');
      }
      break;
    case 'stat':
      if (d.events) {
        lines.push(`forge stat — ${d.events} event(s)${d.since ? ` since ${d.since}` : ''}`);
        lines.push(`  typecheck fail: ${d.typecheck.failPct}% (${d.typecheck.fails}/${d.typecheck.runs})`);
        for (const r of d.denyRates) lines.push(`  ${r.rule}: ${r.fires} fire(s), ${(r.denyRate * 100).toFixed(0)}% deny`);
        for (const m of d.mostInvoked.slice(0, 5)) lines.push(`  invoke ${m.key}: ${m.count}`);
        for (const h of d.slowestHooks.slice(0, 5)) lines.push(`  slow ${h.rule}: p50 ${h.p50}ms p95 ${h.p95}ms`);
        if (d.trend && d.trend.sparkline) lines.push(`  trend: ${d.trend.sparkline}`);
      }
      break;
    case 'monitor':
      if (d.events) {
        lines.push(`forge monitor — ${d.events} event(s)`);
        lines.push(`  typecheck fail: ${d.typecheckFailPct}%`);
        if (d.topDeny) lines.push(`  top deny: ${d.topDeny.rule} (${d.topDeny.denies})`);
        if (d.topInvoke) lines.push(`  top invoke: ${d.topInvoke.key} (${d.topInvoke.count})`);
        if (d.trend) lines.push(`  trend: ${d.trend}`);
      }
      break;
    default:
      break;
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0; // readers always exit 0 (BR-TEL-013)
}

/** Human byte formatter. */
function formatBytes(n) {
  const b = typeof n === 'number' ? n : 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------
// Dual-mode: direct script entry
//   node manager/telemetry.mjs <on|off|status|prune|wipe|stat|monitor> [flags]
// CRITICAL: guarded by isMain() and NEVER process.exit() at import time (mirrors
// registry/status/fleet/efficiency) so the node:test runner is never killed.
// ---------------------------------------------------------------------------

/** Best-effort FORGE library root = two levels up from this module. */
function selfForgeRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

/** Read the raw forge VERSION for the envelope `forge` field (fail-open). */
function readRawVersion(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'VERSION'), 'utf8');
    return (raw || '').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** True when this module is executed directly (not imported). */
function isMain() {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const subcmd = argv[0];
  const rest = argv.slice(1);
  const json = rest.includes('--json');
  run(subcmd, rest, {})
    .then((res) => {
      if (json) {
        const env = envelope({
          command: `telemetry ${subcmd || ''}`.trim(),
          ok: res.ok,
          data: res.data,
          findings: res.findings,
          summary: res.summary,
          forgeVersion: readRawVersion(selfForgeRoot()),
        });
        writeStdoutSync(JSON.stringify(env) + '\n'); // SYNC write before exit — pipe-flush truncation (see json-out.mjs)
        process.exit(0); // readers always exit 0 (BR-TEL-013)
      } else {
        process.exit(renderHuman(subcmd, res));
      }
    })
    .catch(() => {
      // Fail-open: never an unhandled rejection; readers exit 0 with an off/empty note.
      process.stdout.write('[forge:telemetry] telemetry unavailable (no data)\n');
      process.exit(0);
    });
}

export default { run, summarize };
