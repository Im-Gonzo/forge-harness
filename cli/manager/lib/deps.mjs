// @ts-check
/**
 * deps - the typed dependency-graph layer over the registry (SPEC-03, BR-DEP-001..007).
 *
 * PURE + fail-open. Given the artifact records the registry scan produced (each with
 * its on-disk `path`) plus the raw `rootDir`, this module:
 *
 *   1. Extracts TYPED directed edges {from, to, type, source, rawRef, refKind, sites[]}
 *      from three resolvers (BR-DEP-001):
 *        - MANIFEST  - modules.json -> member-of (component->module),
 *                      profiles.json -> selects (profile->module);
 *        - FRONTMATTER - bundle pointers skill:/agent:/reviewer: ->
 *                      uses-skill/uses-agent/uses-reviewer, plus applies-rule:;
 *        - PROSE (the validate-xref upgrade, BR-DEP-002) - over fenced-code-stripped
 *                      bodies: markdown links (references), the literal agents/<x>.md
 *                      path form, and BACKTICKED BARE NAMES matched against the known-uid
 *                      set + the <x>-reviewer / <x>-agent heuristic (routes-to).
 *   2. Resolves each edge's `to` against the known-uid set; an edge that does NOT
 *      resolve to a real uid becomes a consolidated danglingRefs[] entry keyed by
 *      rawRef with ALL of its sites[] (BR-DEP-003/004).
 *   3. Projects each artifact's RESOLVED outbound targets into a sorted dependsOn[].
 *
 * Determinism: edges and dependsOn[] are sorted; dangling entries are sorted and their
 * sites[] sorted, so two builds of an unchanged tree are byte-identical.
 *
 * HARD INVARIANTS: zero runtime deps (node builtins + relative imports only); fail-open
 * - no export throws; module/profile/prose readers degrade to empty on any IO/parse error.
 *
 * @module manager/lib/deps
 */

import fs from 'node:fs';
import path from 'node:path';

import { componentCandidates, pathToUid, loadDeclaredHookIds } from './resolve-kind.mjs';

/**
 * @typedef {Object} Site
 * @property {string} path repo-relative path of the referencing file
 * @property {number|null} line 1-based line, or null when not line-locatable
 */

/**
 * @typedef {Object} Edge
 * @property {string} from source uid
 * @property {string|null} to resolved target uid, or null when unresolved
 * @property {string} type routes-to|uses-skill|uses-agent|uses-reviewer|member-of|applies-rule|selects|references
 * @property {string} source frontmatter|prose|manifest
 * @property {string} rawRef the raw reference text (bare name / path / module name)
 * @property {string} refKind agent|skill|command|rule|bundle|module|link
 * @property {Site[]} sites
 */

/**
 * @typedef {Object} DanglingRef
 * @property {string} from
 * @property {string} rawRef
 * @property {string} refKind
 * @property {Site[]} sites
 * @property {string} reason
 */

/** Bundle frontmatter pointer key -> edge type. */
const BUNDLE_POINTER_TYPE = {
  skill: 'uses-skill',
  agent: 'uses-agent',
  reviewer: 'uses-reviewer',
};

/** The <x>-reviewer / <x>-agent prose heuristic (BR-DEP-002). */
const REVIEWER_HEURISTIC = /^[a-z][-a-z0-9]*-reviewer$/;
const AGENT_HEURISTIC = /^[a-z][-a-z0-9]*-agent$/;

/**
 * Markdown artifact kinds whose BODY we scan for prose references. Validators,
 * meta-tests and engines are CODE: backticked tokens in their comments (e.g. the
 * `agents/x.md` placeholder in validate-xref's docstring) are documentation, not
 * references, so prose scanning would only produce false danglers there. Frontmatter
 * pointers (bundle skill:/agent:/reviewer:) live only on these markdown kinds anyway.
 */
const PROSE_KINDS = new Set(['agent', 'skill', 'command', 'rule', 'bundle']);

/**
 * Compute the full graph for a built artifact set.
 *
 * @param {string} rootDir absolute FORGE root (or fixture sandbox root)
 * @param {Array<{uid:string,kind:string,id:string,path:string,status:string}>} artifacts
 * @returns {{edges: Edge[], danglingRefs: DanglingRef[], dependsOn: Map<string,string[]>, inbound: Map<string,Set<string>>}}
 */
export function computeGraph(rootDir, artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];

  // Known-uid set + a bare-name -> uid index for prose resolution. The bare-name index
  // is kind-segmented so a routes-to candidate prefers an agent target, etc.
  const knownUids = new Set();
  /** @type {Map<string, Map<string,string>>} kind -> (id -> uid) */
  const byKindId = new Map();
  for (const a of list) {
    if (!a || typeof a.uid !== 'string') continue;
    knownUids.add(a.uid);
    let m = byKindId.get(a.kind);
    if (!m) {
      m = new Map();
      byKindId.set(a.kind, m);
    }
    if (typeof a.id === 'string') m.set(a.id, a.uid);
  }

  /** @type {Edge[]} */
  const edges = [];

  // --- 1. Manifest edges (member-of, selects) ------------------------------
  for (const e of manifestEdges(rootDir, knownUids)) edges.push(e);

  // --- 2/3. Per-artifact frontmatter + prose edges -------------------------
  for (const a of list) {
    if (!a || typeof a.uid !== 'string' || typeof a.path !== 'string') continue;
    if (a.path.includes('#')) continue; // hook pseudo-path: nothing to scan
    if (a.status === 'planned') continue; // planned: no on-disk body to scan
    const abs = path.join(rootDir, a.path);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // fail-open per file
    }
    for (const e of frontmatterEdges(rootDir, a, text, knownUids)) edges.push(e);
    // Prose scanning is for markdown artifact bodies only (code comments in validators/
    // meta-tests/engines are not references).
    if (PROSE_KINDS.has(a.kind)) {
      for (const e of proseEdges(a, text, knownUids, byKindId)) edges.push(e);
    }
  }

  return finalizeGraph(edges);
}

/**
 * Resolve, consolidate, sort. Splits edges into resolved (drive dependsOn/inbound) and
 * unresolved (consolidated dangling entries). Deterministic ordering throughout.
 *
 * @param {Edge[]} edges
 * @returns {{edges: Edge[], danglingRefs: DanglingRef[], dependsOn: Map<string,string[]>, inbound: Map<string,Set<string>>}}
 */
function finalizeGraph(edges) {
  // Deduplicate identical edges (same from/to/type/source/rawRef) merging their sites.
  /** @type {Map<string, Edge>} */
  const merged = new Map();
  for (const e of edges) {
    const toPart = e.to == null ? '' : e.to;
    const key = [e.from, toPart, e.type, e.source, e.rawRef].join('');
    const cur = merged.get(key);
    if (cur) {
      for (const s of e.sites) cur.sites.push(s);
    } else {
      merged.set(key, { ...e, sites: [...e.sites] });
    }
  }
  const allEdges = [...merged.values()];
  for (const e of allEdges) e.sites = sortSites(dedupeSites(e.sites));
  allEdges.sort(edgeCmp);

  /** @type {Map<string,Set<string>>} from -> resolved target uids */
  const outSet = new Map();
  /** @type {Map<string,Set<string>>} to -> from uids (inbound) */
  const inbound = new Map();
  /** @type {Map<string, DanglingRef>} rawRef -> consolidated dangling entry */
  const dangMap = new Map();

  for (const e of allEdges) {
    if (e.to) {
      let o = outSet.get(e.from);
      if (!o) {
        o = new Set();
        outSet.set(e.from, o);
      }
      o.add(e.to);
      let inb = inbound.get(e.to);
      if (!inb) {
        inb = new Set();
        inbound.set(e.to, inb);
      }
      inb.add(e.from);
    } else {
      // Unresolved -> consolidate by rawRef so the SAME missing name referenced from
      // multiple files collapses into ONE entry whose sites[] covers every referrer
      // (BR-DEP-003/004). `from` is the lexicographically-smallest referrer uid so the
      // representative is deterministic (agent:typescript-reviewer < rule:react-patterns).
      const k = e.rawRef;
      let d = dangMap.get(k);
      if (!d) {
        d = {
          from: e.from,
          rawRef: e.rawRef,
          refKind: e.refKind,
          sites: [],
          reason: danglingReason(e),
        };
        dangMap.set(k, d);
      } else if (e.from < d.from) {
        d.from = e.from; // keep the smallest referrer uid as the canonical `from`
      }
      for (const s of e.sites) d.sites.push(s);
    }
  }

  /** @type {Map<string,string[]>} */
  const dependsOn = new Map();
  for (const [from, set] of outSet) dependsOn.set(from, [...set].sort());

  const danglingRefs = [...dangMap.values()];
  for (const d of danglingRefs) d.sites = sortSites(dedupeSites(d.sites));
  danglingRefs.sort((a, b) => {
    if (a.rawRef !== b.rawRef) return a.rawRef < b.rawRef ? -1 : 1;
    return a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
  });

  return { edges: allEdges, danglingRefs, dependsOn, inbound };
}

/** Human-readable reason string for a dangling edge. */
function danglingReason(e) {
  if (e.source === 'prose' && (REVIEWER_HEURISTIC.test(e.rawRef) || AGENT_HEURISTIC.test(e.rawRef))) {
    return 'prose bare-name ref does not resolve to a known uid (<x>-reviewer heuristic)';
  }
  return `${e.source} ${e.type} ref "${e.rawRef}" does not resolve to a known uid`;
}

// ---------------------------------------------------------------------------
// Manifest edges
// ---------------------------------------------------------------------------

/**
 * modules.json -> member-of (component->module); profiles.json -> selects
 * (profile->module). The module is NOT a registry artifact, so `to` for these edges is
 * a synthetic module:<name>. member-of edges are recorded for completeness and never
 * dangle (the module name is authoritative from the manifest itself).
 *
 * @param {string} rootDir
 * @param {Set<string>} knownUids
 * @returns {Edge[]}
 */
function manifestEdges(rootDir, knownUids) {
  /** @type {Edge[]} */
  const out = [];
  let hookIds;
  try {
    hookIds = loadDeclaredHookIds(rootDir);
  } catch {
    hookIds = new Set();
  }

  // member-of
  const modulesDoc = readJsonSafe(path.join(rootDir, 'manifests', 'modules.json'));
  if (modulesDoc && modulesDoc.modules && typeof modulesDoc.modules === 'object') {
    for (const [moduleName, mDef] of Object.entries(modulesDoc.modules)) {
      const comps = mDef && mDef.components && typeof mDef.components === 'object' ? mDef.components : {};
      for (const [kind, names] of Object.entries(comps)) {
        if (!Array.isArray(names)) continue;
        for (const name of names) {
          const uid = manifestComponentUid(rootDir, kind, String(name), hookIds);
          if (!uid) continue; // unresolved component is a manifest concern, not a graph dangler
          out.push(
            edge(uid, `module:${moduleName}`, 'member-of', 'manifest', moduleName, 'module', [
              { path: 'manifests/modules.json', line: null },
            ]),
          );
        }
      }
    }
  }

  // selects (profile -> module). The module target is synthetic module:<name>.
  const profilesDoc = readJsonSafe(path.join(rootDir, 'manifests', 'profiles.json'));
  if (profilesDoc && profilesDoc.profiles && typeof profilesDoc.profiles === 'object') {
    for (const [profileName, pDef] of Object.entries(profilesDoc.profiles)) {
      const mods = pDef && Array.isArray(pDef.modules) ? pDef.modules : [];
      for (const m of mods) {
        out.push(
          edge(`profile:${profileName}`, `module:${m}`, 'selects', 'manifest', String(m), 'module', [
            { path: 'manifests/profiles.json', line: null },
          ]),
        );
      }
    }
  }
  // member-of / selects target synthetic module uids that are never in knownUids; they
  // are authoritative from the manifest, so we keep them resolved (to !== null).
  void knownUids;
  return out;
}

/**
 * Resolve a manifest (kind, name) pair to the uid the registry record carries (mirror
 * of registry.mjs#componentUid so the graph and the catalog never disagree).
 *
 * @param {string} rootDir
 * @param {string} kind plural component kind
 * @param {string} name
 * @param {Set<string>} hookIds
 * @returns {string|null}
 */
function manifestComponentUid(rootDir, kind, name, hookIds) {
  if (kind === 'hooks') {
    const base = name.split('@')[0];
    if (hookIds.has(`forge:${base}`)) return `hook:forge:${base}`;
    return `hook:${base}`;
  }
  let candidates = [];
  try {
    candidates = componentCandidates(rootDir, kind, name);
  } catch {
    candidates = [];
  }
  for (const cand of candidates) {
    if (cand === '__HOOK__') continue;
    const cls = pathToUid(rootDir, cand);
    if (cls) return `${cls.kind}:${cls.id}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Frontmatter edges
// ---------------------------------------------------------------------------

/**
 * Bundle frontmatter pointers (skill:/agent:/reviewer:) and applies-rule:. These keys
 * are NOT in the registry frontmatter parser's known set, so we read the raw
 * frontmatter block directly. Each pointer value is a PATH (agents/x.md) or a bare
 * name; resolved via pathToUid (path form) or the known byKind index.
 *
 * @param {string} rootDir
 * @param {{uid:string,kind:string,path:string}} a
 * @param {string} text raw file text
 * @param {Set<string>} knownUids
 * @returns {Edge[]}
 */
function frontmatterEdges(rootDir, a, text, knownUids) {
  /** @type {Edge[]} */
  const out = [];
  const fm = rawFrontmatterScalars(text);
  if (!fm) return out;

  // Bundle pointers: skill/agent/reviewer (only meaningful on a bundle, but harmless
  // elsewhere - a non-bundle simply won't carry these keys).
  for (const [key, type] of Object.entries(BUNDLE_POINTER_TYPE)) {
    const raw = fm.scalars.get(key);
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const { to, refKind } = resolveFrontmatterPointer(rootDir, raw, knownUids);
    out.push(edge(a.uid, to, type, 'frontmatter', raw, refKind, [{ path: a.path, line: fm.lines.get(key) ?? null }]));
  }

  // applies-rule: a path or bare rule name.
  const ar = fm.scalars.get('applies-rule');
  if (typeof ar === 'string' && ar.length > 0) {
    const { to } = resolveFrontmatterPointer(rootDir, ar, knownUids, 'rule');
    out.push(edge(a.uid, to, 'applies-rule', 'frontmatter', ar, 'rule', [{ path: a.path, line: fm.lines.get('applies-rule') ?? null }]));
  }

  return out;
}

/**
 * Resolve a frontmatter pointer value to a uid. A kind/.../name.md-style PATH is
 * resolved via pathToUid; a bare name falls back to scanning the known-uid set for a
 * <kind>:<name> match (preferring `prefKind` when supplied).
 *
 * @param {string} rootDir
 * @param {string} raw pointer value
 * @param {Set<string>} knownUids
 * @param {string} [prefKind] preferred registry kind for a bare-name resolution
 * @returns {{to:string|null, refKind:string}}
 */
function resolveFrontmatterPointer(rootDir, raw, knownUids, prefKind) {
  const val = stripClaudePrefix(raw.trim());
  // Path form (contains a slash and ends in a recognised artifact location).
  if (val.includes('/')) {
    const cls = pathToUid(rootDir, val) || pathToUidFromBare(val);
    if (cls) {
      const uid = `${cls.kind}:${cls.id}`;
      return { to: knownUids.has(uid) ? uid : null, refKind: cls.kind };
    }
    return { to: null, refKind: prefKind || 'link' };
  }
  // Bare name: try preferred kind, then any kind.
  if (prefKind) {
    const uid = `${prefKind}:${val}`;
    if (knownUids.has(uid)) return { to: uid, refKind: prefKind };
  }
  for (const kind of ['agent', 'skill', 'rule', 'command', 'bundle']) {
    const uid = `${kind}:${val}`;
    if (knownUids.has(uid)) return { to: uid, refKind: kind };
  }
  return { to: null, refKind: prefKind || 'agent' };
}

/**
 * Read the raw leading frontmatter block as a flat scalar map (key -> trimmed value)
 * plus the 1-based line number each key appeared on. Tolerant of BOM/CRLF; never
 * throws. Only single-line `key: value` scalars are captured (the pointer keys are
 * always single-line). Returns null when there is no frontmatter block.
 *
 * @param {string} text
 * @returns {{scalars: Map<string,string>, lines: Map<string,number>}|null}
 */
function rawFrontmatterScalars(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/^\uFEFF/, '');
  const m = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n[\s\S]*)?$/);
  if (!m) return null;
  const block = m[1];
  const rawLines = block.split(/\r?\n/);
  const scalars = new Map();
  const lines = new Map();
  for (let i = 0; i < rawLines.length; i++) {
    const ln = rawLines[i];
    if (/^\s/.test(ln)) continue; // indented (block list / nested) - not a pointer
    const colon = ln.indexOf(':');
    if (colon <= 0) continue;
    const key = ln.slice(0, colon).trim();
    let val = ln.slice(colon + 1).trim();
    // Strip an unquoted trailing comment + surrounding quotes.
    if (/^["']/.test(val)) {
      const q = val[0];
      const end = val.indexOf(q, 1);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    } else {
      val = val.replace(/\s+#.*$/, '').trim();
    }
    if (!scalars.has(key)) {
      scalars.set(key, val);
      lines.set(key, i + 2); // +1 for the opening ---, +1 to make 1-based
    }
  }
  return { scalars, lines };
}

// ---------------------------------------------------------------------------
// Prose edges (the validate-xref upgrade, BR-DEP-002)
// ---------------------------------------------------------------------------

/**
 * Scan an artifact BODY (fenced code blocks stripped) for prose references:
 *   - markdown relative links ](../rules/x.md) -> references (resolved via pathToUid);
 *   - literal agents/<x>.md / skills/<y>/ path forms in inline backticks -> references;
 *   - BACKTICKED BARE NAMES `name` matched against the known-uid set, and the
 *     <x>-reviewer / <x>-agent heuristic -> routes-to (agent target). A bare name that
 *     matches a known rule id resolves to that rule (applies-rule).
 *
 * Self-references are dropped (an artifact backticking its own name is not an edge).
 *
 * @param {{uid:string,kind:string,id:string,path:string}} a
 * @param {string} text raw file text
 * @param {Set<string>} knownUids
 * @param {Map<string,Map<string,string>>} byKindId
 * @returns {Edge[]}
 */
function proseEdges(a, text, knownUids, byKindId) {
  /** @type {Edge[]} */
  const out = [];
  const { body, lineOffset } = bodyWithOffset(text);
  const stripped = stripFencedCodeBlocks(body);
  const docLines = stripped.split('\n');

  for (let i = 0; i < docLines.length; i++) {
    const line = docLines[i];
    // File-relative 1-based line: body line index + the lines consumed by the
    // frontmatter block, so a finding points at the real file line (e.g. 117).
    const lineNo = i + 1 + lineOffset;

    // (1) markdown relative link -> references (resolve via pathToUid against rootDir-rel).
    const linkRe = /\]\((\.{1,2}\/[^)\s#]+)(?:#[^)\s]*)?\)/g;
    let lm;
    while ((lm = linkRe.exec(line)) !== null) {
      const target = lm[1];
      const refUid = resolveRelLink(a.path, target);
      if (refUid && refUid !== a.uid) {
        out.push(edge(a.uid, knownUids.has(refUid) ? refUid : null, 'references', 'prose', target, 'link', [
          { path: a.path, line: lineNo },
        ]));
      }
    }

    // (2) backticked spans -> bare-name resolution + <x>-reviewer/<x>-agent heuristic.
    const tickRe = /`([^`]+)`/g;
    let tm;
    while ((tm = tickRe.exec(line)) !== null) {
      const span = tm[1].trim();
      // Bare token / path token only (no spaces).
      if (!/^[A-Za-z][-A-Za-z0-9_/.]*$/.test(span)) continue;

      // (2a) literal path form inside backticks: `agents/x.md` -> references.
      if (span.includes('/')) {
        const cls = pathToUidFromBare(stripClaudePrefix(span));
        if (cls) {
          const uid = `${cls.kind}:${cls.id}`;
          if (uid !== a.uid) {
            out.push(edge(a.uid, knownUids.has(uid) ? uid : null, 'references', 'prose', span, cls.kind, [
              { path: a.path, line: lineNo },
            ]));
          }
        }
        continue;
      }

      // (2b) bare name: resolve against the known index / heuristic.
      const res = resolveBareName(span, knownUids, byKindId);
      if (!res) continue;
      if (res.to === a.uid) continue; // self-ref
      out.push(edge(a.uid, res.to, res.type, 'prose', span, res.refKind, [{ path: a.path, line: lineNo }]));
    }
  }
  return out;
}

/**
 * Resolve a backticked bare name to a typed edge target. Order:
 *   - <x>-reviewer / <x>-agent heuristic -> an agent routes-to (resolved if the agent
 *     uid is known, else unresolved -> dangling);
 *   - a known agent id -> routes-to;
 *   - a known rule id -> applies-rule;
 *   - a known skill/command/bundle id -> references.
 * Returns null for a bare token that matches nothing and no heuristic (not every
 * backticked word is a reference).
 *
 * @param {string} name
 * @param {Set<string>} knownUids
 * @param {Map<string,Map<string,string>>} byKindId
 * @returns {{to:string|null, type:string, refKind:string}|null}
 */
function resolveBareName(name, knownUids, byKindId) {
  const agents = byKindId.get('agent') || new Map();
  const rules = byKindId.get('rule') || new Map();
  const skills = byKindId.get('skill') || new Map();
  const commands = byKindId.get('command') || new Map();
  const bundles = byKindId.get('bundle') || new Map();

  // Heuristic: <x>-reviewer / <x>-agent is an agent route, even when missing.
  if (REVIEWER_HEURISTIC.test(name) || AGENT_HEURISTIC.test(name)) {
    const uid = agents.get(name) || (knownUids.has(`agent:${name}`) ? `agent:${name}` : null);
    return { to: uid, type: 'routes-to', refKind: 'agent' };
  }

  if (agents.has(name)) return { to: agents.get(name) || null, type: 'routes-to', refKind: 'agent' };
  if (rules.has(name)) return { to: rules.get(name) || null, type: 'applies-rule', refKind: 'rule' };
  if (skills.has(name)) return { to: skills.get(name) || null, type: 'references', refKind: 'skill' };
  if (commands.has(name)) return { to: commands.get(name) || null, type: 'references', refKind: 'command' };
  if (bundles.has(name)) return { to: bundles.get(name) || null, type: 'references', refKind: 'bundle' };

  return null;
}

/**
 * Resolve a relative markdown link target (relative to the LINKING file) to a uid.
 * @param {string} fromRelPath repo-relative path of the linking file
 * @param {string} target ../rules/x.md
 * @returns {string|null}
 */
function resolveRelLink(fromRelPath, target) {
  try {
    const fromDir = path.posix.dirname(fromRelPath.split(path.sep).join('/'));
    const joined = path.posix.normalize(path.posix.join(fromDir, target));
    if (joined.startsWith('..')) return null;
    const cls = pathToUidFromBare(joined);
    return cls ? `${cls.kind}:${cls.id}` : null;
  } catch {
    return null;
  }
}

/**
 * pathToUid against a repo-relative path WITHOUT needing a rootDir (the path is already
 * repo-relative). Mirrors resolve-kind.pathToUid's switch on the leading segment.
 * @param {string} rel repo-relative posix path
 * @returns {{kind:string,id:string}|null}
 */
function pathToUidFromBare(rel) {
  if (typeof rel !== 'string' || rel === '') return null;
  const segs = rel.split('/');
  const top = segs[0];
  const base = segs[segs.length - 1];
  switch (top) {
    case 'agents':
      if (segs.length === 2 && base.endsWith('.md')) return { kind: 'agent', id: base.slice(0, -3) };
      return null;
    case 'skills':
      if (segs.length === 3 && base === 'SKILL.md') return { kind: 'skill', id: segs[1] };
      return null;
    case 'commands':
      if (segs.length === 2 && base.endsWith('.md')) return { kind: 'command', id: base.slice(0, -3) };
      return null;
    case 'rules':
      if (segs.length >= 2 && base.endsWith('.md')) return { kind: 'rule', id: base.slice(0, -3) };
      return null;
    case 'bundles':
      if (segs.length === 2 && base.endsWith('.md')) return { kind: 'bundle', id: base.slice(0, -3) };
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Construct an edge with a uniform shape. */
function edge(from, to, type, source, rawRef, refKind, sites) {
  return { from, to: to || null, type, source, rawRef, refKind, sites: Array.isArray(sites) ? sites : [] };
}

/**
 * Strip a leading `.claude/` (the plugin INSTALL location) so an install-path pointer
 * resolves to the same SOURCE artifact the registry indexes: `.claude/skills/run-eval/
 * SKILL.md` -> `skills/run-eval/SKILL.md` (-> skill:run-eval). A no-op for source-path
 * pointers. Also tolerates a leading `./`.
 * @param {string} p
 * @returns {string}
 */
function stripClaudePrefix(p) {
  if (typeof p !== 'string') return '';
  let s = p.replace(/^\.\//, '');
  if (s.startsWith('.claude/')) s = s.slice('.claude/'.length);
  return s;
}

/**
 * The document body after the frontmatter block (or the whole text if none) PLUS the
 * number of file lines the frontmatter block consumed (`lineOffset`), so prose findings
 * can report a FILE-relative line number. Tolerant of a BOM and CRLF.
 *
 * @param {string} text
 * @returns {{body:string, lineOffset:number}}
 */
function bodyWithOffset(text) {
  if (typeof text !== 'string') return { body: '', lineOffset: 0 };
  const clean = text.replace(/^\uFEFF/, '');
  const m = clean.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!m) return { body: clean, lineOffset: 0 };
  const body = m[1] ?? '';
  // lineOffset = total lines of `clean` minus lines of `body` (the frontmatter +
  // closing fence + the newline that begins the body). Counting via the prefix length
  // keeps it robust to CRLF.
  const prefixLen = clean.length - body.length;
  const prefix = clean.slice(0, prefixLen);
  const lineOffset = (prefix.match(/\n/g) || []).length;
  return { body, lineOffset };
}

/**
 * Replace fenced code blocks (``` or ~~~) with blank lines, preserving line numbers
 * (copied from validate-xref#stripFencedCodeBlocks so prose scanning matches it).
 * @param {string} content
 * @returns {string}
 */
function stripFencedCodeBlocks(content) {
  const lines = String(content).split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      out.push('');
      if (m && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (m) {
      fence = m[1].slice(0, 3);
      out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Read + parse JSON fail-soft. */
function readJsonSafe(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Dedupe sites by path+line. */
function dedupeSites(sites) {
  const seen = new Set();
  const out = [];
  for (const s of sites) {
    if (!s || typeof s.path !== 'string') continue;
    const line = Number.isInteger(s.line) ? s.line : null;
    const k = [s.path, line == null ? '' : String(line)].join('');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ path: s.path, line });
  }
  return out;
}

/** Sort sites by path then line (nulls first). */
function sortSites(sites) {
  return [...sites].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    const al = a.line == null ? -1 : a.line;
    const bl = b.line == null ? -1 : b.line;
    return al - bl;
  });
}

/** Stable edge ordering: from, to, type, source, rawRef. */
function edgeCmp(a, b) {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  const at = a.to == null ? '' : a.to;
  const bt = b.to == null ? '' : b.to;
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.rawRef < b.rawRef ? -1 : a.rawRef > b.rawRef ? 1 : 0;
}

export default { computeGraph };
