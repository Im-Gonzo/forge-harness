// @ts-check
/**
 * status — the manager's composed dashboard (SPEC-08 §"forge status", BR-CLI-005/006,
 * ADR-0016). `status` is the skeleton's PROOF-OF-COMPOSITION: it calls each
 * dimension's `summarize(state)` (the C4 contract, SPEC-00), composes ONE panel per
 * dimension, computes an OVERALL line, and prints a NEXT ACTIONS list derived from the
 * collected findings/hints.
 *
 * At v0.3 the REGISTRY, DEPENDENCY, FLEET and EFFICIENCY panels are LIVE — REGISTRY
 * imports `summarize` from `./registry.mjs` and reads the committed
 * `<root>/.forge/registry.json` snapshot via the store seam (artifact counts by
 * status); DEPENDENCY reads that same snapshot's `danglingRefs[]`/derived orphans
 * (counts + dangling-ref names as advisory findings); FLEET reads the machine-local
 * `~/.claude/forge/fleet.json` cache (project counts + health grades) when enabled;
 * EFFICIENCY surfaces the always-on budget total from the machine-local `analyze`
 * cache when present. At v0.4 the TELEMETRY and EVAL panels also go LIVE: TELEMETRY
 * reads the machine-local opt-in store (`~/.claude/forge/telemetry/`) and shows an
 * event-count rollup when recording is on AND events exist (else the honest `OFF
 * (no data …)` stub); EVAL reads the git-tracked eval results under
 * `<root>/.forge/eval/` and shows coverage + the worst grade when results exist (else
 * the `(no data …)` stub). Every live panel degrades to `(no data — run <command>)`
 * with the tri-state `ok: null` when its upstream signal is absent. The SHAPE is fixed
 * so the dimensions slot in unchanged.
 *
 * `status` is INFORMATIONAL: it ALWAYS exits 0 (EVAL-CLI-004) — advisory WARNs print
 * but never flip the exit. FAIL-OPEN (EVAL-INT-002, BR-INT-003): an absent or corrupt
 * registry degrades the REGISTRY panel to `(no data — run forge registry build)` while
 * every other panel renders normally; nothing throws, the exit stays 0.
 *
 * This module is dual-mode (SPEC-00 delegation): a runnable script —
 *   node manager/status.mjs [--json] [rootDir]
 * rendering the human dashboard or the C3 `--json` envelope (command "status",
 * `data.panels` keyed by dimension, all advisory findings collected at the top level,
 * `ok = summary.errors === 0`); AND a module exporting `run(subcmd, args, ctx)` +
 * `summarize(state)` for in-process callers and tests. PRINT happens ONLY in the script
 * entry (the print/compute split, EVAL-CLI-007): `run()` never writes stdout.
 *
 * HARD INVARIANTS: zero runtime deps (node: builtins + relative imports only);
 * additive-never-destructive; fail-open; read-only (status writes nothing).
 *
 * @module manager/status
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import { readJson, forgeStateDir, machineStateHome } from './lib/store.mjs';
import * as registry from './registry.mjs';

// ---------------------------------------------------------------------------
// Dimension stub catalogue (the fixed v0.2 panel ordering, SPEC-08)
// ---------------------------------------------------------------------------

/**
 * The fill-command + label per LIVE dimension key (used both for the live composer's
 * no-data fallback hint and the human label). At v0.4 telemetry/eval go live too (their
 * live composers below); the panel shape is fixed now (SPEC-08 notes) so they slot in
 * without re-design.
 */
const DEPENDENCY_FILL = 'forge registry build --write';
const FLEET_FILL = 'forge fleet enable && forge fleet scan';
const EFFICIENCY_FILL = 'forge analyze';
const TELEMETRY_FILL = 'forge telemetry on';
const EVAL_FILL = 'forge eval-harness --all';

/**
 * The no-data fallback descriptor per telemetry/eval dimension (registry/dependency/
 * fleet/efficiency are composed LIVE, separately; telemetry/eval are composed LIVE too
 * and FALL BACK to these stubs when their upstream signal is absent). Each carries its
 * no-data `state`, the `command` that fills it, and a one-line human label. Telemetry's
 * `prefix:'OFF'` is preserved on its no-data line (SPEC-08 mock).
 *
 * @type {Array<{key:string, label:string, state:string, command:string, prefix?:string}>}
 */
const STUB_DIMENSIONS = [
  { key: 'telemetry', label: 'TELEMETRY', state: 'off', command: TELEMETRY_FILL, prefix: 'OFF' },
  { key: 'eval', label: 'EVAL', state: 'no-data', command: EVAL_FILL },
];

/** The human label per panel key (registry included). */
const PANEL_LABEL = {
  registry: 'REGISTRY',
  dependency: 'DEPENDENCY',
  fleet: 'FLEET',
  telemetry: 'TELEMETRY',
  efficiency: 'EFFICIENCY',
  eval: 'EVAL',
};

// ---------------------------------------------------------------------------
// Composition: one panel per dimension
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} StatusPanel
 * @property {string} panel The dimension key (registry/dependency/…).
 * @property {boolean|null} ok true|false|null — `null` is the no-data tri-state.
 * @property {string[]} lines Human lines for the panel body.
 * @property {string} [hint] The command that fills/clears this panel.
 * @property {string} [state] The no-data state token ("no-data"|"off") for stubs.
 * @property {Object} [data] Structured panel payload (e.g. registry counts).
 */

/** Read the committed registry snapshot at `<root>/.forge/registry.json` (or null). */
function readCommittedRegistry(rootDir) {
  try {
    return readJson(path.join(forgeStateDir(rootDir), 'registry.json'));
  } catch {
    return null; // fail-open
  }
}

/**
 * Compose the LIVE registry panel by calling `registry.summarize(state)` and rendering
 * artifact counts BY STATUS. Fail-open at every step: an absent/corrupt registry (the
 * `summarize` no-data branch, or a throw) degrades to the `(no data — run forge
 * registry build)` panel, never throwing and never blanking the dashboard.
 *
 * @param {string} rootDir
 * @returns {StatusPanel}
 */
function composeRegistryPanel(rootDir) {
  let state = null;
  try {
    state = readCommittedRegistry(rootDir);
  } catch {
    state = null;
  }

  let summary = null;
  try {
    summary = registry.summarize(state);
  } catch {
    summary = null; // a throwing summarize degrades to no-data (BR-INT-003)
  }

  // No-data: registry.summarize returns ok:false with a "(no data)" line when the
  // snapshot is absent/unreadable; normalise that to the SPEC-08 no-data panel so the
  // REGISTRY line reads exactly "(no data — run forge registry build)".
  const hasArtifacts =
    state && typeof state === 'object' && Array.isArray(state.artifacts);
  if (!summary || summary.ok !== true || !hasArtifacts) {
    return {
      panel: 'registry',
      ok: null,
      state: 'no-data',
      lines: [noData('forge registry build')],
      hint: 'forge registry build',
    };
  }

  // Live: counts by status (from summarize) + a byKind breakdown for the structured
  // envelope. summarize already folded byStatus into lines; recompute byKind here for
  // the JSON `data` (the human view shows the summarize lines).
  const total = state.artifacts.length;
  const byKind = {};
  let stale = 0;
  for (const a of state.artifacts) {
    const k = a && typeof a.kind === 'string' ? a.kind : 'unknown';
    byKind[k] = (byKind[k] || 0) + 1;
    // "stale" here is a content-vs-revision drift signal; v0.2 has no such signal in
    // the snapshot, so it is honestly 0 (the validator owns the WARN, surfaced via
    // findings — not invented here).
  }
  const lines = Array.isArray(summary.lines) ? summary.lines.slice() : [];

  return {
    panel: 'registry',
    ok: true,
    lines: lines.length ? lines : [`${total} artifact(s)`],
    data: { artifacts: total, stale, byKind },
  };
}

/**
 * Compose the LIVE DEPENDENCY panel (SPEC-03/SPEC-08) from the committed registry
 * snapshot's `danglingRefs[]` plus a derived orphan count. Renders
 * `"N dangling ref(s), M orphan(s)"` and surfaces each dangling ref as an advisory WARN
 * finding (C2, source:"validate-registry"). Fail-open: an absent/corrupt snapshot
 * degrades to `(no data — run forge registry build --write)`; never throws.
 *
 * Orphans mirror `registry.mjs#doOrphans` (BR-DEP-006): an artifact in NO module with
 * ZERO inbound edges (no other record's `dependsOn[]` names it). Counting only — the
 * authoritative list lives behind `forge registry orphans`.
 *
 * @param {string} rootDir
 * @returns {{panel:StatusPanel, findings:import('./lib/findings.mjs').Finding[]}}
 */
function composeDependencyPanel(rootDir) {
  const state = readCommittedRegistry(rootDir);
  const hasRegistry = state && typeof state === 'object' && Array.isArray(state.artifacts);
  if (!hasRegistry) {
    return {
      panel: noDataPanel('dependency', DEPENDENCY_FILL),
      findings: [],
    };
  }

  const dangling = Array.isArray(state.danglingRefs) ? state.danglingRefs : [];
  const orphans = countOrphans(state.artifacts);
  const danglingN = dangling.length;

  // Each dangling ref → one advisory WARN finding (the ref name + its first site).
  /** @type {import('./lib/findings.mjs').Finding[]} */
  const findings = [];
  for (const d of dangling) {
    if (!d || typeof d.rawRef !== 'string') continue;
    const site = Array.isArray(d.sites) && d.sites.length > 0 ? d.sites[0] : null;
    findings.push(
      makeFinding({
        level: 'WARN',
        path: site && typeof site.path === 'string' ? site.path : 'registry.json',
        line: site && Number.isInteger(site.line) ? site.line : null,
        message: `dangling reference \`${d.rawRef}\`${d.from ? ` from ${d.from}` : ''} does not resolve to a known artifact`,
        source: 'validate-registry',
      }),
    );
  }

  return {
    panel: {
      panel: 'dependency',
      ok: danglingN === 0 ? true : false,
      lines: [`${danglingN} dangling ref${danglingN === 1 ? '' : 's'}, ${orphans} orphan${orphans === 1 ? '' : 's'}`],
      data: { dangling: danglingN, orphans },
    },
    findings,
  };
}

/** Count orphan artifacts (in no module + zero inbound dependsOn edges, BR-DEP-006). */
function countOrphans(artifacts) {
  const reachable = new Set();
  for (const a of artifacts) {
    const d = a && Array.isArray(a.dependsOn) ? a.dependsOn : [];
    for (const t of d) reachable.add(t);
  }
  let n = 0;
  for (const a of artifacts) {
    if (!a || typeof a.uid !== 'string') continue;
    if (Array.isArray(a.modules) && a.modules.length > 0) continue;
    if (reachable.has(a.uid)) continue;
    n++;
  }
  return n;
}

/**
 * Compose the LIVE FLEET panel (SPEC-04/SPEC-08) from the machine-local opt-in cache
 * `~/.claude/forge/fleet.json`. When the cache is absent, unreadable, or `fleetEnabled`
 * is not true, render the honest no-data stub naming the enable+scan command. When
 * present + enabled, render project counts + a health-grade breakdown
 * (`healthy/drift/unhealthy`). Fail-open: never throws (BR-FLEET-014).
 *
 * @returns {StatusPanel}
 */
function composeFleetPanel() {
  let cache = null;
  try {
    cache = readJson(path.join(machineStateHome(), 'fleet.json'));
  } catch {
    cache = null; // fail-open (corrupt/missing → no data)
  }
  const enabled = cache && typeof cache === 'object' && cache.fleetEnabled === true;
  if (!enabled) {
    return noDataPanel('fleet', FLEET_FILL);
  }

  const projects =
    cache.projects && typeof cache.projects === 'object' && !Array.isArray(cache.projects)
      ? cache.projects
      : {};
  const rows = Object.values(projects);
  const total = rows.length;
  const grades = { healthy: 0, drift: 0, unhealthy: 0 };
  for (const r of rows) {
    const g = r && r.health && typeof r.health.grade === 'string' ? r.health.grade : null;
    if (g && g in grades) grades[g]++;
  }
  const gradeParts = ['healthy', 'drift', 'unhealthy']
    .filter((g) => grades[g] > 0)
    .map((g) => `${grades[g]} ${g}`);
  const lines = [`${total} project${total === 1 ? '' : 's'}` + (gradeParts.length ? ` · ${gradeParts.join(', ')}` : '')];

  return {
    panel: 'fleet',
    ok: grades.unhealthy === 0 ? true : false,
    lines,
    data: { projects: total, grades },
  };
}

/**
 * Compose the EFFICIENCY panel (SPEC-06/SPEC-08). The static always-on budget total is
 * surfaced from the machine-local `analyze` cache (`~/.claude/forge/analyze/`) when one
 * exists; the figure is an ESTIMATE, always rendered with a leading `~` (SPEC-06). When
 * no cache exists, the panel keeps its honest stub naming `forge analyze`. Fail-open:
 * never throws.
 *
 * @returns {StatusPanel}
 */
function composeEfficiencyPanel() {
  const total = readAnalyzeAlwaysOnTotal();
  if (total == null) {
    return noDataPanel('efficiency', EFFICIENCY_FILL);
  }
  return {
    panel: 'efficiency',
    ok: true,
    lines: [`~${total} tok always-on`],
    data: { alwaysOnTotal: total },
  };
}

/**
 * Read the always-on budget total from the machine-local analyze cache, or null when no
 * cache exists / it carries no numeric `alwaysOnTotal`. Tolerates either a flat
 * `analyze.json` or the latest `analyze/<name>.json` report shape (SPEC-06 data field).
 * Fail-open.
 *
 * @returns {number|null}
 */
function readAnalyzeAlwaysOnTotal() {
  let doc = null;
  try {
    const dir = path.join(machineStateHome(), 'analyze');
    // Prefer a canonical analyze.json; else fall back to the newest report in analyze/.
    const flat = path.join(dir, 'analyze.json');
    doc = readJson(flat);
    if (!doc) {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
      } catch {
        names = [];
      }
      names.sort();
      for (let i = names.length - 1; i >= 0 && !doc; i--) {
        doc = readJson(path.join(dir, names[i]));
      }
    }
  } catch {
    doc = null; // fail-open
  }
  if (!doc || typeof doc !== 'object') return null;
  // The figure may sit at the top level or nested under a `data` envelope payload.
  const candidate =
    typeof doc.alwaysOnTotal === 'number'
      ? doc.alwaysOnTotal
      : doc.data && typeof doc.data === 'object' && typeof doc.data.alwaysOnTotal === 'number'
        ? doc.data.alwaysOnTotal
        : null;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

/**
 * Compose the LIVE TELEMETRY panel (SPEC-05/SPEC-08) from the machine-local opt-in store
 * `~/.claude/forge/telemetry/`. When recording is ENABLED (env `FORGE_TELEMETRY` beats
 * config; default off — mirrors the emitter) AND at least one event exists, render a
 * rollup line: total event count + day span + a by-type breakdown. Otherwise keep the
 * honest `OFF        (no data — run forge telemetry on)` stub (the off/empty cases read
 * the same to the dashboard — there is simply no rollup yet). Fail-open: never throws.
 *
 * Read-only and inline (the same machine-local files the telemetry readers use) so
 * status stays self-contained; no telemetry CLI semantics are invoked here.
 *
 * @returns {StatusPanel}
 */
function composeTelemetryPanel() {
  const stub = STUB_DIMENSIONS.find((d) => d.key === 'telemetry');
  const dir = telemetryDir();
  if (!telemetryEnabled(dir)) {
    return composeStubPanel(stub); // OFF — keep the honest no-data stub.
  }
  const events = readTelemetryEvents(dir);
  if (events.length === 0) {
    return composeStubPanel(stub); // ON but empty — no rollup yet.
  }

  // Rollup: total count, distinct-day span, and the top event types by count.
  /** @type {Record<string, number>} */
  const byType = {};
  const days = new Set();
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const type = typeof e.event_type === 'string' && e.event_type ? e.event_type : 'unknown';
    byType[type] = (byType[type] || 0) + 1;
    if (typeof e.ts === 'string' && e.ts.length >= 10) days.add(e.ts.slice(0, 10));
  }
  const total = events.length;
  const span = [...days].sort();
  const typeParts = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([t, n]) => `${t} ${n}`);

  const spanStr =
    span.length === 0 ? '' : span.length === 1 ? ` · ${span[0]}` : ` · ${span[0]}..${span[span.length - 1]}`;
  const lines = [`ON         ${total} event${total === 1 ? '' : 's'}${spanStr}`];
  if (typeParts.length) lines.push(typeParts.join(', '));

  return {
    panel: 'telemetry',
    ok: true,
    lines,
    data: { enabled: true, events: total, dayFrom: span[0] || null, dayTo: span[span.length - 1] || null, byType },
  };
}

/** The machine-local telemetry store dir (`~/.claude/forge/telemetry`). */
function telemetryDir() {
  return path.join(machineStateHome(), 'telemetry');
}

/** Whether telemetry recording is on (env beats config; default off) — mirrors the emitter. */
function telemetryEnabled(dir) {
  const env = process.env.FORGE_TELEMETRY;
  if (env === '1') return true;
  if (env === '0') return false;
  let cfg = null;
  try {
    cfg = readJson(path.join(dir, 'config.json'));
  } catch {
    cfg = null;
  }
  return Boolean(cfg && cfg.enabled === true);
}

/** True if a name is a telemetry event file (`events-YYYY-MM-DD[.N].(jsonl|full)`). */
function isTelemetryEventFile(name) {
  return /^events-\d{4}-\d{2}-\d{2}(\.\d+)?\.(jsonl|full)$/.test(name);
}

/** Read every telemetry event line in the store as parsed records (skips malformed). Fail-open. */
function readTelemetryEvents(dir) {
  /** @type {any[]} */
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!isTelemetryEventFile(name)) continue;
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

/**
 * Compose the LIVE EVAL panel (SPEC-07/SPEC-08) from the git-tracked eval results under
 * `<root>/.forge/eval/`. When results exist, render coverage (`M/N artifact(s)`) + the
 * worst grade among graded artifacts. Otherwise keep the honest
 * `(no data — run forge eval-harness --all)` stub. Fail-open: an absent/corrupt eval
 * dir degrades to the stub; never throws.
 *
 * The reader is tolerant of the eval-result shapes the harness may persist (SPEC-07
 * §Golden-set layout / §Eval-linkage payload, SPEC-09 §Eval-linkage slot): a flat
 * `eval/results.json`/`eval/dashboard.json` carrying `{artifacts:[…]}`, a derived
 * `eval/baselines.json`, or per-uid `eval/baselines/<uid>.json`. Each artifact entry
 * carries an `eval` slot with a `grade` (A–F | U) and `status`. Coverage counts
 * artifacts with a graded (non-`U`/non-`UNEVALUATED`) golden set against the total seen.
 *
 * @param {string} rootDir
 * @returns {StatusPanel}
 */
function composeEvalPanel(rootDir) {
  const stub = STUB_DIMENSIONS.find((d) => d.key === 'eval');
  const rows = readEvalArtifacts(rootDir);
  if (rows.length === 0) {
    return composeStubPanel(stub); // no results → honest no-data stub.
  }

  const total = rows.length;
  let covered = 0;
  let worst = null; // worst (lowest) graded letter among A–F
  for (const r of rows) {
    const grade = evalGradeOf(r);
    const graded = isGradedLetter(grade);
    const hasSet =
      graded ||
      r.hasGoldenSet === true ||
      (r.status && typeof r.status === 'string' && r.status.toUpperCase() !== 'UNEVALUATED');
    if (hasSet) covered++;
    if (graded) {
      if (worst === null || gradeRank(grade) < gradeRank(worst)) worst = grade;
    }
  }

  const worstStr = worst ? worst : '—'; // no graded letter yet → U renders the em-dash (BR-EVAL-010)
  const pct = total > 0 ? Math.round((covered / total) * 100) : 0;
  const lines = [`${covered}/${total} covered (${pct}%) · worst grade ${worstStr}`];

  return {
    panel: 'eval',
    ok: worst === null || gradeRank(worst) > gradeRank('D') ? true : false,
    lines,
    data: { coverage: { covered, total }, worstGrade: worst, evaluated: covered },
  };
}

/**
 * Read the per-artifact eval rows from the git-tracked eval dir, tolerant of the shapes
 * the harness may persist. Returns a flat array of `{ ...eval-slot, hasGoldenSet?, uid? }`
 * rows (one per artifact). Fail-open: any IO/parse error or absent dir yields `[]`.
 *
 * @param {string} rootDir
 * @returns {Array<{grade?:string, status?:string, hasGoldenSet?:boolean, uid?:string, eval?:any}>}
 */
function readEvalArtifacts(rootDir) {
  let evalDir;
  try {
    evalDir = path.join(forgeStateDir(rootDir), 'eval');
  } catch {
    return [];
  }
  // Quick existence gate — an absent eval dir is the (common) no-data case.
  let topNames = [];
  try {
    topNames = fs.readdirSync(evalDir);
  } catch {
    return [];
  }

  /** @type {any[]} */
  const rows = [];
  const seen = new Set();
  const pushRow = (row) => {
    if (!row || typeof row !== 'object') return;
    // Normalise: the eval payload may sit at the top level or under an `eval` slot.
    const slot = row.eval && typeof row.eval === 'object' ? row.eval : row;
    const uid = typeof row.uid === 'string' ? row.uid : null;
    const key = uid || JSON.stringify(slot);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ uid, hasGoldenSet: row.hasGoldenSet, status: slot.status, grade: slot.grade, eval: slot });
  };
  const ingestDoc = (doc) => {
    if (!doc || typeof doc !== 'object') return;
    if (Array.isArray(doc.artifacts)) {
      for (const a of doc.artifacts) pushRow(a);
    } else if (doc.artifacts && typeof doc.artifacts === 'object') {
      // keyed-by-uid object: { "agent:x": { eval: {…} }, … }
      for (const [uid, a] of Object.entries(doc.artifacts)) pushRow({ uid, ...(a && typeof a === 'object' ? a : {}) });
    } else if (doc.uid || doc.grade || doc.eval) {
      pushRow(doc); // a single per-uid baseline file
    }
  };

  // 1. Flat roll-up docs under eval/ (results.json | dashboard.json | baselines.json).
  for (const name of ['results.json', 'dashboard.json', 'baselines.json']) {
    if (!topNames.includes(name)) continue;
    let doc = null;
    try {
      doc = readJson(path.join(evalDir, name));
    } catch {
      doc = null;
    }
    ingestDoc(doc);
  }

  // 2. Per-uid baseline files under eval/baselines/.
  if (topNames.includes('baselines')) {
    let blNames = [];
    try {
      blNames = fs.readdirSync(path.join(evalDir, 'baselines'));
    } catch {
      blNames = [];
    }
    for (const n of blNames) {
      if (!n.endsWith('.json')) continue;
      let doc = null;
      try {
        doc = readJson(path.join(evalDir, 'baselines', n));
      } catch {
        doc = null;
      }
      ingestDoc(doc);
    }
  }

  return rows;
}

/** The eval grade letter for a row (`A`..`F` | `U`), or null when absent. */
function evalGradeOf(row) {
  const g = row && row.grade;
  return typeof g === 'string' && g.length ? g.toUpperCase() : null;
}

/** True for a real graded letter (A–F); `U`/null are NOT graded (BR-EVAL-010). */
function isGradedLetter(grade) {
  return typeof grade === 'string' && /^[A-F]$/.test(grade);
}

/** Rank a grade so a numeric compare picks the WORST (A best → F worst). */
function gradeRank(grade) {
  const order = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };
  return grade && grade in order ? order[grade] : 99; // unknown sorts as "not worst"
}

/** A honest no-data panel for a live dimension whose upstream signal is absent. */
function noDataPanel(key, command) {
  return {
    panel: key,
    ok: null,
    state: 'no-data',
    lines: [noData(command)],
    hint: command,
  };
}

/**
 * Compose a single STUB panel (telemetry/eval). Honest no-data: `ok:null`, a
 * `(no data — run <command>)` line, and the filling command as the hint. Telemetry
 * additionally prints its OFF prefix (SPEC-08 mock).
 *
 * @param {{key:string, label:string, state:string, command:string, prefix?:string}} dim
 * @returns {StatusPanel}
 */
function composeStubPanel(dim) {
  const body = dim.prefix ? `${dim.prefix}        ${noData(dim.command)}` : noData(dim.command);
  return {
    panel: dim.key,
    ok: null,
    state: dim.state,
    lines: [body],
    hint: dim.command,
  };
}

/** The fail-open no-data placeholder string (SPEC-08 contract). */
function noData(command) {
  return `(no data — run ${command})`;
}

/**
 * Compose the full status state: every panel (registry LIVE, the rest STUBS), the
 * collected advisory findings, and the level summary. PURE compute — no stdout, never
 * throws past its surface (fail-open).
 *
 * @param {string} rootDir
 * @returns {{panels:Object<string,StatusPanel>, panelOrder:string[], findings:import('./lib/findings.mjs').Finding[], summary:{errors:number,warnings:number,info:number}, ok:boolean}}
 */
function composeStatus(rootDir) {
  /** @type {Object<string,StatusPanel>} */
  const panels = {};
  /** @type {string[]} */
  const panelOrder = [];
  /** @type {import('./lib/findings.mjs').Finding[]} */
  const findings = [];

  // Each panel is composed behind its OWN try/catch so one throwing dimension renders
  // `(no data — error reading X)` and never blanks the dashboard (SPEC-08 fail-open).
  const place = (key, command, compose) => {
    let panel;
    try {
      const out = compose();
      // A live composer may return { panel, findings } (it raises advisory findings); a
      // stub/registry composer returns the panel directly.
      if (out && typeof out === 'object' && out.panel && typeof out.panel === 'object') {
        panel = out.panel;
        for (const f of out.findings || []) findings.push(f);
      } else {
        panel = out;
      }
    } catch (e) {
      panel = errorPanel(key, command, e);
      findings.push(panelErrorFinding(key, e));
    }
    panels[key] = panel;
    panelOrder.push(key);
  };

  // Fixed v0.3 ordering: registry → dependency → fleet → telemetry → efficiency → eval.
  place('registry', 'forge registry build', () => composeRegistryPanel(rootDir));
  place('dependency', DEPENDENCY_FILL, () => composeDependencyPanel(rootDir));
  place('fleet', FLEET_FILL, () => composeFleetPanel());

  place('telemetry', TELEMETRY_FILL, () => composeTelemetryPanel());
  place('efficiency', EFFICIENCY_FILL, () => composeEfficiencyPanel());
  place('eval', EVAL_FILL, () => composeEvalPanel(rootDir));

  // The level summary is over the collected advisory findings only (status invents no
  // findings of its own beyond per-panel error fail-opens). errors===0 in the normal
  // path keeps OVERALL ok and the exit 0 (ADR-0007: advisory WARNs do not block).
  const summary = levelCounts(findings);
  const ok = summary.errors === 0;
  return { panels, panelOrder, findings, summary, ok };
}

/**
 * A panel that failed to compose: rendered as `(no data — error reading X)` WARN-style
 * placeholder so one bad dimension never blanks the dashboard (SPEC-08 edge cases).
 * @param {string} key @param {string} command @param {any} _e
 * @returns {StatusPanel}
 */
function errorPanel(key, command, _e) {
  return {
    panel: key,
    ok: null,
    state: 'no-data',
    lines: [`(no data — error reading ${key})`],
    hint: command,
  };
}

/** A WARN finding for a panel that threw while composing (fail-open, advisory). */
function panelErrorFinding(key, e) {
  return makeFinding({
    level: 'WARN',
    path: key,
    line: null,
    message: `error composing ${key} panel: ${e && e.message ? e.message : String(e)}`,
    source: 'status',
  });
}

/** Count findings by level into the uniform triple. */
function levelCounts(findings) {
  const s = { errors: 0, warnings: 0, info: 0 };
  for (const f of findings || []) {
    if (f && f.level === 'ERROR') s.errors++;
    else if (f && f.level === 'WARN') s.warnings++;
    else if (f && f.level === 'INFO') s.info++;
  }
  return s;
}

/**
 * Derive the NEXT ACTIONS list from the collected findings + each no-data panel's
 * hint (SPEC-08: "leaning derived-from-findings with a per-dimension hint fallback").
 * De-duped, capped, stable order: error/warn findings first, then panel hints.
 *
 * @param {Object<string,StatusPanel>} panels
 * @param {string[]} panelOrder
 * @param {import('./lib/findings.mjs').Finding[]} findings
 * @returns {string[]}
 */
function nextActions(panels, panelOrder, findings) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    if (typeof s === 'string' && s.length && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };

  // 1. Findings-derived actions (the advisory WARNs/ERRORs that have a remedy).
  for (const f of findings || []) {
    if (f && (f.level === 'ERROR' || f.level === 'WARN')) {
      push(`fix ${f.path}: ${f.message}`);
    }
  }

  // 2. Per-dimension hint fallback: the command that fills each no-data panel.
  for (const key of panelOrder) {
    const p = panels[key];
    if (p && p.ok === null && typeof p.hint === 'string' && p.hint.length) {
      push(p.hint);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * Normalise the heterogeneous `args`/`ctx` shapes into { rootDir, json }. The script
 * entry passes `args` as a string[] (e.g. ['--json', '/sandbox']); a ctx may carry
 * `{ FORGE_ROOT|forgeRoot|root|cwd }`. The trailing non-flag positional is a rootDir
 * (tests target sandboxes via `forge status <root>`).
 *
 * @param {any} args
 * @param {any} ctx
 * @returns {{rootDir:string, json:boolean}}
 */
function normalize(args, ctx) {
  const list = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  const positional = [];
  let json = false;
  for (const a of list) {
    if (typeof a !== 'string') continue;
    if (a === '--json') json = true;
    else if (!a.startsWith('--')) positional.push(a);
  }
  if (ctx && ctx.flags instanceof Set && ctx.flags.has('json')) json = true;
  const rootDir =
    (ctx && (ctx.FORGE_ROOT || ctx.forgeRoot || ctx.root || ctx.cwd)) ||
    (positional.length && positional[positional.length - 1]) ||
    process.cwd();
  return { rootDir, json: !!json };
}

/**
 * C4 entry. NEVER writes stdout. Returns { ok, data, findings, summary }. `status` is
 * read-only and informational; `ok = summary.errors === 0` (advisory WARNs do not flip
 * it — ADR-0007). Fail-open: any internal failure degrades to a still-renderable status
 * rather than throwing.
 *
 * @param {string} _subcmd status takes no sub-verb (ignored, present for the C4 shape).
 * @param {any} args  string[] | { positional }
 * @param {any} ctx   { FORGE_ROOT|forgeRoot|root|cwd, flags? }
 * @returns {{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}}
 */
export function run(_subcmd, args, ctx) {
  try {
    const { rootDir } = normalize(args, ctx);
    const composed = composeStatus(rootDir);
    const actions = nextActions(composed.panels, composed.panelOrder, composed.findings);
    return {
      ok: composed.ok,
      data: { panels: composed.panels, panelOrder: composed.panelOrder, nextActions: actions },
      findings: composed.findings,
      summary: composed.summary,
    };
  } catch (e) {
    // Fail-open: status never throws past run(); degrade to an empty-but-ok result.
    return {
      ok: true,
      data: { panels: {}, panelOrder: [], nextActions: [] },
      findings: [
        makeFinding({ level: 'WARN', path: 'status', line: null, message: `status error: ${e && e.message ? e.message : String(e)}`, source: 'status' }),
      ],
      summary: { errors: 0, warnings: 1, info: 0 },
    };
  }
}

/**
 * C4 `summarize(state)` — pure; map a pre-composed status `data` (the `run()` payload)
 * to a one-panel meta-summary. `status` is itself the composer of OTHER modules'
 * summaries, so its own `summarize` is a thin roll-up used when `status` appears as a
 * dimension elsewhere. Returns a `(no data)` panel when state is absent (fail-open).
 *
 * @param {any} state the `run()` data payload ({ panels, ... }) if available
 * @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  if (!state || typeof state !== 'object' || !state.panels || typeof state.panels !== 'object') {
    return makePanel({ panel: 'status', ok: false, lines: ['(no data)'], hint: 'run forge status' });
  }
  const keys = Object.keys(state.panels);
  const live = keys.filter((k) => state.panels[k] && state.panels[k].ok === true).length;
  return makePanel({
    panel: 'status',
    ok: true,
    lines: [`${keys.length} dimension(s)`, `${live} live`],
  });
}

/**
 * Build a Panel object with a non-enumerable `toString` (mirrors registry.mjs#makePanel)
 * so `String(panel)` renders a human line while JSON stays the clean shape.
 * @param {{panel:string, ok:boolean, lines:string[], hint?:string}} p
 */
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
// Human render (print side) — the composed dashboard mock (SPEC-08)
// ---------------------------------------------------------------------------

const RULE = '='.repeat(64);
const SUBRULE = '-'.repeat(64);

/** Read the raw forge VERSION for the banner / envelope `forge` field (fail-open). */
function readRawVersion(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'VERSION'), 'utf8');
    const v = (raw || '').trim();
    return v || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Today's date as YYYY-MM-DD (fail-open to empty). */
function today() {
  try {
    return new Date().toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

/**
 * Render the composed status as the human dashboard (SPEC-08 mock). Returns the full
 * text block (the caller writes it to stdout). PURE string assembly — no I/O.
 *
 * @param {string} rootDir
 * @param {{ok:boolean,data:any,findings:any[],summary:any}} res
 * @returns {string}
 */
function renderHuman(rootDir, res) {
  const version = readRawVersion(rootDir);
  const panels = (res.data && res.data.panels) || {};
  const order = (res.data && res.data.panelOrder) || Object.keys(panels);
  const findings = res.findings || [];
  const summary = res.summary || { errors: 0, warnings: 0, info: 0 };

  const lines = [];
  lines.push(RULE);
  lines.push(` forge status — harness @ ${version}${pad(version)}${today()}`);
  lines.push(RULE);

  // Per-panel block: LABEL + body lines, divided by a sub-rule (skip the trailing one).
  order.forEach((key, i) => {
    const p = panels[key];
    if (!p) return;
    const label = PANEL_LABEL[key] || key.toUpperCase();
    const body = Array.isArray(p.lines) ? p.lines : [];
    lines.push(` ${label.padEnd(15)} ${body[0] || ''}`.trimEnd());
    for (let j = 1; j < body.length; j++) lines.push(`   ${body[j]}`);
    if (i < order.length - 1) lines.push(` ${SUBRULE}`);
  });

  // OVERALL line + advisory note (ADR-0007: advisory-only, nothing blocks).
  lines.push(` ${SUBRULE}`);
  const w = summary.warnings || 0;
  const e = summary.errors || 0;
  const overall = e === 0
    ? `OK with ${w} advisory warning${w === 1 ? '' : 's'} (${e} errors)`
    : `${e} error${e === 1 ? '' : 's'}, ${w} warning${w === 1 ? '' : 's'}`;
  lines.push(` OVERALL         ${overall}`);
  if (e === 0) lines.push(`                 advisory-only — nothing is blocking (see ADR-0007)`);

  // Surface the advisory findings under OVERALL (the WARNs the panels carry).
  for (const f of findings) {
    const loc = f.line ? `${f.path}:${f.line}` : f.path;
    lines.push(`   ! ${loc} ${f.message}   (${f.level})`);
  }

  // NEXT ACTIONS — derived from findings + per-dimension hints.
  const actions = (res.data && res.data.nextActions) || [];
  lines.push(` NEXT ACTIONS`);
  if (actions.length === 0) {
    lines.push(`   (none)`);
  } else {
    actions.forEach((a, i) => lines.push(`   ${i + 1}. ${a}`));
  }
  lines.push(RULE);
  return lines.join('\n') + '\n';
}

/** Right-pad the version cell so the date sits at the right margin (best-effort). */
function pad(version) {
  const used = ` forge status — harness @ ${version}`.length;
  const gap = Math.max(1, 64 - used - 10);
  return ' '.repeat(gap);
}

// ---------------------------------------------------------------------------
// Dual-mode: direct script entry
//   node manager/status.mjs [--json] [rootDir]
// Renders the human dashboard, or the C3 --json envelope under --json. PRINT happens
// ONLY here (the print/compute split, EVAL-CLI-007): run() never writes stdout.
// status is INFORMATIONAL — it ALWAYS exits 0 (EVAL-CLI-004).
// ---------------------------------------------------------------------------

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
  const { rootDir, json } = normalize(argv, {});
  let res;
  try {
    res = run('', argv, {});
  } catch {
    // Last-resort fail-open: never throw out of the script entry.
    res = { ok: true, data: { panels: {}, panelOrder: [], nextActions: [] }, findings: [], summary: { errors: 0, warnings: 0, info: 0 } };
  }

  if (json) {
    const env = envelope({
      command: 'status',
      ok: res.ok,
      data: res.data,
      findings: res.findings,
      summary: res.summary,
      forgeVersion: readRawVersion(rootDir),
    });
    writeStdoutSync(JSON.stringify(env) + '\n'); // SYNC write before exit — pipe-flush truncation (see json-out.mjs)
  } else {
    process.stdout.write(renderHuman(rootDir, res));
  }
  // INFORMATIONAL: status ALWAYS exits 0 (EVAL-CLI-004), even with advisory WARNs.
  process.exit(0);
}

export default { run, summarize };
