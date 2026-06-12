// @ts-check
/**
 * mcp — the manager's MCP-server enablement operator.
 *
 * The forge library ships a small CATALOG of available Model Context Protocol
 * servers under `FORGE_ROOT/mcp/*.json` (the `mcp` registry KIND). Each catalog
 * component file holds a `{ "mcpServers": { "<name>": {...} } }` block — the exact
 * shape Claude Code reads from a project's `.claude/settings.json` under
 * `mcpServers`. This module ENABLES / DISABLES those catalog servers in a TARGET
 * project's `.claude/settings.json`, additively and non-destructively.
 *
 * The two roots, kept STRICTLY separate (mirrors bin/forge.mjs + memory.mjs):
 *   - FORGE_ROOT  — this library's install location (two levels up from this
 *                   module). The catalog `mcp/*.json` files are READ from here.
 *   - PROJECT_DIR — the target project (ctx.cwd, or a `[dir]` positional). The
 *                   only place this module ever WRITES: `<project>/.claude/
 *                   settings.json`.
 *
 * DECISIONS (locked):
 *   - Explicit enable/disable — NOT auto-on-init. Enabling an MCP server is an
 *     opt-in verb; `forge init` never wires one up.
 *   - Conflict = SKIP + WARN — `enable` NEVER clobbers an existing
 *     `mcpServers.<name>` already present in the project settings; it is skipped
 *     with a WARN finding (additive-never-destructive).
 *   - Preview by default — `enable`/`disable` write NOTHING unless `--apply`. The
 *     default run returns a plan; `--apply` persists it (atomic).
 *
 * The settings.json contract (bootstrap/templates/settings.json.tmpl):
 *   "Merged additively with any existing settings.json — never replaces it." This
 *   module honours that: a write PRESERVES every other settings key verbatim,
 *   touching ONLY the `mcpServers` object. There is no generic deep-merge in
 *   forge; the merge here is a SMALL additive one at the `mcpServers` object level
 *   (per-key add/skip/remove), inline below.
 *
 * HARD INVARIANTS (the plugin payload contract): zero runtime deps (node:
 * builtins + relative imports only); additive-never-destructive (`enable` never
 * overwrites an existing server key; a write preserves all other settings keys);
 * writers PREVIEW by default (`enable`/`disable` write only under `--apply`);
 * fail-open (no public entry throws past its surface — it degrades to a safe
 * `{ok,data,findings,summary}` envelope). Dual-mode with an `isMain()` guard —
 * NEVER process.exit() at import time.
 *
 * Subcommands (C4 `run(subcmd, args, ctx)`):
 *   - `list`                   — enumerate the library catalog → data.servers[]
 *                                each `{ name, enabled }` (enabled = is it in the
 *                                project's settings.json mcpServers?).
 *   - `enable <name> [--apply]`  — stage the catalog component's server entries
 *                                into the project settings (skip+WARN any key that
 *                                already exists). Preview by default; --apply writes.
 *   - `disable <name> [--apply]` — remove the catalog component's declared server
 *                                keys from the project settings. Preview by default;
 *                                --apply writes. Absent key ⇒ WARN (nothing to do).
 *
 * @module manager/mcp
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import { readJson, writeJsonAtomic } from './lib/store.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The emitter stamped on findings this module raises (C2 `source`). */
const SOURCE = 'mcp';

// ---------------------------------------------------------------------------
// Root + path resolution
// ---------------------------------------------------------------------------

/** Best-effort FORGE library root = two levels up from this module (manager/..). */
function selfForgeRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

/** The library MCP catalog dir under FORGE_ROOT. */
function catalogDir() {
  return path.join(selfForgeRoot(), 'mcp');
}

/** The TARGET project's settings.json path (the only file this module writes). */
function settingsPath(rootDir) {
  return path.join(rootDir, '.claude', 'settings.json');
}

// ---------------------------------------------------------------------------
// Catalog reads (FORGE_ROOT/mcp/*.json) — fail-open
// ---------------------------------------------------------------------------

/**
 * Enumerate the catalog component NAMES (basenames of `mcp/*.json`, sans `.json`),
 * sorted for determinism. Fail-open: an unreadable catalog dir yields [].
 * @returns {string[]}
 */
function listCatalogNames() {
  let entries;
  try {
    entries = fs.readdirSync(catalogDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.json')) out.push(e.name.slice(0, -'.json'.length));
  }
  return out.sort();
}

/**
 * Read one catalog component file (`mcp/<name>.json`). Returns its parsed object,
 * or null when the file is missing/unreadable/malformed (fail-open).
 * @param {string} name @returns {any|null}
 */
function readCatalogComponent(name) {
  return readJson(path.join(catalogDir(), `${name}.json`));
}

/**
 * Extract the `mcpServers` object from a parsed catalog component (or settings),
 * tolerating absence/wrong-type. Returns a fresh plain object (never the input).
 * @param {any} doc @returns {Record<string, any>}
 */
function mcpServersOf(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
  const s = doc.mcpServers;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  return { ...s };
}

// ---------------------------------------------------------------------------
// Project settings reads
// ---------------------------------------------------------------------------

/**
 * Read the project's `.claude/settings.json` as an object. An ABSENT file is
 * treated as `{}` (the additive contract: we may create it). A present-but-
 * malformed/non-object file degrades to `null` so the caller can refuse to edit.
 * @param {string} rootDir @returns {{ settings: any, existed: boolean, malformed: boolean }}
 */
function readProjectSettings(rootDir) {
  const abs = settingsPath(rootDir);
  let existed = false;
  try {
    existed = fs.statSync(abs).isFile();
  } catch {
    existed = false;
  }
  if (!existed) return { settings: {}, existed: false, malformed: false };
  const parsed = readJson(abs);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { settings: null, existed: true, malformed: true };
  }
  return { settings: parsed, existed: true, malformed: false };
}

/** The set of server names CURRENTLY enabled in the project settings. */
function enabledServerNames(rootDir) {
  const { settings } = readProjectSettings(rootDir);
  return new Set(Object.keys(mcpServersOf(settings)));
}

// ---------------------------------------------------------------------------
// normalize — mirrors memory.mjs#normalize
// ---------------------------------------------------------------------------

/**
 * Normalise `ctx`/`args` to { baseDir, apply, positional, flags }. The PROJECT dir
 * is NOT baked in here because its positional slot is sub-command-specific (mirrors
 * memory.mjs, where `import`'s first positional is a srcDir, not the project): for
 * `list` the first positional is the [dir]; for `enable`/`disable` it is the <name>
 * and a TRAILING positional may name the [dir]. `run` resolves the project dir per
 * sub-command via {@link resolveDir}. `baseDir` is the caller cwd (the bin runs us
 * in the project cwd, so cwd is the default).
 */
function normalize(args, ctx) {
  const flags = new Set();
  const positional = [];
  const argList = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  for (const a of argList) {
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      flags.add(a.slice(2).split('=')[0]);
    } else {
      positional.push(a);
    }
  }
  if (ctx && ctx.flags instanceof Set) for (const f of ctx.flags) flags.add(f);

  const baseDir = (ctx && (ctx.cwd || ctx.root)) || process.cwd();
  const apply = flags.has('apply') || flags.has('write') || (ctx && (ctx.apply === true || ctx.write === true));
  return { baseDir, apply: !!apply, positional, flags };
}

/**
 * Resolve a project dir from an optional `[dir]` positional, relative to `baseDir`.
 * Absent ⇒ `baseDir` itself (the caller cwd). Mirrors how fleet/memory resolve a
 * project root.
 * @param {string} baseDir @param {string|null|undefined} dirArg @returns {string}
 */
function resolveDir(baseDir, dirArg) {
  if (!dirArg) return baseDir;
  return path.isAbsolute(dirArg) ? dirArg : path.resolve(baseDir, dirArg);
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr. Returns `{ ok, data, findings, summary }`.
 * Fail-open: any internal failure degrades to an ok-ish empty result, never a throw.
 *
 * `list` writes NOTHING. `enable`/`disable` write ONLY `<project>/.claude/
 * settings.json` and ONLY under `--apply`; the default is always a preview.
 *
 * @param {string} subcmd list | enable | disable
 * @param {any} args string[] | { positional, flags }
 * @param {any} ctx { cwd?, root?, flags?, apply?, write? }
 * @returns {Promise<{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const n = normalize(args, ctx);
    switch (subcmd) {
      case 'list':
        // `list [dir]` — the first positional is the optional project dir.
        return doList(resolveDir(n.baseDir, n.positional[0]));
      case 'enable':
        // `enable <name> [dir]` — first positional is the name, second the dir.
        return doEnable(resolveDir(n.baseDir, n.positional[1]), n.positional[0] || null, n.apply);
      case 'disable':
        // `disable <name> [dir]` — first positional is the name, second the dir.
        return doDisable(resolveDir(n.baseDir, n.positional[1]), n.positional[0] || null, n.apply);
      default:
        return result(false, { usage: usageText() }, [
          finding('ERROR', 'mcp', `unknown mcp subcommand: ${subcmd || '(none)'}`),
        ]);
    }
  } catch (e) {
    return result(false, null, [
      finding('ERROR', 'mcp', `mcp error: ${e && e.message ? e.message : String(e)}`),
    ]);
  }
}

/**
 * `list` — enumerate the library catalog → data.servers[] each `{ name, enabled }`
 * where `enabled` = the catalog component appears in the project settings.json
 * mcpServers. A component counts as enabled when ALL of its declared server keys
 * are present in the project settings (an all-or-nothing view of the component).
 * Read-only, fail-open.
 */
function doList(rootDir) {
  const names = listCatalogNames();
  const present = enabledServerNames(rootDir);
  const servers = names.map((name) => {
    const declared = Object.keys(mcpServersOf(readCatalogComponent(name)));
    const enabled = declared.length > 0 && declared.every((k) => present.has(k));
    return { name, enabled, servers: declared };
  });
  const findings = [];
  if (names.length === 0) {
    findings.push(finding('INFO', 'mcp', `no MCP catalog components found under ${path.relative(rootDir, catalogDir()) || catalogDir()}`));
  }
  return result(true, { rootDir, catalog: catalogDir(), servers }, findings, {
    servers: servers.length,
    enabled: servers.filter((s) => s.enabled).length,
  });
}

/**
 * `enable <name> [--apply]` — stage the catalog component's server entries into the
 * project settings, additively. For each server key the component declares: if it
 * ALREADY exists in `settings.mcpServers` → SKIP + WARN (never clobber); else stage
 * it for add. Default returns the plan in `data.plan { add, skipped }`; --apply
 * writes settings.json atomically (creating the file + the mcpServers object when
 * absent, preserving all other settings keys verbatim).
 */
function doEnable(rootDir, name, apply) {
  const findings = [];
  if (!name) {
    return result(false, { usage: usageText() }, [finding('ERROR', 'mcp', 'enable requires a <name> argument')]);
  }
  const component = readCatalogComponent(name);
  if (component === null) {
    // 404-style: the named catalog component does not exist (or is unreadable).
    return result(false, { name, plan: { add: [], skipped: [] } }, [
      finding('ERROR', `mcp/${name}.json`, `no such MCP catalog component: ${name}`),
    ]);
  }
  const incoming = mcpServersOf(component);
  const incomingKeys = Object.keys(incoming);
  if (incomingKeys.length === 0) {
    findings.push(finding('WARN', `mcp/${name}.json`, `component declares no mcpServers entries — nothing to enable`));
  }

  const { settings, malformed } = readProjectSettings(rootDir);
  if (malformed) {
    return result(false, { name, plan: { add: [], skipped: [] } }, [
      finding('ERROR', relSettings(rootDir), 'settings.json is not a JSON object — refusing to edit'),
    ]);
  }
  const existing = mcpServersOf(settings); // current project mcpServers (a copy)

  // SMALL additive merge at the mcpServers object level (no deep-merge dep).
  const add = [];
  const skipped = [];
  for (const key of incomingKeys) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      skipped.push({ server: key, reason: 'already present in settings.mcpServers (additive: never clobber)' });
      findings.push(finding('WARN', relSettings(rootDir), `mcpServers["${key}"] already present — skipped (never clobber)`));
    } else {
      add.push({ server: key, config: incoming[key] });
    }
  }

  let written = false;
  if (apply && add.length > 0) {
    // Build the next settings object: preserve ALL existing keys verbatim, mutate
    // ONLY the mcpServers sub-object (create it when absent).
    const base = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    const next = { ...base };
    const nextServers = { ...mcpServersOf(base) };
    for (const a of add) nextServers[a.server] = a.config;
    next.mcpServers = nextServers;
    written = writeJsonAtomic(settingsPath(rootDir), next);
    if (!written) findings.push(finding('WARN', relSettings(rootDir), 'could not write settings.json'));
  }

  return result(true, {
    name,
    settingsPath: settingsPath(rootDir),
    applied: !!apply,
    written,
    plan: { add: add.map((a) => a.server), skipped },
  }, findings, {
    add: add.length,
    skipped: skipped.length,
    written: written ? add.length : 0,
  });
}

/**
 * `disable <name> [--apply]` — remove the catalog component's DECLARED server keys
 * from the project settings.json mcpServers (only the keys this component declares).
 * If a declared key is absent → WARN (nothing to do for it). Default returns the
 * plan in `data.plan { remove, missing }`; --apply writes settings.json atomically,
 * preserving all other settings keys verbatim.
 */
function doDisable(rootDir, name, apply) {
  const findings = [];
  if (!name) {
    return result(false, { usage: usageText() }, [finding('ERROR', 'mcp', 'disable requires a <name> argument')]);
  }
  const component = readCatalogComponent(name);
  if (component === null) {
    return result(false, { name, plan: { remove: [], missing: [] } }, [
      finding('ERROR', `mcp/${name}.json`, `no such MCP catalog component: ${name}`),
    ]);
  }
  const declaredKeys = Object.keys(mcpServersOf(component));

  const { settings, existed, malformed } = readProjectSettings(rootDir);
  if (malformed) {
    return result(false, { name, plan: { remove: [], missing: [] } }, [
      finding('ERROR', relSettings(rootDir), 'settings.json is not a JSON object — refusing to edit'),
    ]);
  }
  const existing = mcpServersOf(settings);

  const remove = [];
  const missing = [];
  for (const key of declaredKeys) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      remove.push(key);
    } else {
      missing.push(key);
      findings.push(finding('WARN', relSettings(rootDir), `mcpServers["${key}"] not present — nothing to disable`));
    }
  }
  if (declaredKeys.length === 0) {
    findings.push(finding('WARN', `mcp/${name}.json`, `component declares no mcpServers entries — nothing to disable`));
  }
  if (!existed && remove.length === 0) {
    findings.push(finding('INFO', relSettings(rootDir), 'no settings.json — nothing to disable'));
  }

  let written = false;
  if (apply && remove.length > 0) {
    const base = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    const next = { ...base };
    const nextServers = { ...mcpServersOf(base) };
    for (const key of remove) delete nextServers[key];
    // Drop an emptied mcpServers object so the additive write leaves no empty husk.
    if (Object.keys(nextServers).length === 0) delete next.mcpServers;
    else next.mcpServers = nextServers;
    written = writeJsonAtomic(settingsPath(rootDir), next);
    if (!written) findings.push(finding('WARN', relSettings(rootDir), 'could not write settings.json'));
  }

  return result(true, {
    name,
    settingsPath: settingsPath(rootDir),
    applied: !!apply,
    written,
    plan: { remove, missing },
  }, findings, {
    remove: remove.length,
    missing: missing.length,
    written: written ? remove.length : 0,
  });
}

/**
 * C4 `summarize(state)` — pure; map a run-state to a one-panel summary. Returns a
 * `(no data)` panel when no catalog/servers are present (fail-open).
 * @param {any} state @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  const servers = state && typeof state === 'object' && Array.isArray(state.servers) ? state.servers : null;
  if (!servers) {
    return makePanel({ panel: 'mcp', ok: false, lines: ['(no data)'], hint: 'forge mcp list' });
  }
  const enabled = servers.filter((s) => s && s.enabled).length;
  return makePanel({
    panel: 'mcp',
    ok: true,
    lines: [`${servers.length} server${servers.length === 1 ? '' : 's'}`, `${enabled} enabled`],
  });
}

/** Build a Panel with a non-enumerable toString (mirrors memory.mjs#makePanel). */
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

/** Project-relative `.claude/settings.json` for finding paths (fail-open). */
function relSettings(rootDir) {
  try {
    return path.relative(rootDir, settingsPath(rootDir)) || settingsPath(rootDir);
  } catch {
    return '.claude/settings.json';
  }
}

/** Stamp a C2 finding from this module (source pre-filled). */
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
    'forge mcp list',
    'forge mcp enable <name> [--apply]',
    'forge mcp disable <name> [--apply]',
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
    // A usage-only result (unknown sub-verb / missing <name>) — show the banner.
    out.push(data.usage);
  } else if (subcmd === 'list') {
    const servers = Array.isArray(data.servers) ? data.servers : [];
    if (servers.length === 0) out.push('mcp: no catalog components');
    for (const s of servers) {
      out.push(`${s.enabled ? '[on] ' : '[off]'} ${s.name}\t${(s.servers || []).join(', ')}`);
    }
  } else if (subcmd === 'enable') {
    const plan = data.plan || { add: [], skipped: [] };
    out.push(`mcp enable ${data.name}: ${plan.add.length} to add, ${plan.skipped.length} skipped${data.applied ? `, ${data.written ? 'written' : 'not written'}` : ' (preview — pass --apply)'}`);
    for (const a of plan.add) out.push(`  + ${a}`);
    for (const s of plan.skipped) out.push(`  - ${s.server}\t(skip: ${s.reason})`);
  } else if (subcmd === 'disable') {
    const plan = data.plan || { remove: [], missing: [] };
    out.push(`mcp disable ${data.name}: ${plan.remove.length} to remove, ${plan.missing.length} missing${data.applied ? `, ${data.written ? 'written' : 'not written'}` : ' (preview — pass --apply)'}`);
    for (const r of plan.remove) out.push(`  - ${r}`);
    for (const m of plan.missing) out.push(`  ? ${m}\t(not present)`);
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
//   node manager/mcp.mjs <subcmd> [flags] [name] [dir]
// Renders human text, or the C3 --json envelope under --json. PRINT happens ONLY
// here. NEVER process.exit() at import time — the isMain() guard protects the
// node:test runner.
// ---------------------------------------------------------------------------

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
  run(subcmd, rest, {})
    .then((res) => {
      if (json) {
        const env = envelope({
          command: `mcp ${subcmd || ''}`.trim(),
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
