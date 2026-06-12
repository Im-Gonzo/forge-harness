// @ts-check
/**
 * slices — the manager's catalog SLICE + per-project SUBSCRIPTION operator (ADR-0018).
 *
 * A SLICE is a named group of ONE source's catalog records. In v1 the grouping key is
 * the REGISTRY KIND, so a slice is "all of source X's records of kind K" (agent/skill/
 * command/rule/hook/bundle/validator/mcp/meta-test/engine). Author-declared, named
 * "packs" are a documented FUTURE extension, not v1 (ADR-0018 §1, alternatives).
 *
 *   - Slice id   = "<sourceId>/<kind>" — a forward slash (resource uids use the colon
 *                  form "<kind>:<id>", ADR-0005, so "/" keeps a slice id unambiguous).
 *   - Slice name = the kind.
 *   - Slice count= the number of that source's catalog records of that kind.
 *
 * Slices are DERIVED, never stored: this module REUSES the catalog operator's record
 * production (manager/catalog.mjs `run('build')`) and groups its records by source +
 * kind. There is no slice manifest — the only persisted state is the per-project
 * SUBSCRIPTION set (ADR-0018 §1, BR-CAT-004).
 *
 * A SUBSCRIPTION is per-active-root PROJECT state: which slice ids this project opted
 * into. It is persisted UNDER THE ACTIVE ROOT (not the git-tracked library) in
 * `.forge/subscriptions.json` (`forge.subscriptions.v1`, schemas/subscriptions.schema.json):
 *
 *   { "schema": "forge.subscriptions.v1", "version": 1,
 *     "subscribed": ["acme-skills/skill", "acme-skills/agent"] }
 *
 * A newly discovered slice defaults UNSUBSCRIBED (opt-in) — consistent with sources
 * defaulting untrusted (ADR-0017). Library-local records (source === null) belong to NO
 * slice and are ALWAYS in the catalog read-view (BR-CAT-006); they are never sliced.
 *
 * The two roots, kept STRICTLY separate (mirrors mcp.mjs/memory.mjs):
 *   - FORGE_ROOT  — this library's install location. The catalog record production we
 *                   reuse (catalog.mjs) resolves it from its own module URL; we never
 *                   re-scan, so slice derivation is a pure function of those records.
 *   - ACTIVE ROOT — the target PROJECT (ctx.cwd / ctx.root / process.cwd(), optionally a
 *                   trailing [dir] positional). subscriptions.json is read/written HERE:
 *                   `<activeRoot>/.forge/subscriptions.json`. Per-project state, like
 *                   `.forge/sources.lock` is project/machine state (ADR-0018 §3).
 *
 * HARD INVARIANTS (the plugin payload contract): zero runtime deps (node: builtins +
 * relative imports only — lint/validate-manager-zerodep.mjs enforces this);
 * additive-never-destructive; writers PREVIEW by default (write only under `--apply`);
 * fail-open (no public entry throws past its surface — it degrades to a safe
 * `{ok,data,findings,summary}` envelope). Dual-mode with an `isMain()` guard — NEVER
 * process.exit() at import time.
 *
 * Subcommands (C4 `run(subcmd, args, ctx)`):
 *   - `list [--source <id>]`          — derive slices by grouping the catalog records by
 *                                       source + kind, mark each `subscribed` from the
 *                                       project's subscriptions.json. Read-only.
 *   - `subscribe <sliceId> [--apply]` — add a slice id to the subscription set (idempotent;
 *                                       preview by default, write only under --apply).
 *   - `unsubscribe <sliceId> [--apply]` — remove a slice id (idempotent; preview by default,
 *                                       write only under --apply).
 *
 * @module manager/slices
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import { readJson, writeJsonAtomic } from './lib/store.mjs';
// REUSE the catalog operator's record production (ADR-0018 §1, BR-CAT-004). We import
// its run() and ask it to `build` the unified catalog (library ∪ synced sources); we
// then group THOSE records by source + kind. We never re-scan — slices are a pure
// function of the records catalog.mjs already produces, so a slice's identity/count
// matches the catalog view byte-for-byte. Still a relative specifier (zerodep-clean).
import { run as catalogRun } from './catalog.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The emitter stamped on findings this module raises (C2 `slice`). */
const SOURCE = 'slice';

/** The on-disk subscriptions schema tag (matches schemas/subscriptions.schema.json). */
const SCHEMA_TAG = 'forge.subscriptions.v1';

/** The subscriptions file's current version integer. */
const SCHEMA_VERSION = 1;

/** The slice-id grammar (mirrors schemas/subscriptions.schema.json#sliceId). */
const SLICE_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// Root + path resolution
// ---------------------------------------------------------------------------

/**
 * The ACTIVE PROJECT root the subscription file lives under. Mirrors how fleet/memory/
 * mcp resolve a project root: a trailing `[dir]` positional wins, else ctx.cwd / ctx.root,
 * else the process cwd. Subscriptions are per-project state (ADR-0018 §3), so this is NOT
 * the forge library root.
 * @param {string[]} positional @param {any} ctx @returns {string}
 */
function resolveActiveRoot(positional, ctx) {
  const base = (ctx && (ctx.cwd || ctx.root)) || process.cwd();
  return base;
}

/** The subscriptions file path under the active root (the only file this module writes). */
function subscriptionsPath(activeRoot) {
  return path.join(activeRoot, '.forge', 'subscriptions.json');
}

/** Project-relative subscriptions path for finding paths (fail-open). */
function relSubscriptions(activeRoot) {
  try {
    return path.relative(activeRoot, subscriptionsPath(activeRoot)) || subscriptionsPath(activeRoot);
  } catch {
    return path.join('.forge', 'subscriptions.json');
  }
}

// ---------------------------------------------------------------------------
// Subscriptions reads (forge.subscriptions.v1)
// ---------------------------------------------------------------------------

/** A fresh, empty subscriptions object (the initial shape). */
function emptySubscriptions() {
  return { schema: SCHEMA_TAG, version: SCHEMA_VERSION, subscribed: [] };
}

/**
 * Read + normalize the subscriptions file. An ABSENT file degrades to a fresh empty set
 * (the additive contract: we may create it). A present-but-malformed file degrades to
 * `{ malformed:true }` so a writer can refuse to edit. Fail-open: never throws.
 * @param {string} activeRoot
 * @returns {{ subs:{schema:string,version:number,subscribed:string[]}, existed:boolean, malformed:boolean }}
 */
function readSubscriptions(activeRoot) {
  const abs = subscriptionsPath(activeRoot);
  let existed = false;
  try {
    existed = fs.statSync(abs).isFile();
  } catch {
    existed = false;
  }
  if (!existed) {
    return { subs: emptySubscriptions(), existed: false, malformed: false };
  }
  const parsed = readJson(abs);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { subs: emptySubscriptions(), existed: true, malformed: true };
  }
  const subscribed = Array.isArray(parsed.subscribed)
    ? parsed.subscribed.filter((s) => typeof s === 'string')
    : [];
  return {
    subs: {
      schema: typeof parsed.schema === 'string' ? parsed.schema : SCHEMA_TAG,
      version: typeof parsed.version === 'number' ? parsed.version : SCHEMA_VERSION,
      subscribed,
    },
    existed: true,
    malformed: false,
  };
}

/** The deterministic on-disk shape: schema/version stamped, `subscribed` sorted + deduped. */
function normalizeForWrite(subscribed) {
  const uniq = [...new Set(subscribed.filter((s) => typeof s === 'string'))];
  uniq.sort();
  return { schema: SCHEMA_TAG, version: SCHEMA_VERSION, subscribed: uniq };
}

// ---------------------------------------------------------------------------
// Catalog record production reuse (the slice-derivation seam)
// ---------------------------------------------------------------------------

/**
 * Ask the catalog operator to BUILD the unified catalog and return its records. We REUSE
 * catalog.mjs `run('build')` verbatim (ADR-0018 §1) — never re-scanning — so a slice's
 * count matches the catalog view exactly. Fail-open: any failure degrades to an empty
 * record list + a WARN finding (the slice list is still a valid, empty envelope).
 * @returns {Promise<{ records: any[], findings: import('./lib/findings.mjs').Finding[] }>}
 */
async function catalogRecords() {
  const findings = [];
  let records = [];
  try {
    const res = await catalogRun('build', [], {});
    records = res && res.data && Array.isArray(res.data.records) ? res.data.records : [];
  } catch (e) {
    findings.push(finding('WARN', 'slice', `catalog build failed: ${e && e.message ? e.message : String(e)} — no slices`));
    records = [];
  }
  return { records, findings };
}

/**
 * Group catalog records into slices. Only SOURCE records (carrying `source.sourceId`)
 * participate; library-local records (source === null) belong to NO slice (BR-CAT-004/006)
 * and are skipped. Records are grouped by sourceId, then by kind; each (sourceId, kind)
 * pair becomes one slice `{ id:"<sourceId>/<kind>", kind, name:kind, count, subscribed }`.
 *
 * The result is a stable, sorted `sources:[ { sourceId, slices:[...] } ]` array — sources
 * by id, slices by kind — so the JSON shape is deterministic for the bridge/UI.
 *
 * @param {any[]} records The catalog records (catalog.mjs build view).
 * @param {Set<string>} subscribedSet The project's subscribed slice ids.
 * @param {string|null} sourceFilter When set, only this source's slices are returned.
 * @returns {{ sourceId:string, slices:{ id:string, kind:string, name:string, count:number, subscribed:boolean }[] }[]}
 */
function deriveSlices(records, subscribedSet, sourceFilter) {
  /** @type {Map<string, Map<string, number>>} sourceId -> (kind -> count) */
  const bySource = new Map();
  for (const rec of records) {
    const src = rec && rec.source;
    const sourceId = src && typeof src.sourceId === 'string' ? src.sourceId : '';
    // Library-local (source === null / no sourceId) records are NOT sliced (BR-CAT-004).
    if (!sourceId) continue;
    if (sourceFilter && sourceId !== sourceFilter) continue;
    const kind = rec && typeof rec.kind === 'string' ? rec.kind : '';
    if (!kind) continue;
    let byKind = bySource.get(sourceId);
    if (!byKind) {
      byKind = new Map();
      bySource.set(sourceId, byKind);
    }
    byKind.set(kind, (byKind.get(kind) || 0) + 1);
  }

  const sources = [];
  for (const sourceId of [...bySource.keys()].sort()) {
    const byKind = bySource.get(sourceId) || new Map();
    const slices = [...byKind.keys()].sort().map((kind) => {
      const id = `${sourceId}/${kind}`;
      return {
        id,
        kind,
        name: kind,
        count: byKind.get(kind) || 0,
        subscribed: subscribedSet.has(id),
      };
    });
    sources.push({ sourceId, slices });
  }
  return sources;
}

// ---------------------------------------------------------------------------
// normalize — mirrors source.mjs#normalize (with a --source value-opt)
// ---------------------------------------------------------------------------

/**
 * Normalise `ctx`/`args` to { apply, source, positional, flags }. `--source <id>` is a
 * value-opt (the optional `list` filter); `--apply` is the write toggle. A trailing
 * non-flag positional after the verb is the slice id (subscribe/unsubscribe) — or, for
 * `list`, an optional [dir] active root (positional[0]).
 */
function normalize(args, ctx) {
  const flags = new Set();
  const positional = [];
  /** @type {Record<string,string>} */
  const opts = {};
  const argList = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  const VALUE_OPTS = new Set(['source']);
  for (let i = 0; i < argList.length; i++) {
    const a = argList[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      flags.add(name);
      if (eq >= 0) {
        opts[name] = body.slice(eq + 1);
      } else if (VALUE_OPTS.has(name) && i + 1 < argList.length && !String(argList[i + 1]).startsWith('--')) {
        opts[name] = String(argList[i + 1]);
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  if (ctx && ctx.flags instanceof Set) for (const f of ctx.flags) flags.add(f);
  const apply = flags.has('apply') || flags.has('write') || (ctx && (ctx.apply === true || ctx.write === true));
  const source = opts.source || (ctx && ctx.opts && ctx.opts.source) || null;
  return { apply: !!apply, source, positional, flags };
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr. Returns `{ ok, data, findings, summary }`.
 * Fail-open: any internal failure degrades to an ok-ish empty result, never a throw.
 *
 * `list` writes NOTHING. `subscribe`/`unsubscribe` write ONLY `.forge/subscriptions.json`
 * under the active root and ONLY under `--apply`; the default is always a preview.
 *
 * @param {string} subcmd list | subscribe | unsubscribe
 * @param {any} args string[] | { positional, flags, opts }
 * @param {any} ctx { cwd?, root?, flags?, opts?, apply?, write? }
 * @returns {Promise<{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const n = normalize(args, ctx);
    const activeRoot = resolveActiveRoot(n.positional, ctx);
    switch (subcmd) {
      case 'list':
        return await doList(activeRoot, n.source);
      case 'subscribe':
        return doSubscribe(activeRoot, n.positional[0] || null, n.apply);
      case 'unsubscribe':
        return doUnsubscribe(activeRoot, n.positional[0] || null, n.apply);
      default:
        return result(false, { usage: usageText() }, [
          finding('ERROR', 'slice', `unknown slice subcommand: ${subcmd || '(none)'}`),
        ]);
    }
  } catch (e) {
    return result(false, null, [
      finding('ERROR', 'slice', `slice error: ${e && e.message ? e.message : String(e)}`),
    ]);
  }
}

/**
 * `list [--source <id>]` — derive slices by grouping the catalog records by source + kind
 * and mark each `subscribed` from the project's subscriptions.json. Read-only, fail-open.
 * Returns `data { subscriptionsPath, sources:[ { sourceId, slices:[ { id, kind, name, count,
 * subscribed } ] } ] }` (ADR-0018 §5, BR-CAT-004).
 */
async function doList(activeRoot, sourceFilter) {
  const findings = [];
  const { subs, existed, malformed } = readSubscriptions(activeRoot);
  if (malformed) {
    findings.push(finding('WARN', relSubscriptions(activeRoot), 'subscriptions.json is not a JSON object — treating as empty'));
  } else if (!existed) {
    findings.push(finding('INFO', relSubscriptions(activeRoot), 'no subscriptions file yet — all slices default UNSUBSCRIBED (opt-in)'));
  }
  const subscribedSet = new Set(subs.subscribed);

  const { records, findings: catFindings } = await catalogRecords();
  for (const f of catFindings) findings.push(f);

  const sources = deriveSlices(records, subscribedSet, sourceFilter);
  if (sourceFilter && sources.length === 0) {
    findings.push(finding('INFO', 'slice', `no slices for source "${sourceFilter}" (unsynced, or no catalog records)`));
  }

  const totalSlices = sources.reduce((acc, s) => acc + s.slices.length, 0);
  const subscribedCount = sources.reduce(
    (acc, s) => acc + s.slices.filter((sl) => sl.subscribed).length,
    0,
  );
  if (sources.length === 0 && !sourceFilter) {
    findings.push(finding('INFO', 'slice', 'no source slices — register + sync a source, or the catalog is empty (library-local records are never sliced)'));
  }

  return result(true, {
    subscriptionsPath: subscriptionsPath(activeRoot),
    sources,
  }, findings, {
    sources: sources.length,
    slices: totalSlices,
    subscribed: subscribedCount,
  });
}

/**
 * `subscribe <sliceId> [--apply]` — add `sliceId` to the project's subscription set.
 * Idempotent: an already-subscribed id is a no-op WARN (never duplicates). Preview by
 * default (writes nothing); --apply writes subscriptions.json atomically (creating it on
 * first --apply), ADDITIVELY (preserving every other id), schema-stamped + sorted.
 */
function doSubscribe(activeRoot, sliceId, apply) {
  return mutate(activeRoot, sliceId, apply, 'subscribe');
}

/**
 * `unsubscribe <sliceId> [--apply]` — remove `sliceId` from the subscription set.
 * Idempotent: an absent id is a no-op WARN. Preview by default; --apply writes atomically,
 * ADDITIVELY (every other id preserved). The read-view stops surfacing that slice's
 * records, but they remain ADMITTABLE by uid (BR-CAT-006).
 */
function doUnsubscribe(activeRoot, sliceId, apply) {
  return mutate(activeRoot, sliceId, apply, 'unsubscribe');
}

/**
 * Shared subscribe/unsubscribe core. Validates the slice id, reads the current set,
 * computes the additive change, and (under --apply) persists it atomically. Returns a
 * plan `data { sliceId, subscriptionsPath, applied, written, action, changed,
 * subscribed:[…] }` so the preview and the apply share one shape.
 *
 * @param {string} activeRoot
 * @param {string|null} sliceId
 * @param {boolean} apply
 * @param {'subscribe'|'unsubscribe'} action
 */
function mutate(activeRoot, sliceId, apply, action) {
  const findings = [];
  if (!sliceId) {
    return result(false, { usage: usageText() }, [
      finding('ERROR', 'slice', `${action} requires a <sliceId> argument ("<sourceId>/<kind>")`),
    ]);
  }
  if (!SLICE_ID_RE.test(sliceId)) {
    return result(false, { sliceId, action, plan: { changed: false } }, [
      finding('ERROR', 'slice', `invalid slice id "${sliceId}" (must be "<sourceId>/<kind>", e.g. "acme-skills/skill")`),
    ]);
  }

  const { subs, malformed } = readSubscriptions(activeRoot);
  if (malformed) {
    return result(false, { sliceId, action, plan: { changed: false } }, [
      finding('ERROR', relSubscriptions(activeRoot), 'subscriptions.json is not a JSON object — refusing to edit'),
    ]);
  }

  const current = subs.subscribed;
  const present = current.includes(sliceId);
  /** @type {string[]} */
  let nextSubscribed = current;
  let changed = false;

  if (action === 'subscribe') {
    if (present) {
      findings.push(finding('WARN', relSubscriptions(activeRoot), `slice "${sliceId}" already subscribed — no change (idempotent)`));
    } else {
      nextSubscribed = [...current, sliceId];
      changed = true;
      findings.push(finding('INFO', 'slice', `subscribe "${sliceId}": its source records enter the catalog read-view (opt-in; admission is unchanged — ADR-0018 §4)`));
    }
  } else {
    if (!present) {
      findings.push(finding('WARN', relSubscriptions(activeRoot), `slice "${sliceId}" not subscribed — nothing to unsubscribe (idempotent)`));
    } else {
      nextSubscribed = current.filter((s) => s !== sliceId);
      changed = true;
      findings.push(finding('INFO', 'slice', `unsubscribe "${sliceId}": its source records leave the read-view (still admittable by uid — BR-CAT-006)`));
    }
  }

  let written = false;
  if (apply && changed) {
    written = writeJsonAtomic(subscriptionsPath(activeRoot), normalizeForWrite(nextSubscribed));
    if (!written) findings.push(finding('WARN', relSubscriptions(activeRoot), 'could not write subscriptions.json'));
  } else if (!apply && changed) {
    findings.push(finding('INFO', relSubscriptions(activeRoot), 'dry-run: pass --apply to write the change'));
  }

  return result(true, {
    sliceId,
    subscriptionsPath: subscriptionsPath(activeRoot),
    applied: !!apply,
    written,
    action,
    changed,
    subscribed: normalizeForWrite(nextSubscribed).subscribed,
    plan: { changed },
  }, findings, {
    [action]: changed ? 1 : 0,
    written: written ? 1 : 0,
  });
}

/**
 * C4 `summarize(state)` — pure; map a run-state to a one-panel summary. Returns a
 * `(no data)` panel when no sources array is present (fail-open).
 * @param {any} state @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  const sources = state && typeof state === 'object' && Array.isArray(state.sources) ? state.sources : null;
  if (!sources) {
    return makePanel({ panel: 'slice', ok: false, lines: ['(no data)'], hint: 'forge slice list' });
  }
  const slices = sources.reduce((acc, s) => acc + (Array.isArray(s.slices) ? s.slices.length : 0), 0);
  const subscribed = sources.reduce(
    (acc, s) => acc + (Array.isArray(s.slices) ? s.slices.filter((sl) => sl && sl.subscribed).length : 0),
    0,
  );
  return makePanel({
    panel: 'slice',
    ok: true,
    lines: [`${slices} slice${slices === 1 ? '' : 's'}`, `${subscribed} subscribed`],
  });
}

/** Build a Panel with a non-enumerable toString (mirrors source.mjs#makePanel). */
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
// run() helpers
// ---------------------------------------------------------------------------

/** Stamp a C2 finding from this module (slice pre-filled). */
function finding(level, p, message) {
  return makeFinding({ level, path: p, line: null, message, source: SOURCE });
}

/**
 * Assemble a ModuleResult `{ ok, data, findings, summary }` (the C4 contract).
 * @param {boolean} ok @param {any} data @param {import('./lib/findings.mjs').Finding[]} [findings] @param {object} [summary]
 */
function result(ok, data, findings = [], summary = undefined) {
  const list = Array.isArray(findings) ? findings : [];
  const sum = summary !== undefined ? { ...levelCounts(list), ...summary } : levelCounts(list);
  return { ok: !!ok, data: data === undefined ? null : data, findings: list, summary: sum };
}

/** Count findings by level into the uniform triple. */
function levelCounts(findings) {
  const s = { errors: 0, warnings: 0, info: 0 };
  for (const f of findings) {
    if (f && f.level === 'ERROR') s.errors++;
    else if (f && f.level === 'WARN') s.warnings++;
    else if (f && f.level === 'INFO') s.info++;
  }
  return s;
}

/** Static usage banner for an unknown subcommand. */
function usageText() {
  return [
    'forge slice list [--source <id>]',
    'forge slice subscribe <sliceId> [--apply]     (sliceId = "<sourceId>/<kind>")',
    'forge slice unsubscribe <sliceId> [--apply]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Human render (print side)
// ---------------------------------------------------------------------------

/**
 * Render a ModuleResult as human text (print side). Returns the exit code. PRINT
 * happens ONLY in the script entry; run() never writes stdout.
 * @param {string} subcmd @param {{ok:boolean,data:any,findings:any[],summary:any}} res @returns {number}
 */
function renderHuman(subcmd, res) {
  const out = [];
  const data = res.data || {};
  if (data.usage) {
    out.push(data.usage);
  } else if (subcmd === 'list') {
    const sources = Array.isArray(data.sources) ? data.sources : [];
    if (sources.length === 0) out.push('slice: no source slices (library-local records are never sliced)');
    for (const s of sources) {
      out.push(`${s.sourceId}`);
      for (const sl of s.slices) {
        out.push(`  ${sl.subscribed ? '[x]' : '[ ]'} ${sl.id}\t${sl.count} ${sl.name}${sl.count === 1 ? '' : 's'}`);
      }
    }
  } else if (subcmd === 'subscribe' || subcmd === 'unsubscribe') {
    out.push(`slice ${subcmd} ${data.sliceId || ''}: ${data.changed ? 'changed' : 'no change'}${data.applied ? `, ${data.written ? 'written' : (data.changed ? 'not written' : 'nothing to write')}` : (data.changed ? ' (preview — pass --apply)' : '')}`);
  }
  for (const f of res.findings || []) {
    const loc = f.line ? `${f.path}:${f.line}` : f.path;
    process.stderr.write(`${f.level} ${loc} ${f.message}\n`);
  }
  if (out.length) process.stdout.write(out.join('\n') + '\n');
  return res.ok ? 0 : (res.findings || []).some((f) => f.level === 'ERROR') ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Dual-mode: direct script entry
//   node manager/slices.mjs <subcmd> [flags] [sliceId]
// Renders human text, or the C3 --json envelope under --json. PRINT happens ONLY here.
// NEVER process.exit() at import time — the isMain() guard protects the node:test runner.
// ---------------------------------------------------------------------------

/** Best-effort FORGE library root = two levels up from this module (manager/..). */
function selfForgeRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

/** Read the running forge VERSION at the library root (fail-open to '0.0.0'). */
function readRunningVersion(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'VERSION'), 'utf8').trim();
    return raw || '0.0.0';
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
  // The active root is the process cwd (bin/forge.mjs runs us in the project cwd).
  run(subcmd, rest, { cwd: process.cwd() })
    .then((res) => {
      if (json) {
        const env = envelope({
          command: `slice ${subcmd || ''}`.trim(),
          ok: res.ok,
          data: res.data,
          findings: res.findings,
          summary: res.summary,
          forgeVersion: readRunningVersion(selfForgeRoot()),
        });
        writeStdoutSync(JSON.stringify(env) + '\n'); // SYNC write before exit — pipe-flush truncation (see json-out.mjs)
        process.exit(res.ok ? 0 : (res.findings || []).some((f) => f.level === 'ERROR') ? 1 : 0);
      } else {
        process.exit(renderHuman(subcmd, res));
      }
    })
    .catch(() => process.exit(1)); // fail-open: never an unhandled rejection
}

export default { run, summarize };
