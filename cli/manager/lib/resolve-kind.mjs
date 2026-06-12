/**
 * resolve-kind — the single source of truth for kind<->path resolution.
 *
 * SPEC-01 (registry) requires the registry scan and the composition validator
 * (`lint/validate-manifests.mjs`) to resolve artifacts IDENTICALLY, so this module
 * COPIES `validate-manifests.mjs`'s `componentCandidates` / `loadDeclaredHookIds`
 * logic verbatim (parameterised by `rootDir` instead of the validator's module-level
 * `ROOT`) and adds the INVERSE mapping (`pathToUid`) used when walking the library.
 *
 * It is a NEW shared module: the existing validator is intentionally NOT rewired
 * (BUILD-PLAN-v0.2 decision 3); a follow-up may re-point it here.
 *
 * Two vocabularies, kept distinct on purpose:
 *   - COMPONENT KIND (plural): the manifest/composition vocabulary — `agents`,
 *     `skills`, `commands`, `rules`, `bundles`, `workflows`, `mcp`, `validators`,
 *     `engine`, `hooks`. `componentCandidates(rootDir, kind, name)` takes this form (so it
 *     matches the manifests validator exactly).
 *   - REGISTRY KIND (singular): the catalog vocabulary — `agent`, `skill`, `command`,
 *     `rule`, `bundle`, `workflow`, `mcp`, `validator`, `meta-test`, `engine`, `hook`.
 *     `pathToUid` RETURNS this form.
 *
 * HARD INVARIANTS: zero runtime deps (node builtins / relative only); fail-open —
 * no public entry throws; on any IO/parse error a reader degrades to empty/null.
 *
 * @module manager/lib/resolve-kind
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Recursively find any file named `fileName` under `dir`. Returns matched absolute
 * paths. Copied from `validate-manifests.mjs#globMatch`: if the dir is missing or
 * nothing matched, returns the canonical top-level candidate so a caller's message
 * can name a concrete expected path. Fail-soft (unreadable dirs are skipped).
 *
 * @param {string} dir
 * @param {string} fileName
 * @returns {string[]}
 */
function globMatch(dir, fileName) {
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === fileName) out.push(full);
    }
  }
  walk(dir);
  if (out.length === 0) return [path.join(dir, fileName)];
  return out;
}

/**
 * Map a COMPONENT KIND (plural manifest vocabulary) + component name to the absolute
 * candidate path(s) it would resolve to. The component resolves if ANY candidate
 * exists. Copied verbatim from `lint/validate-manifests.mjs#componentCandidates`,
 * with `ROOT` replaced by the `rootDir` argument so the two can never disagree.
 *
 * Hooks return the sentinel `['__HOOK__']` (they live in `hooks/hooks.json`, not as
 * files); resolve them via {@link loadDeclaredHookIds} instead of `fs.existsSync`.
 *
 * @param {string} rootDir - absolute FORGE root
 * @param {string} kind - plural component kind (e.g. `agents`, `skills`, `validators`)
 * @param {string} name - component name as written in a module's `components`
 * @returns {string[]} candidate absolute paths (or `['__HOOK__']` for hooks; `[]` if unknown kind)
 */
export function componentCandidates(rootDir, kind, name) {
  const ROOT = rootDir;
  switch (kind) {
    case 'agents':
      return [path.join(ROOT, 'agents', `${name}.md`)];
    case 'skills':
      return [path.join(ROOT, 'skills', name, 'SKILL.md')];
    case 'commands':
      return [path.join(ROOT, 'commands', `${name}.md`)];
    case 'rules':
      // rules live under rules/** — match any nesting depth.
      return globMatch(path.join(ROOT, 'rules'), `${name}.md`);
    case 'bundles':
      return [path.join(ROOT, 'bundles', `${name}.md`)];
    case 'workflows':
      // a workflow's component file is its .md; the optional sibling .js is NOT a
      // separate component (only the .md resolves the component).
      return [path.join(ROOT, 'workflows', `${name}.md`)];
    case 'mcp':
      // an mcp component is a JSON config snippet: mcp/<name>.json (NOT markdown).
      return [path.join(ROOT, 'mcp', `${name}.json`)];
    case 'validators':
      return [path.join(ROOT, 'lint', `${name}.mjs`)];
    case 'engine':
      // engine names are repo-relative-ish "bootstrap/detect-project"
      return [path.join(ROOT, `${name}.mjs`)];
    case 'hooks':
      // hooks are identified by id (e.g. "detect-project@SessionStart") and live
      // in hooks/hooks.json, not as individual files. Resolution = the id's base
      // name appears as a hook in hooks/hooks.json (best-effort).
      return ['__HOOK__'];
    default:
      return [];
  }
}

/**
 * Read + parse a JSON file fail-soft. Internal mirror of the validator's helper.
 *
 * @param {string} filePath
 * @returns {{ok: true, value: any} | {ok: false}}
 */
function readJsonSoft(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Collect hook ids declared in `hooks/hooks.json`. Copied verbatim from
 * `lint/validate-manifests.mjs#loadDeclaredHookIds` (parameterised by `rootDir`).
 * Best-effort and fail-soft: a missing/unparseable file yields an empty Set.
 *
 * For each declared hook id it records three forms so callers can match loosely:
 * the id itself (`forge:detect-project`), the bare name (`detect-project`), and the
 * event-suffixed bare name (`detect-project@SessionStart`).
 *
 * @param {string} rootDir - absolute FORGE root
 * @returns {Set<string>}
 */
export function loadDeclaredHookIds(rootDir) {
  const ids = new Set();
  const hooksFile = path.join(rootDir, 'hooks', 'hooks.json');
  const r = readJsonSoft(hooksFile);
  if (!r.ok) return ids;
  const root = r.value || {};
  const eventMap = root.hooks && typeof root.hooks === 'object' ? root.hooks : root;
  for (const [eventName, groups] of Object.entries(eventMap)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (g && typeof g.id === 'string') {
        // ids look like "forge:detect-project"; record bare and namespaced forms.
        ids.add(g.id);
        const bare = g.id.includes(':') ? g.id.split(':').pop() : g.id;
        ids.add(bare);
        ids.add(`${bare}@${eventName}`);
      }
    }
  }
  return ids;
}

/**
 * Normalise an arbitrary path (absolute or relative to `rootDir`) to a POSIX-style
 * repo-relative path. Returns null if the path escapes the root. Internal helper.
 *
 * @param {string} rootDir
 * @param {string} relPath
 * @returns {string|null}
 */
function toRepoRel(rootDir, relPath) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  const abs = path.isAbsolute(relPath) ? relPath : path.resolve(rootDir, relPath);
  let r = path.relative(rootDir, abs);
  if (r === '' || r.startsWith('..')) return null;
  return r.split(path.sep).join('/');
}

/**
 * INVERSE mapping used when scanning the library: given a repo-relative (or absolute)
 * file path, return the registry `{kind, id}` it represents, or null if the path is
 * not a recognised artifact location.
 *
 * Returned `kind` is the SINGULAR registry vocabulary (SPEC-01); `id` is the bare
 * artifact id (for `engine`, the `bootstrap/<name>` form used in `modules.json` so
 * the reverse module index lines up). Mappings:
 *
 *   - `agents/<x>.md`                 → `{ kind:'agent',     id:'<x>' }`
 *   - `skills/<y>/SKILL.md`           → `{ kind:'skill',     id:'<y>' }`
 *   - `commands/<x>.md`               → `{ kind:'command',   id:'<x>' }`
 *   - rules at any depth (a rule .md)   -> { kind: 'rule', id: '<x>' }
 *   - `bundles/<x>.md`                → `{ kind:'bundle',    id:'<x>' }`
 *   - `workflows/<x>.md`              → `{ kind:'workflow',  id:'<x>' }` (sibling .js NOT a component)
 *   - `mcp/<x>.json`                  → `{ kind:'mcp',       id:'<x>' }` (JSON config, NOT markdown)
 *   - `lint/validate-*.mjs`           → `{ kind:'validator', id:'<basename-no-ext>' }`
 *   - `tests/meta/*.mjs`              → `{ kind:'meta-test', id:'<basename-no-ext>' }`
 *   - `bootstrap/*.mjs`               → `{ kind:'engine',    id:'bootstrap/<basename-no-ext>' }`
 *
 * Fail-open: never throws; any unrecognised or out-of-tree path returns null.
 *
 * @param {string} rootDir - absolute FORGE root
 * @param {string} relPath - path to an artifact file (absolute or relative to root)
 * @returns {{kind: string, id: string}|null}
 */
export function pathToUid(rootDir, relPath) {
  try {
    const rp = toRepoRel(rootDir, relPath);
    if (rp === null) return null;
    const segs = rp.split('/');
    const top = segs[0];
    const base = segs[segs.length - 1];

    switch (top) {
      case 'agents':
        // agents/<x>.md (single level under agents/)
        if (segs.length === 2 && base.endsWith('.md')) {
          return { kind: 'agent', id: base.slice(0, -3) };
        }
        return null;
      case 'skills':
        // skills/<y>/SKILL.md
        if (segs.length === 3 && base === 'SKILL.md') {
          return { kind: 'skill', id: segs[1] };
        }
        return null;
      case 'commands':
        if (segs.length === 2 && base.endsWith('.md')) {
          return { kind: 'command', id: base.slice(0, -3) };
        }
        return null;
      case 'rules':
        // rules/**/<x>.md — any nesting depth.
        if (segs.length >= 2 && base.endsWith('.md')) {
          return { kind: 'rule', id: base.slice(0, -3) };
        }
        return null;
      case 'bundles':
        if (segs.length === 2 && base.endsWith('.md')) {
          return { kind: 'bundle', id: base.slice(0, -3) };
        }
        return null;
      case 'workflows':
        // workflows/<x>.md is the component; the optional sibling workflows/<x>.js
        // (the Workflow-tool script) is NOT a separate component — only the .md maps.
        if (segs.length === 2 && base.endsWith('.md')) {
          return { kind: 'workflow', id: base.slice(0, -3) };
        }
        return null;
      case 'mcp':
        // mcp/<x>.json is the component (a MCP server config snippet; JSON, not
        // markdown). The registry kind is 'mcp' (singular === plural here).
        if (segs.length === 2 && base.endsWith('.json')) {
          return { kind: 'mcp', id: base.slice(0, -5) };
        }
        return null;
      case 'lint':
        // only validate-*.mjs are validators (run-all.mjs / README.md are not).
        if (segs.length === 2 && base.startsWith('validate-') && base.endsWith('.mjs')) {
          return { kind: 'validator', id: base.slice(0, -4) };
        }
        return null;
      case 'tests':
        // tests/meta/<x>.mjs
        if (segs.length === 3 && segs[1] === 'meta' && base.endsWith('.mjs')) {
          return { kind: 'meta-test', id: base.slice(0, -4) };
        }
        return null;
      case 'bootstrap':
        // bootstrap/<x>.mjs (top level only; templates/ etc. are not engine scripts).
        if (segs.length === 2 && base.endsWith('.mjs')) {
          return { kind: 'engine', id: `bootstrap/${base.slice(0, -4)}` };
        }
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export default { componentCandidates, loadDeclaredHookIds, pathToUid };
