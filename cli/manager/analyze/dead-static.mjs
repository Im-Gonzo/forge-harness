// @ts-check
/**
 * dead-static — static dead/unused detection D1–D5 (SPEC-06 §"Static dead-detection",
 * BR-EFF-004). No telemetry needed; D5 needs a `--project` tree.
 *
 *   D1 orphan module    — a module in ZERO profiles and not `always:true`.
 *   D2 orphan component — a component named in NO module.
 *   D3 orphan file      — a file on disk that no module references.
 *   D4 dangling ref     — a module names a component with no backing file. CROSS-
 *                         REFERENCED to the dependency graph (SPEC-03 / BR-DEP); the
 *                         evidence cites the dangling-ref resolution, not re-derived prose.
 *   D5 vacuous rule     — a path-scoped rule whose `paths:` globs match 0 files in `--project`.
 *
 * Each finding is `{ checkId, uid, evidence, recommend }`. The criticality safety-lock
 * is applied by the CALLER (efficiency.mjs) — this module reports the raw structural
 * facts; the lock filters safety/compliance uids out of every dead surface before any
 * plan is built (ADR-0013).
 *
 * HARD INVARIANTS: zero runtime deps (node builtins + relative imports); fail-open —
 * any unreadable manifest/dir degrades to fewer findings, never throws.
 *
 * @module manager/analyze/dead-static
 */

import fs from 'node:fs';
import path from 'node:path';

import { componentCandidates, loadDeclaredHookIds, pathToUid } from '../lib/resolve-kind.mjs';
import { extractPathGlobs } from './residency.mjs';

/**
 * @typedef {Object} DeadFinding
 * @property {string} checkId D1|D2|D3|D4|D5
 * @property {string} uid the artifact (or module) uid the finding concerns
 * @property {string} evidence human-readable reason
 * @property {boolean} recommend whether this is safe to recommend (static = true)
 * @property {string} [source] the resolution source (e.g. dep-graph for D4)
 */

/**
 * Run D1–D4 from the manifests + disk (no telemetry, no `--project`). D5 is run
 * separately by {@link detectD5} when a project tree is supplied.
 *
 * @param {Object} ctx
 * @param {string} ctx.rootDir absolute harness root
 * @param {any} ctx.modulesDoc parsed modules.json (or null)
 * @param {any} ctx.profilesDoc parsed profiles.json (or null)
 * @param {Array<{uid:string,kind:string,id:string,path:string,status:string}>} ctx.artifacts on-disk artifact records
 * @param {string[]} [ctx.danglingRefs] dangling component refs from the dep graph (SPEC-03), if available
 * @returns {DeadFinding[]}
 */
export function detectStatic({ rootDir, modulesDoc, profilesDoc, artifacts, danglingRefs }) {
  /** @type {DeadFinding[]} */
  const out = [];
  const modules = modulesDoc && typeof modulesDoc.modules === 'object' ? modulesDoc.modules : {};

  // Which modules are referenced by at least one profile (or always:true)?
  const referencedModules = profileReferencedModules(profilesDoc);

  // uid → set of modules that name it; plus the set of dangling (kind,name) refs.
  const { uidToModules, danglingPairs } = buildComponentIndex(rootDir, modules);

  // --- D1 orphan module: in zero profiles and not always:true. ---
  for (const [moduleName, mDef] of Object.entries(modules)) {
    const always = mDef && mDef.always === true;
    if (always) continue;
    if (!referencedModules.has(moduleName)) {
      out.push({
        checkId: 'D1',
        uid: `module:${moduleName}`,
        evidence: `module "${moduleName}" is referenced by 0 profiles and is not always:true`,
        recommend: true,
      });
    }
  }

  // --- D2 orphan component: an on-disk artifact named in NO module. ---
  for (const a of artifacts) {
    if (!a || typeof a.uid !== 'string') continue;
    if (a.status === 'planned') continue;
    if (!isComponentKind(a.kind)) continue; // only composable kinds can be "in a module"
    if (!uidToModules.has(a.uid)) {
      out.push({
        checkId: 'D2',
        uid: a.uid,
        evidence: `${a.uid} (${a.path}) is listed in no module`,
        recommend: true,
      });
    }
  }

  // --- D3 orphan file: a file on disk that no module references. ---
  // D3 is the FILE view of D2; report it for content files (rules/agents/skills/
  // commands/bundles) that no module names. We tag it D3 to distinguish the "file on
  // disk" framing (BR-EFF-004) from the component framing. Each orphan content file is
  // reported once under D3 (in addition to its D2 component finding) so both check-ids
  // appear, matching the spec's separate D2/D3 rows.
  for (const a of artifacts) {
    if (!a || typeof a.uid !== 'string') continue;
    if (a.status === 'planned') continue;
    if (!isContentKind(a.kind)) continue;
    if (!uidToModules.has(a.uid)) {
      out.push({
        checkId: 'D3',
        uid: a.uid,
        evidence: `file on disk ${a.path} is referenced by no module`,
        recommend: true,
      });
    }
  }

  // --- D4 dangling ref: a module names a component with no backing file. ---
  // Prefer the dependency-graph's resolution (SPEC-03 / BR-DEP) when it is available;
  // fall back to the structural pairs we computed. Either way the evidence CITES the
  // dangling-ref / dep-graph resolution rather than re-deriving it in prose.
  const dangling = collectDangling(danglingRefs, danglingPairs);
  for (const d of dangling) {
    out.push({
      checkId: 'D4',
      uid: d.uid,
      evidence: `dangling ref: ${d.rawRef} named by module(s) ${d.modules.join(', ') || '(unknown)'} resolves to no backing file (dependency-graph / dangling-ref resolution, SPEC-03 / BR-DEP)`,
      recommend: true,
      source: 'dep-graph',
    });
  }

  return out;
}

/**
 * D5 vacuous path-scoped rule: a rule whose `paths:` globs match ZERO files in the
 * given project tree. Requires `--project`. Returns one finding per vacuous rule.
 *
 * @param {Object} ctx
 * @param {string} ctx.projectDir absolute project tree to scan
 * @param {Array<{uid:string,kind:string,absText:string,path:string}>} ctx.rules path-scoped rule records (uid + raw text)
 * @returns {DeadFinding[]}
 */
export function detectD5({ projectDir, rules }) {
  /** @type {DeadFinding[]} */
  const out = [];
  let files = [];
  try {
    files = listProjectFiles(projectDir);
  } catch {
    files = [];
  }
  for (const r of rules) {
    if (!r || typeof r.uid !== 'string') continue;
    const globs = extractPathGlobs(typeof r.absText === 'string' ? r.absText : '');
    if (globs.length === 0) continue; // not path-scoped → not a D5 candidate
    const matched = files.some((rel) => globs.some((g) => globMatch(g, rel)));
    if (!matched) {
      out.push({
        checkId: 'D5',
        uid: r.uid,
        evidence: `paths ${JSON.stringify(globs)} matched 0 files in ${shortName(projectDir)}`,
        recommend: true,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The set of modules referenced by any profile, plus none-implicit always handling. */
function profileReferencedModules(profilesDoc) {
  const set = new Set();
  const profiles = profilesDoc && typeof profilesDoc.profiles === 'object' ? profilesDoc.profiles : {};
  for (const def of Object.values(profiles)) {
    const mods = def && Array.isArray(def.modules) ? def.modules : [];
    for (const m of mods) if (typeof m === 'string') set.add(m);
  }
  // moduleSelectionRules.add modules are reachable too (a fact can pull them in).
  const rules = profilesDoc && profilesDoc.moduleSelectionRules;
  const add = rules && Array.isArray(rules.add) ? rules.add : [];
  for (const r of add) if (r && typeof r.module === 'string') set.add(r.module);
  return set;
}

/**
 * Build `uid → Set<module>` for every component a module names that HAS a backing
 * file, and the list of dangling (kind, name) refs whose candidates do not exist.
 * Mirrors registry.mjs#buildModuleIndex / componentUid resolution so the two agree.
 *
 * @param {string} rootDir
 * @param {Object} modules the modules.json `modules` map
 * @returns {{uidToModules:Map<string,Set<string>>, danglingPairs:Array<{kind:string,name:string,module:string}>}}
 */
function buildComponentIndex(rootDir, modules) {
  /** @type {Map<string,Set<string>>} */
  const uidToModules = new Map();
  /** @type {Array<{kind:string,name:string,module:string}>} */
  const danglingPairs = [];
  let hookIds;
  try {
    hookIds = loadDeclaredHookIds(rootDir);
  } catch {
    hookIds = new Set();
  }
  for (const [moduleName, mDef] of Object.entries(modules)) {
    const comps = mDef && typeof mDef.components === 'object' ? mDef.components : {};
    for (const [kind, names] of Object.entries(comps)) {
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        const resolved = resolveComponent(rootDir, kind, String(name), hookIds);
        if (resolved && resolved.exists) {
          let set = uidToModules.get(resolved.uid);
          if (!set) {
            set = new Set();
            uidToModules.set(resolved.uid, set);
          }
          set.add(moduleName);
        } else {
          danglingPairs.push({ kind, name: String(name), module: moduleName });
        }
      }
    }
  }
  return { uidToModules, danglingPairs };
}

/**
 * Resolve a manifest (kind, name) to its uid and whether a backing file exists.
 * @param {string} rootDir
 * @param {string} kind plural component kind
 * @param {string} name
 * @param {Set<string>} hookIds
 * @returns {{uid:string, exists:boolean}|null}
 */
function resolveComponent(rootDir, kind, name, hookIds) {
  if (kind === 'hooks') {
    const base = name.split('@')[0];
    const exists =
      hookIds.has(name) || hookIds.has(base) || hookIds.has(`forge:${base}`) || hookIds.has(`${base}@`);
    const namespaced = hookIds.has(`forge:${base}`) ? `forge:${base}` : base;
    return { uid: `hook:${namespaced}`, exists: !!exists };
  }
  let candidates = [];
  try {
    candidates = componentCandidates(rootDir, kind, name);
  } catch {
    candidates = [];
  }
  let uid = null;
  let exists = false;
  for (const cand of candidates) {
    if (cand === '__HOOK__') continue;
    const cls = pathToUid(rootDir, cand);
    if (cls && !uid) uid = `${cls.kind}:${cls.id}`;
    try {
      if (fs.existsSync(cand)) {
        exists = true;
        if (cls) uid = `${cls.kind}:${cls.id}`;
        break;
      }
    } catch {
      /* fail-open */
    }
  }
  if (!uid) {
    // Best-effort uid from the kind/name when no candidate path classifies (planned).
    uid = `${singularKind(kind)}:${name}`;
  }
  return { uid, exists };
}

/**
 * Merge the dep-graph's dangling refs (preferred) with the structurally-derived
 * dangling pairs into a uniform `{uid, rawRef, modules}` list, de-duped by uid.
 *
 * @param {string[]|undefined} danglingRefs dep-graph dangling refs (uids or raw names)
 * @param {Array<{kind:string,name:string,module:string}>} pairs structural fallback
 * @returns {Array<{uid:string, rawRef:string, modules:string[]}>}
 */
function collectDangling(danglingRefs, pairs) {
  /** @type {Map<string,{uid:string, rawRef:string, modules:Set<string>}>} */
  const byUid = new Map();
  // Structural pairs first (they carry the module attribution).
  for (const p of pairs) {
    const uid = `${singularKind(p.kind)}:${p.name}`;
    let e = byUid.get(uid);
    if (!e) {
      e = { uid, rawRef: p.name, modules: new Set() };
      byUid.set(uid, e);
    }
    e.modules.add(p.module);
  }
  // Dep-graph refs (if the registry populated danglingRefs) reinforce / add entries.
  if (Array.isArray(danglingRefs)) {
    for (const d of danglingRefs) {
      if (!d) continue;
      // A dep-graph entry may be a string uid/name or an object {uid?, rawRef?}.
      const raw = typeof d === 'string' ? d : d.rawRef || d.uid || d.name || '';
      if (!raw) continue;
      const uid = typeof d === 'object' && d.uid ? d.uid : guessUid(String(raw));
      if (!byUid.has(uid)) byUid.set(uid, { uid, rawRef: String(raw), modules: new Set() });
    }
  }
  return [...byUid.values()].map((e) => ({ uid: e.uid, rawRef: e.rawRef, modules: [...e.modules].sort() }));
}

/** Guess a uid from a bare ref name when no kind is known (best-effort). */
function guessUid(raw) {
  return raw.includes(':') ? raw : `component:${raw}`;
}

/** Map a plural component kind to the singular registry kind. */
function singularKind(kind) {
  const map = {
    agents: 'agent',
    skills: 'skill',
    commands: 'command',
    rules: 'rule',
    bundles: 'bundle',
    hooks: 'hook',
    validators: 'validator',
    engine: 'engine',
  };
  return map[kind] || kind;
}

/** Composable kinds that can be "in a module". */
function isComponentKind(kind) {
  return ['agent', 'skill', 'command', 'rule', 'bundle', 'validator', 'engine', 'hook'].includes(kind);
}

/** Content kinds that exist as files on disk (the D3 surface). */
function isContentKind(kind) {
  return ['agent', 'skill', 'command', 'rule', 'bundle'].includes(kind);
}

/**
 * Recursively list project files relative to `projectDir` (POSIX rel paths), pruning
 * common noise dirs. Fail-open.
 * @param {string} projectDir
 * @returns {string[]}
 */
function listProjectFiles(projectDir) {
  const SKIP = new Set(['node_modules', '.git', '.forge', '.claude', 'dist', 'build', '.next']);
  const out = [];
  const root = path.resolve(projectDir);
  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  walk(root);
  return out;
}

/**
 * Minimal glob matcher for the `paths:` dialect forge uses (`**`, `*`, plain). Matches
 * a POSIX relative path against a single glob. Conservative and dependency-free.
 *
 * @param {string} glob e.g. `**\/*.tsx`, `src/**`, `*.md`
 * @param {string} rel POSIX relative path
 * @returns {boolean}
 */
export function globMatch(glob, rel) {
  if (typeof glob !== 'string' || typeof rel !== 'string') return false;
  const re = globToRegExp(glob);
  return re.test(rel);
}

/** Compile a glob to a RegExp (supports `**`, `*`, `?`). */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` — match across path separators; consume an optional following `/`.
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else if (c === '/') {
      out += '/';
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

/** Short display name for a project dir (basename). */
function shortName(dir) {
  try {
    return path.basename(dir);
  } catch {
    return String(dir);
  }
}

export default { detectStatic, detectD5, globMatch };
