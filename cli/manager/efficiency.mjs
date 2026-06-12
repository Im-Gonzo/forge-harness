// @ts-check
/**
 * efficiency — the manager's Efficiency & Optimization dimension (SPEC-06, BR-EFF-*,
 * ADR-0013). This is the brief's "STATIC CONTEXT-BUDGET" module: the v0.3 static half.
 *
 * `forge analyze [projectDir] [--project <dir>]` is a READ-ONLY report (BR-EFF-001,
 * BR-CLI-010): a zero-dependency token-budget estimate by residency class, an always-on
 * TOTAL + per-artifact + per-profile budget, and static dead-detection D1–D5. It NEVER
 * writes (analyze rejects `--apply`). The criticality safety-lock (ADR-0013) sits above
 * every dead/prune surface: a `safety`/`compliance` artifact can never be classified
 * dead and a 0-fire `secret-scan` is reported as a SUCCESS indicator, not waste — the
 * lock filters safety uids OUT of every dead/waste/prune surface at the data layer.
 *
 * The dynamic half (U1–U4, redundancy, value-density, the full `optimize` planner) is
 * v0.6 (DEFERRED). v0.3 ships only the thin slice the lock + adequacy gate need: a
 * never-fired `normal` artifact verdict (`watch` in a thin window, `prune` in an
 * adequate one), and an `optimize --emit-plan` that excludes every safety artifact.
 *
 * C4 module contract: `run(subcmd, args, ctx)` + `summarize(state)`. `run` NEVER writes
 * stdout — it returns `{ ok, data, findings, summary }`; the dual-mode script entry (or
 * the dispatcher) renders. Fail-open: any internal failure degrades to a partial report,
 * never throws past `run()` and never blocks (advisory-only, ADR-0007).
 *
 * CRITICAL (the v0.2 defect this module must not re-introduce): direct execution is
 * guarded behind `isMain()` and this module NEVER calls `process.exit()` at import time
 * — doing so would silently kill the node:test runner.
 *
 * HARD INVARIANTS: zero runtime deps (node builtins + relative imports); additive-never-
 * destructive; fail-open; read-only.
 *
 * @module manager/efficiency
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRegistry } from './registry.mjs';
import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import { readJson, forgeStateDir } from './lib/store.mjs';
import { loadDeclaredHookIds } from './lib/resolve-kind.mjs';
import { estimate } from './analyze/estimate.mjs';
import { classify } from './analyze/residency.mjs';
import { detectStatic, detectD5 } from './analyze/dead-static.mjs';
import {
  CHARS_PER_TOKEN,
  CODE_DENSITY,
  MIN_SESSIONS,
  MIN_DAYS,
} from './analyze/constants.mjs';

const SOURCE = 'analyze';

// ---------------------------------------------------------------------------
// Criticality (the seeded safety allowlist, ADR-0013)
// ---------------------------------------------------------------------------

/** The five seed-tagged safety controls (BR-EFF-006), as a hard fallback. */
const SEED_SAFETY_UIDS = new Set([
  'hook:forge:secret-scan',
  'hook:forge:block-no-verify',
  'hook:forge:config-protection',
  'rule:prompt-defense-baseline',
  'rule:security-baseline',
]);

/**
 * Load the criticality map from `<root>/manager/analyze/criticality.json`, tolerant of
 * two shapes: a class-keyed map (`{ safety: [uid…], compliance: [uid…] }`) OR a flat
 * `{ uid: "safety" }` map. Returns `uid → 'safety'|'compliance'|'normal'`. Fail-open to
 * the seed allowlist so the lock holds even if the file is missing/corrupt.
 *
 * @param {string} rootDir
 * @returns {Map<string,string>}
 */
function loadCriticality(rootDir) {
  /** @type {Map<string,string>} */
  const map = new Map();
  // Seed the hard fallback first (so a corrupt file can never UNLOCK a known control).
  for (const uid of SEED_SAFETY_UIDS) map.set(uid, 'safety');

  let doc = null;
  try {
    doc = readJson(path.join(rootDir, 'manager', 'analyze', 'criticality.json'));
  } catch {
    doc = null;
  }
  if (doc && typeof doc === 'object') {
    // Class-keyed shape.
    for (const cls of ['safety', 'compliance']) {
      const arr = Array.isArray(doc[cls]) ? doc[cls] : null;
      if (arr) for (const uid of arr) if (typeof uid === 'string') map.set(uid, cls);
    }
    // Flat shape: { uid: "safety" }.
    for (const [k, v] of Object.entries(doc)) {
      if (k.startsWith('_')) continue;
      if (v === 'safety' || v === 'compliance' || v === 'normal') map.set(k, v);
    }
  }
  return map;
}

/** True for a safety/compliance uid (the lock predicate). */
function isLocked(criticality) {
  return criticality === 'safety' || criticality === 'compliance';
}

// ---------------------------------------------------------------------------
// Catalog: artifact records with text/description for residency + criticality
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AnalyzeArtifact
 * @property {string} uid
 * @property {string} kind
 * @property {string} id
 * @property {string} path
 * @property {string} residency
 * @property {number} estTokens
 * @property {string} criticality
 * @property {Object} [costBreakdown]
 */

/**
 * Build the analyze artifact list: every registry artifact, classified into a residency
 * class with an estimated cost and a criticality tag. Hooks get their description from
 * `hooks.json` and their injection from the `.mjs` source. Rules/agents/skills/commands/
 * bundles are read from disk for residency + body/description estimation.
 *
 * @param {string} rootDir
 * @param {any} registry the built registry (artifacts + danglingRefs)
 * @param {Map<string,string>} criticality
 * @returns {AnalyzeArtifact[]}
 */
function buildArtifacts(rootDir, registry, criticality) {
  const out = [];
  const records = registry && Array.isArray(registry.artifacts) ? registry.artifacts : [];
  const hookMeta = loadHookMeta(rootDir);

  for (const rec of records) {
    if (!rec || typeof rec.uid !== 'string') continue;
    const crit = criticality.get(rec.uid) || 'normal';

    let cls;
    if (rec.kind === 'hook') {
      const meta = hookMeta.get(rec.id) || hookMeta.get(stripNs(rec.id)) || {};
      cls = classify({
        kind: 'hook',
        description: typeof meta.description === 'string' ? meta.description : rec.description || '',
        hookSource: meta.sourcePath || '',
      });
    } else if (rec.status === 'planned') {
      // A planned component has no on-disk file; cost 0, residency by kind heuristic.
      cls = { residency: rec.kind === 'rule' ? 'always-on' : 'conditional', estTokens: 0 };
    } else {
      const text = readArtifactText(rootDir, rec.path);
      cls = classify({ kind: rec.kind, text, description: rec.description || '' });
    }

    /** @type {AnalyzeArtifact} */
    const a = {
      uid: rec.uid,
      kind: rec.kind,
      id: rec.id,
      path: rec.path,
      residency: cls.residency,
      estTokens: Number.isInteger(cls.estTokens) ? cls.estTokens : 0,
      criticality: crit,
    };
    if (cls.costBreakdown) a.costBreakdown = cls.costBreakdown;
    out.push(a);
  }
  out.sort((x, y) => (x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0));
  return out;
}

/** Strip a leading `forge:` namespace from a hook id (best-effort). */
function stripNs(id) {
  return typeof id === 'string' && id.includes(':') ? id.split(':').pop() : id;
}

/**
 * Read `hooks/hooks.json` into a `bare-name → { description, sourcePath }` map. The
 * source path is extracted from the hook's `command` (the `*.mjs` it runs). Fail-open.
 *
 * @param {string} rootDir
 * @returns {Map<string,{description:string, sourcePath:string}>}
 */
function loadHookMeta(rootDir) {
  /** @type {Map<string,{description:string, sourcePath:string}>} */
  const map = new Map();
  let doc = null;
  try {
    doc = readJson(path.join(rootDir, 'hooks', 'hooks.json'));
  } catch {
    doc = null;
  }
  if (!doc || typeof doc !== 'object') return map;
  const eventMap = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : doc;
  for (const groups of Object.values(eventMap)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g.id !== 'string') continue;
      const bare = g.id.includes(':') ? g.id.split(':').pop() : g.id;
      const description = typeof g.description === 'string' ? g.description : '';
      const sourcePath = hookSourcePath(rootDir, g, bare);
      map.set(g.id, { description, sourcePath });
      map.set(bare, { description, sourcePath });
    }
  }
  return map;
}

/** Resolve a hook group's `.mjs` source path (from its command, or the conventional path). */
function hookSourcePath(rootDir, group, bare) {
  const hooks = Array.isArray(group.hooks) ? group.hooks : [];
  for (const h of hooks) {
    const cmd = h && typeof h.command === 'string' ? h.command : '';
    const m = cmd.match(/([\w./-]+\.mjs)/);
    if (m) {
      const rel = m[1].replace(/^.*hooks\//, 'hooks/');
      const candidate = path.isAbsolute(rel) ? rel : path.join(rootDir, rel);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* fall through */
      }
    }
  }
  // Conventional fallback: hooks/<bare>.mjs.
  const conv = path.join(rootDir, 'hooks', `${bare}.mjs`);
  try {
    if (fs.existsSync(conv)) return conv;
  } catch {
    /* ignore */
  }
  return '';
}

/** Read an artifact's raw text from disk (fail-open to ''). */
function readArtifactText(rootDir, relPath) {
  if (typeof relPath !== 'string' || relPath.includes('#')) return '';
  try {
    return fs.readFileSync(path.join(rootDir, relPath), 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Budgets: always-on total + per-profile (resolveModules-mirrored)
// ---------------------------------------------------------------------------

/**
 * Sum the always-on cost of an artifact list.
 * @param {AnalyzeArtifact[]} artifacts
 * @returns {number}
 */
function alwaysOnTotal(artifacts) {
  return artifacts
    .filter((a) => a.residency === 'always-on')
    .reduce((n, a) => n + (Number.isInteger(a.estTokens) ? a.estTokens : 0), 0);
}

/**
 * Resolve a profile's module set, mirroring the composer's `resolveModules`: the
 * profile's declared modules ∪ every `always:true` module. `moduleSelectionRules.add`
 * modules are added to the CONDITIONAL ceiling set (worst case) but NOT to the always-on
 * set, since analyze has no project facts to fire a rule (SPEC-06 §Budgets, §Open Q).
 *
 * @param {any} profilesDoc
 * @param {any} modulesDoc
 * @param {string} profileName
 * @returns {{base:Set<string>, ceiling:Set<string>}}
 */
function resolveModules(profilesDoc, modulesDoc, profileName) {
  const modules = modulesDoc && typeof modulesDoc.modules === 'object' ? modulesDoc.modules : {};
  const profiles = profilesDoc && typeof profilesDoc.profiles === 'object' ? profilesDoc.profiles : {};
  const base = new Set();
  // always:true modules are in every profile (core).
  for (const [name, def] of Object.entries(modules)) {
    if (def && def.always === true) base.add(name);
  }
  const prof = profiles[profileName];
  const declared = prof && Array.isArray(prof.modules) ? prof.modules : [];
  for (const m of declared) if (typeof m === 'string') base.add(m);

  const ceiling = new Set(base);
  const rules = profilesDoc && profilesDoc.moduleSelectionRules;
  const add = rules && Array.isArray(rules.add) ? rules.add : [];
  for (const r of add) if (r && typeof r.module === 'string') ceiling.add(r.module);

  return { base, ceiling };
}

/**
 * Compute per-profile budgets: `alwaysOn` (sum of always-on members of the profile's
 * base module set) and `conditionalCeiling` (every conditional member of the ceiling
 * module set assumed active = worst case).
 *
 * @param {string} rootDir
 * @param {any} profilesDoc
 * @param {any} modulesDoc
 * @param {AnalyzeArtifact[]} artifacts
 * @returns {Object<string,{alwaysOn:number, conditionalCeiling:number}>}
 */
function perProfileBudgets(rootDir, profilesDoc, modulesDoc, artifacts) {
  /** @type {Object<string,{alwaysOn:number, conditionalCeiling:number}>} */
  const out = {};
  const profiles = profilesDoc && typeof profilesDoc.profiles === 'object' ? profilesDoc.profiles : {};
  const uidToModules = moduleMembership(rootDir, modulesDoc);
  const byUid = new Map(artifacts.map((a) => [a.uid, a]));

  for (const profileName of Object.keys(profiles)) {
    const { base, ceiling } = resolveModules(profilesDoc, modulesDoc, profileName);
    let alwaysOn = 0;
    let conditionalCeiling = 0;
    for (const a of artifacts) {
      const mods = uidToModules.get(a.uid);
      if (!mods) continue;
      const inBase = [...mods].some((m) => base.has(m));
      const inCeiling = [...mods].some((m) => ceiling.has(m));
      if (a.residency === 'always-on' && inBase) {
        alwaysOn += Number.isInteger(a.estTokens) ? a.estTokens : 0;
      }
      if (a.residency === 'conditional' && inCeiling) {
        conditionalCeiling += Number.isInteger(a.estTokens) ? a.estTokens : 0;
      }
      void byUid;
    }
    out[profileName] = { alwaysOn, conditionalCeiling };
  }
  return out;
}

/**
 * Reverse-index modules.json into `uid → Set<module>` (mirrors registry.buildModuleIndex
 * resolution). Reused for both per-profile budgets and reachability.
 *
 * @param {string} rootDir
 * @param {any} modulesDoc
 * @returns {Map<string,Set<string>>}
 */
function moduleMembership(rootDir, modulesDoc) {
  /** @type {Map<string,Set<string>>} */
  const index = new Map();
  const modules = modulesDoc && typeof modulesDoc.modules === 'object' ? modulesDoc.modules : {};
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
        const uid = membershipUid(kind, String(name), hookIds);
        if (!uid) continue;
        let set = index.get(uid);
        if (!set) {
          set = new Set();
          index.set(uid, set);
        }
        set.add(moduleName);
      }
    }
  }
  return index;
}

/** Map a manifest (kind, name) to the uid the registry record carries. */
function membershipUid(kind, name, hookIds) {
  const singular = {
    agents: 'agent',
    skills: 'skill',
    commands: 'command',
    rules: 'rule',
    bundles: 'bundle',
    hooks: 'hook',
    validators: 'validator',
    engine: 'engine',
  }[kind];
  if (!singular) return null;
  if (singular === 'hook') {
    const bare = name.split('@')[0];
    const ns = hookIds && hookIds.has(`forge:${bare}`) ? `forge:${bare}` : bare;
    return `hook:${ns}`;
  }
  if (singular === 'engine') return `engine:${name}`;
  return `${singular}:${name}`;
}

// ---------------------------------------------------------------------------
// Telemetry (drives degrade-to-static + the adequacy gate)
// ---------------------------------------------------------------------------

/**
 * Load the telemetry window from `<root>/.forge/telemetry.json`. Fail-open to a
 * not-available window. Shape: `{ available, sessions, windowDays, events: [] }`.
 *
 * @param {string} rootDir
 * @returns {{available:boolean, sessions:number, windowDays:number, events:any[]}}
 */
function loadTelemetry(rootDir) {
  let doc = null;
  try {
    doc = readJson(path.join(forgeStateDir(rootDir), 'telemetry.json'));
  } catch {
    doc = null;
  }
  if (!doc || typeof doc !== 'object' || doc.available !== true) {
    return { available: false, sessions: 0, windowDays: 0, events: [] };
  }
  return {
    available: true,
    sessions: Number.isFinite(doc.sessions) ? doc.sessions : 0,
    windowDays: Number.isFinite(doc.windowDays) ? doc.windowDays : 0,
    events: Array.isArray(doc.events) ? doc.events : [],
  };
}

/** Window adequacy gate (BR-EFF-008): adequate ⇒ a dynamic-dead verdict may be `prune`. */
function windowAdequate(tel) {
  return tel.available && tel.sessions >= MIN_SESSIONS && tel.windowDays >= MIN_DAYS;
}

/**
 * Count fire/cite/invoke events per uid from a telemetry window. v0.3 reads a flat
 * `events: [{ uid, ... }]` list; an empty window means every uid has 0 fires.
 *
 * @param {{events:any[]}} tel
 * @returns {Map<string,number>}
 */
function fireCounts(tel) {
  const m = new Map();
  for (const e of tel.events || []) {
    const uid = e && typeof e.uid === 'string' ? e.uid : null;
    if (uid) m.set(uid, (m.get(uid) || 0) + 1);
  }
  return m;
}

// ---------------------------------------------------------------------------
// The analyze report
// ---------------------------------------------------------------------------

/**
 * Produce the full analyze report (the `data` of the envelope). PURE compute over the
 * harness root + optional `--project`. Never writes, never throws past its surface.
 *
 * @param {string} rootDir harness root
 * @param {string|null} projectDir optional project tree for D5
 * @returns {{report:Object, findings:import('./lib/findings.mjs').Finding[]}}
 */
function analyze(rootDir, projectDir) {
  /** @type {import('./lib/findings.mjs').Finding[]} */
  const findings = [];

  const criticality = loadCriticality(rootDir);
  let registry;
  try {
    registry = buildRegistry(rootDir, readCommittedRegistry(rootDir));
  } catch {
    registry = { artifacts: [], danglingRefs: [] };
  }
  const artifacts = buildArtifacts(rootDir, registry, criticality);

  const modulesDoc = readJson(path.join(rootDir, 'manifests', 'modules.json'));
  const profilesDoc = readJson(path.join(rootDir, 'manifests', 'profiles.json'));

  const total = alwaysOnTotal(artifacts);
  const perProfile = perProfileBudgets(rootDir, profilesDoc, modulesDoc, artifacts);

  // --- Static dead-detection D1–D4 (+ D5 when --project given). ---
  let deadStaticRaw = [];
  try {
    deadStaticRaw = detectStatic({
      rootDir,
      modulesDoc,
      profilesDoc,
      artifacts,
      danglingRefs: Array.isArray(registry.danglingRefs) ? registry.danglingRefs : [],
    });
  } catch {
    deadStaticRaw = [];
  }
  const notices = [];
  if (projectDir) {
    try {
      const pathScopedRules = artifacts
        .filter((a) => a.kind === 'rule')
        .map((a) => ({ uid: a.uid, kind: a.kind, absText: readArtifactText(rootDir, a.path), path: a.path }));
      deadStaticRaw = deadStaticRaw.concat(detectD5({ projectDir, rules: pathScopedRules }));
    } catch {
      /* fail-open */
    }
  } else {
    notices.push('D5 vacuous-rule check skipped (needs --project)');
  }

  // --- Criticality lock: filter safety/compliance OUT of every dead surface. ---
  const critOf = (uid) => criticality.get(uid) || 'normal';
  const deadStatic = deadStaticRaw.filter((d) => !isLocked(critOf(d.uid)));

  // --- Telemetry + dynamic-dead (thin v0.3 slice behind the lock + adequacy gate). ---
  const tel = loadTelemetry(rootDir);
  const adequate = windowAdequate(tel);
  const fires = fireCounts(tel);
  const uidToModules = moduleMembership(rootDir, modulesDoc);
  const composed = reachableUids(profilesDoc, modulesDoc, uidToModules);

  /** @type {Array<{uid:string, verdict:string, fires:number, evidence:string, recommend:boolean}>} */
  const deadDynamic = [];
  /** @type {Array<{uid:string, verdict:string, fires:number}>} */
  const watch = [];
  /** @type {Array<{uid:string, verdict:string, fires:number, recoverableTokens:number, evidence:string}>} */
  const pruneCandidates = [];
  /** @type {Array<{uid:string, fires:number, note:string}>} */
  const lowActivitySafety = [];

  if (tel.available) {
    for (const a of artifacts) {
      const fireCount = fires.get(a.uid) || 0;
      const locked = isLocked(a.criticality);
      // SAFETY: zero-fire safety is SUCCESS, never dead/waste/prune (BR-EFF-006/007).
      if (locked) {
        if (fireCount === 0) {
          lowActivitySafety.push({
            uid: a.uid,
            fires: 0,
            note: `0 fires = no secrets leaked = the control is working (criticality=${a.criticality}, expected)`,
          });
        }
        continue; // never enters any dead/prune surface
      }
      // NORMAL, reachable, never-fired → dynamic-dead verdict, gated by adequacy.
      if (fireCount === 0 && composed.has(a.uid) && a.residency !== 'on-demand') {
        if (adequate) {
          const ev = `0 fires over ${tel.sessions} sessions / ${tel.windowDays} days`;
          deadDynamic.push({ uid: a.uid, verdict: 'prune', fires: 0, evidence: ev, recommend: true });
          pruneCandidates.push({
            uid: a.uid,
            verdict: 'prune',
            fires: 0,
            recoverableTokens: Number.isInteger(a.estTokens) ? a.estTokens : 0,
            evidence: ev,
          });
        } else {
          // Thin window: downgrade prune → watch (BR-EFF-008).
          deadDynamic.push({
            uid: a.uid,
            verdict: 'watch',
            fires: 0,
            evidence: `0 fires but window is thin (sessions ${tel.sessions} < ${MIN_SESSIONS} or days ${tel.windowDays} < ${MIN_DAYS})`,
            recommend: false,
          });
          watch.push({ uid: a.uid, verdict: 'watch', fires: 0 });
        }
      }
    }
  } else {
    notices.push('dynamic checks unavailable (telemetry off) — static only');
  }

  const report = {
    constants: { CHARS_PER_TOKEN, CODE_DENSITY, MIN_SESSIONS, MIN_DAYS },
    telemetry: { available: tel.available, sessions: tel.sessions, windowDays: tel.windowDays },
    artifacts,
    alwaysOnTotal: total,
    perProfile,
    deadStatic,
    deadDynamic,
    watch,
    pruneCandidates,
    lowActivitySafety,
    notices,
  };
  return { report, findings };
}

/**
 * The set of uids reachable from any profile (composed): a uid is reachable when one of
 * its modules is in some profile's resolved set (base ∪ moduleSelectionRules.add).
 *
 * @param {any} profilesDoc
 * @param {any} modulesDoc
 * @param {Map<string,Set<string>>} uidToModules
 * @returns {Set<string>}
 */
function reachableUids(profilesDoc, modulesDoc, uidToModules) {
  const reachableModules = new Set();
  const modules = modulesDoc && typeof modulesDoc.modules === 'object' ? modulesDoc.modules : {};
  for (const [name, def] of Object.entries(modules)) if (def && def.always === true) reachableModules.add(name);
  const profiles = profilesDoc && typeof profilesDoc.profiles === 'object' ? profilesDoc.profiles : {};
  for (const def of Object.values(profiles)) {
    const mods = def && Array.isArray(def.modules) ? def.modules : [];
    for (const m of mods) if (typeof m === 'string') reachableModules.add(m);
  }
  const rules = profilesDoc && profilesDoc.moduleSelectionRules;
  const add = rules && Array.isArray(rules.add) ? rules.add : [];
  for (const r of add) if (r && typeof r.module === 'string') reachableModules.add(r.module);

  const out = new Set();
  for (const [uid, mods] of uidToModules) {
    if ([...mods].some((m) => reachableModules.has(m))) out.add(uid);
  }
  return out;
}

/** Read the committed registry snapshot (for carry-forward identity); fail-open. */
function readCommittedRegistry(rootDir) {
  try {
    return readJson(path.join(forgeStateDir(rootDir), 'registry.json'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// optimize (v0.6 DEFERRED) — v0.3 ships the safety-exclusion lock skeleton ONLY
// ---------------------------------------------------------------------------

/**
 * Build the dry-run prune-plan. v0.3 ships the SAFETY-EXCLUSION skeleton required by
 * the EVAL-EFF-006 lock: the plan carries NO safety recommendation (every safety uid is
 * filtered to the non-actionable "considered & excluded" section). Recommendations are
 * the normal prune-candidates from the (telemetry-gated) analyze report. NEVER deletes;
 * `--emit-plan` writes ONLY `<root>/.forge/optimize.plan.json` (additive-never-destructive).
 *
 * @param {string} rootDir
 * @param {boolean} emit whether to write optimize.plan.json
 * @returns {{plan:Object, wrote:boolean}}
 */
function optimize(rootDir, emit) {
  const { report } = analyze(rootDir, null);
  const criticality = loadCriticality(rootDir);
  const recommendations = [];
  const consideredAndExcluded = [];

  // Safety/compliance artifacts are excluded at the DATA layer (ADR-0013): they appear
  // ONLY in the non-actionable section, never as a recommendation.
  for (const a of report.artifacts || []) {
    if (isLocked(a.criticality)) {
      consideredAndExcluded.push({
        uid: a.uid,
        reason: `criticality=${a.criticality} (ADR-0013)`,
        safetyLocked: true,
      });
    }
  }
  for (const p of report.pruneCandidates || []) {
    // Defensive: never let a locked uid through even if it leaked into pruneCandidates.
    if (isLocked(criticality.get(p.uid) || 'normal')) continue;
    recommendations.push({
      checkId: 'U1',
      uid: p.uid,
      confidence: 'med',
      recoverableTokens: Number.isInteger(p.recoverableTokens) ? p.recoverableTokens : 0,
      evidence: p.evidence || '',
      safetyLocked: false,
    });
  }

  const plan = { recommendations, consideredAndExcluded };
  let wrote = false;
  if (emit) {
    try {
      const dir = forgeStateDir(rootDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'optimize.plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
      wrote = true;
    } catch {
      wrote = false; // fail-open: never block on a write failure
    }
  }
  return { plan, wrote };
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * Normalise heterogeneous args/ctx into { rootDir, projectDir, emit, apply, json }. The
 * tests pass `args` as a string[] (e.g. ['--project', dir] or ['--emit-plan']) and a ctx
 * carrying `{ FORGE_ROOT|root|cwd }`. A trailing non-flag positional is `projectDir` for
 * `analyze [projectDir]` (SPEC-06 CLI). `--project <dir>` is the explicit form.
 *
 * @param {any} args
 * @param {any} ctx
 * @returns {{rootDir:string, projectDir:string|null, emit:boolean, apply:boolean, json:boolean}}
 */
function normalize(args, ctx) {
  const list = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  const positional = [];
  let projectDir = null;
  let emit = false;
  let apply = false;
  let json = false;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (typeof a !== 'string') continue;
    if (a === '--project') {
      if (i + 1 < list.length && !String(list[i + 1]).startsWith('--')) projectDir = list[++i];
    } else if (a.startsWith('--project=')) {
      projectDir = a.slice('--project='.length);
    } else if (a === '--emit-plan') {
      emit = true;
    } else if (a === '--apply') {
      apply = true;
    } else if (a === '--json') {
      json = true;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  if (ctx && ctx.flags instanceof Set) {
    if (ctx.flags.has('emit-plan')) emit = true;
    if (ctx.flags.has('apply')) apply = true;
    if (ctx.flags.has('json')) json = true;
  }
  const rootDir =
    (ctx && (ctx.FORGE_ROOT || ctx.forgeRoot || ctx.root || ctx.cwd)) || process.cwd();
  // The trailing positional, if present and not consumed as rootDir, is projectDir for
  // `analyze [projectDir]`. The ctx ALWAYS supplies rootDir in the tests, so a lone
  // positional is the project tree.
  if (!projectDir && positional.length) projectDir = positional[positional.length - 1];
  return { rootDir, projectDir: projectDir || null, emit, apply, json };
}

/**
 * C4 entry. NEVER writes stdout. Returns { ok, data, findings, summary }. `analyze` is
 * READ-ONLY (rejects `--apply`, BR-CLI-010); `optimize --emit-plan` writes only
 * optimize.plan.json. Fail-open: any internal failure degrades to a still-renderable
 * report, never throws past run().
 *
 * @param {string} subcmd 'analyze' | 'optimize'
 * @param {any} args string[] | { positional, flags }
 * @param {any} ctx { FORGE_ROOT|root|cwd, flags? }
 * @returns {Promise<{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const { rootDir, projectDir, emit, apply } = normalize(args, ctx);

    if (subcmd === 'analyze') {
      // READ-ONLY: analyze accepts no mutation flag (BR-CLI-010, EVAL-CLI-010).
      if (apply) {
        return result(false, null, [
          makeFinding({
            level: 'ERROR',
            path: 'analyze',
            line: null,
            message: 'analyze is read-only and does not accept --apply (use `forge optimize --apply`)',
            source: SOURCE,
          }),
        ]);
      }
      const { report, findings } = analyze(rootDir, projectDir);
      return result(true, report, findings, {
        artifacts: report.artifacts.length,
        alwaysOnTotal: report.alwaysOnTotal,
        deadStatic: report.deadStatic.length,
      });
    }

    if (subcmd === 'optimize') {
      const { plan, wrote } = optimize(rootDir, emit);
      return result(true, plan, [], {
        recommendations: plan.recommendations.length,
        excluded: plan.consideredAndExcluded.length,
        wrote,
      });
    }

    return result(false, { usage: usageText() }, [
      makeFinding({
        level: 'ERROR',
        path: 'analyze',
        line: null,
        message: `unknown efficiency subcommand: ${subcmd || '(none)'}`,
        source: SOURCE,
      }),
    ]);
  } catch (e) {
    // Fail-open: never throw past run().
    return result(false, null, [
      makeFinding({
        level: 'ERROR',
        path: 'analyze',
        line: null,
        message: `analyze error: ${e && e.message ? e.message : String(e)}`,
        source: SOURCE,
      }),
    ]);
  }
}

/**
 * C4 `summarize(state)` — pure; map an analyze report to a one-panel summary. Returns a
 * `(no data)` panel when state is absent (fail-open). Mirrors registry.mjs#makePanel.
 *
 * @param {any} state the analyze report (`run().data`) if available
 * @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.artifacts)) {
    return makePanel({ panel: 'efficiency', ok: false, lines: ['(no data)'], hint: 'run forge analyze' });
  }
  const dead = Array.isArray(state.deadStatic) ? state.deadStatic.length : 0;
  return makePanel({
    panel: 'efficiency',
    ok: true,
    lines: [`always-on ~${state.alwaysOnTotal} tok`, `${state.artifacts.length} artifact(s)`, `${dead} static-dead`],
  });
}

/** Panel object with a non-enumerable toString (mirrors registry.mjs#makePanel). */
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

/** Assemble a ModuleResult { ok, data, findings, summary } (the C4 contract). */
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

/** Static usage banner. */
function usageText() {
  return [
    'forge analyze [projectDir] [--project <dir>] [--json]   # v0.3 read-only context-budget report',
    'forge optimize [--emit-plan] [--json]                   # v0.6 dry-run prune-plan (safety-locked)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Human render (print side) — leading `~` on every token figure (BR-EFF-001)
// ---------------------------------------------------------------------------

/**
 * Render an analyze report as human text. Every token figure carries a leading `~`
 * (estimate, never exact). Returns the text block (caller writes it). PURE.
 *
 * @param {Object} data the analyze report
 * @returns {string}
 */
function renderHuman(data) {
  const lines = [];
  lines.push('forge analyze — static context-budget (estimates, never exact)');
  lines.push(`  always-on TOTAL: ~${data.alwaysOnTotal} tok`);
  const arts = Array.isArray(data.artifacts) ? data.artifacts : [];
  for (const a of arts) {
    lines.push(`  ${a.residency.padEnd(11)} ~${a.estTokens} tok   ${a.uid}${a.criticality !== 'normal' ? `  [${a.criticality}]` : ''}`);
  }
  const pp = data.perProfile || {};
  for (const name of Object.keys(pp)) {
    lines.push(`  profile ${name}: always-on ~${pp[name].alwaysOn} tok, conditional-ceiling ~${pp[name].conditionalCeiling} tok`);
  }
  const dead = Array.isArray(data.deadStatic) ? data.deadStatic : [];
  for (const d of dead) lines.push(`  DEAD ${d.checkId} ${d.uid} — ${d.evidence}`);
  for (const s of data.lowActivitySafety || []) lines.push(`  SAFETY (expected) ${s.uid} — ${s.note}`);
  for (const n of data.notices || []) lines.push(`  note: ${n}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Dual-mode: direct script entry
//   node manager/efficiency.mjs <analyze|optimize> [flags] [projectDir]
// Renders human text, or the C3 --json envelope under --json. PRINT happens ONLY here
// (the print/compute split): run() never writes stdout. CRITICAL: guarded by isMain()
// and NEVER calls process.exit() at import time (mirrors registry.mjs / status.mjs).
// ---------------------------------------------------------------------------

/** Read the raw forge VERSION for the envelope `forge` field (fail-open). */
function readRawVersion(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'VERSION'), 'utf8');
    const v = (raw || '').trim();
    return v || '0.0.0';
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
  const subcmd = argv[0] || 'analyze';
  const rest = argv.slice(1);
  const json = rest.includes('--json');
  // The trailing positional may be the rootDir (tests target fixtures) OR the project
  // tree. The direct script runs in cwd; pass cwd as rootDir and let normalize pick a
  // trailing positional as projectDir.
  run(subcmd, rest, { root: process.cwd(), cwd: process.cwd() })
    .then((res) => {
      if (json) {
        const env = envelope({
          command: `analyze ${subcmd === 'optimize' ? 'optimize' : ''}`.trim() || 'analyze',
          ok: res.ok,
          data: res.data,
          findings: res.findings,
          summary: res.summary,
          forgeVersion: readRawVersion(process.cwd()),
        });
        writeStdoutSync(JSON.stringify(env) + '\n'); // SYNC write before exit — pipe-flush truncation (see json-out.mjs)
      } else if (res.data && Array.isArray(res.data.artifacts)) {
        process.stdout.write(renderHuman(res.data));
      } else if (res.data && Array.isArray(res.data.recommendations)) {
        process.stdout.write(`optimize: ${res.data.recommendations.length} recommendation(s), ${res.data.consideredAndExcluded.length} excluded (safety-locked)\n`);
      }
      for (const f of res.findings || []) {
        const loc = f.line ? `${f.path}:${f.line}` : f.path;
        process.stderr.write(`${f.level} ${loc} ${f.message}\n`);
      }
      process.exit(res.ok ? 0 : (res.findings || []).some((f) => f.level === 'ERROR') ? 1 : 0);
    })
    .catch(() => process.exit(1)); // fail-open: never an unhandled rejection
}

export default { run, summarize };
