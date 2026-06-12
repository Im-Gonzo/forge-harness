// @ts-check
/**
 * tailor — the manager's per-project TAILORING + OVERLAY operator (ADR-0021).
 *
 * GROUNDING IN THE BACKBONE. A TAILORING OVERLAY is a per-ADOPTED-resource modifier layered ON
 * TOP of an entry in the project's COMPOSITION (ADR-0019). Only an ADOPTED resource — a
 * `(uid, sourceId)` pair present in `.forge/composition.json` — may be tailored; `tailor add`
 * validates membership by REUSING the compose read-view (manager/compose.mjs `run('list')`) and
 * never widens that gate, and never adopts as a side effect (tailor != adopt, just as adopt !=
 * admit). The same uid adopted from the library (sourceId === null) and from a source are two
 * DISTINCT tailored entries (the (uid, sourceId) identity, BR-CAT-015).
 *
 * OVERLAYS ARE RECORDED INTENTIONS (BR-CAT-014). An overlay is a single `{ type, detail }` where
 * `type ∈ pin | override | layer | gate | fork | disable`. Overlays are NOT applied to real
 * `.claude/` files in this slice — application is deferred to Slice 5 (compose --write). The CLI
 * folds the overlays over the base catalog record to compute a deterministic RESOLVED PREVIEW —
 * a display-only VIEW `{ model, residency, activation, body, status, version }` — and that is all
 * it does to a resource: it never mutates the library or any file outside the tailoring store.
 *
 * RESOLVED-PREVIEW FOLD (ADR-0021 §3, BR-CAT-014). Folding over the base record:
 *   - pin      -> version = the pin detail
 *   - override -> parse "field → value"; set that field (e.g. model = "opus")
 *   - gate     -> activation = the gate detail (else "default")
 *   - fork     -> body = "forked · local edits"
 *   - layer    -> body = "source + project layer"
 *   - disable  -> status = "disabled"
 *   - (none)   -> the field tracks its source (the base record value)
 * An unknown/unparseable detail LEAVES the base value and adds an INFO finding — never an error,
 * never a guess, never a fabricated value (the do-not-fabricate discipline ADR-0020 used for
 * `suggested`).
 *
 * PER-TYPE IDEMPOTENT DEDUPE (BR-CAT-016). pin/override/disable/fork keep at most ONE overlay per
 * type (a second add of that type REPLACES the prior detail — latest detail per type wins);
 * layer/gate MAY repeat but are deduped by the pair (type, detail). `remove` drops the matching
 * overlay(s) by type, optionally narrowed by detail; an absent overlay is a no-op.
 *
 * PERSISTENCE — a SEPARATE additive store beside the composition (BR-CAT-015). The only file this
 * module writes is, UNDER THE ACTIVE PROJECT ROOT: `<activeRoot>/.forge/tailoring.json`
 * (`forge.tailoring.v1`, schemas/tailoring.schema.json):
 *
 *   { "schema": "forge.tailoring.v1", "version": 1,
 *     "tailored": [ { "uid": "skill:code-review", "sourceId": "acme-skills",
 *                     "overlays": [ { "type": "pin", "detail": "v3.2.0" } ] } ] }
 *
 * It does NOT modify .forge/composition.json's schema; it attaches by the SAME (uid, sourceId)
 * identity. Writes are ADDITIVE + idempotent + never destructive (writeJsonAtomic via
 * lib/store.mjs); add/remove only touch the one entry's overlays. An entry whose resource is no
 * longer ADOPTED (an ORPHAN — e.g. after a compose remove or unsubscribe) is REPORTED as a WARN
 * and dropped from the listed set, but NEVER deleted from the file (BR-CAT-015).
 *
 * The two roots, kept STRICTLY separate (mirrors compose.mjs/conflict.mjs):
 *   - FORGE_ROOT  — this library's install location. The catalog record production we reuse
 *                   (via compose.mjs -> catalog.mjs) resolves it from its own module URL.
 *   - ACTIVE ROOT — the target PROJECT (ctx.cwd / ctx.root / process.cwd()). tailoring.json,
 *                   composition.json, and subscriptions.json are read HERE — per-project state.
 *
 * HARD INVARIANTS (the plugin payload contract): zero runtime deps (node: builtins + relative
 * imports only); additive-never-destructive; writers PREVIEW by default (write only under
 * `--apply`); fail-open (no public entry throws past its surface — it degrades to a safe
 * `{ok,data,findings,summary}` envelope). Dual-mode with an `isMain()` guard — NEVER
 * process.exit() at import time. NO model/judge invocation.
 *
 * Subcommands (C4 `run(subcmd, args, ctx)`):
 *   - `list`                                          — read tailoring.json, JOIN each entry to
 *                                                       its catalog record (via compose list) for
 *                                                       kind + base values; compute the resolved
 *                                                       preview; drop orphans (WARN, retained).
 *                                                       Read-only.
 *   - `add <uid> --type <t> --detail <s> [--source <id>] [--apply]`    — validate the resource is
 *                                                       ADOPTED + the type valid; record the
 *                                                       overlay (per-type dedupe). detail optional
 *                                                       for fork/disable. Preview by default.
 *   - `remove <uid> --type <t> [--detail <s>] [--source <id>] [--apply]` — drop matching overlay(s).
 *                                                       Idempotent. Preview by default.
 *
 * @module manager/tailor
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import { readJson, writeJsonAtomic } from './lib/store.mjs';
// REUSE the ADR-0019 composition operator (BR-CAT-015): `compose list` is the SAME read-view JOIN
// (composition entries joined to their catalog records) that the tailoring list needs for kind +
// base values, and its adopted set is exactly the gate `tailor add` validates against. We never
// re-scan and never duplicate the read-view derivation. Still a relative specifier (zerodep-clean).
import { run as composeRun } from './compose.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The emitter stamped on findings this module raises (C2 `tailor`). */
const SOURCE = 'tailor';

/** The on-disk tailoring schema tag (matches schemas/tailoring.schema.json). */
const SCHEMA_TAG = 'forge.tailoring.v1';

/** The tailoring file's current version integer. */
const SCHEMA_VERSION = 1;

/** The uid grammar "<kind>:<id>" (mirrors schemas/tailoring.schema.json#uid). */
const UID_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;

/** A source id grammar (mirrors schemas/tailoring.schema.json#sourceId string branch). */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** The CLOSED overlay type set (mirrors schemas/tailoring.schema.json#overlayType, ADR-0021 §2). */
const OVERLAY_TYPES = new Set(['pin', 'override', 'layer', 'gate', 'fork', 'disable']);

/** Single-per-type overlays: a second add REPLACES the prior detail (BR-CAT-016). */
const SINGLE_PER_TYPE = new Set(['pin', 'override', 'disable', 'fork']);

/** Types whose detail is OPTIONAL (MAY be "" — BR-CAT-014). */
const DETAIL_OPTIONAL = new Set(['fork', 'disable']);

// ---------------------------------------------------------------------------
// Root + path resolution (mirrors compose.mjs)
// ---------------------------------------------------------------------------

/**
 * The ACTIVE PROJECT root the tailoring file lives under. Mirrors compose.mjs: ctx.cwd / ctx.root,
 * else the process cwd. Tailoring is per-project state (ADR-0021 §5).
 * @param {any} ctx @returns {string}
 */
function resolveActiveRoot(ctx) {
  return (ctx && (ctx.cwd || ctx.root)) || process.cwd();
}

/** The tailoring file path under the active root (the only file this module writes). */
function tailoringPath(activeRoot) {
  return path.join(activeRoot, '.forge', 'tailoring.json');
}

/** Project-relative tailoring path for finding paths (fail-open). */
function relTailoring(activeRoot) {
  try {
    return path.relative(activeRoot, tailoringPath(activeRoot)) || tailoringPath(activeRoot);
  } catch {
    return path.join('.forge', 'tailoring.json');
  }
}

/** Best-effort FORGE library root = two levels up from this module (manager/..). */
function selfForgeRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

// ---------------------------------------------------------------------------
// Tailoring reads (forge.tailoring.v1)
// ---------------------------------------------------------------------------

/** A fresh, empty tailoring object (the initial shape). */
function emptyTailoring() {
  return { schema: SCHEMA_TAG, version: SCHEMA_VERSION, tailored: [] };
}

/**
 * Read + normalize the tailoring file. An ABSENT file degrades to a fresh empty set (the additive
 * contract: we may create it). A present-but-malformed file degrades to `{ malformed:true }` so a
 * writer can refuse to edit. Each tailored entry is normalized to
 * `{ uid:string, sourceId:string|null, overlays:{type,detail}[] }` (non-string uids dropped; a
 * non-string sourceId coerced to null = library-local; overlays normalized + deduped per type).
 * Fail-open: never throws.
 *
 * @param {string} activeRoot
 * @returns {{ tail:{schema:string,version:number,tailored:{uid:string,sourceId:string|null,overlays:{type:string,detail:string}[]}[]}, existed:boolean, malformed:boolean }}
 */
function readTailoring(activeRoot) {
  const abs = tailoringPath(activeRoot);
  let existed = false;
  try {
    existed = fs.statSync(abs).isFile();
  } catch {
    existed = false;
  }
  if (!existed) {
    return { tail: emptyTailoring(), existed: false, malformed: false };
  }
  const parsed = readJson(abs);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { tail: emptyTailoring(), existed: true, malformed: true };
  }
  const rawTailored = Array.isArray(parsed.tailored) ? parsed.tailored : [];
  /** @type {Map<string,{uid:string,sourceId:string|null,overlays:{type:string,detail:string}[]}>} */
  const byKey = new Map();
  for (const e of rawTailored) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (typeof e.uid !== 'string' || !e.uid) continue;
    const sourceId = typeof e.sourceId === 'string' && e.sourceId ? e.sourceId : null;
    const overlays = dedupeOverlays(normalizeOverlays(e.overlays));
    const key = entryKey(e.uid, sourceId);
    // Merge duplicate (uid, sourceId) entries on read (fold their overlays), so a hand-edited file
    // with two blocks for one resource collapses deterministically.
    const prior = byKey.get(key);
    if (prior) prior.overlays = dedupeOverlays([...prior.overlays, ...overlays]);
    else byKey.set(key, { uid: e.uid, sourceId, overlays });
  }
  return {
    tail: {
      schema: typeof parsed.schema === 'string' ? parsed.schema : SCHEMA_TAG,
      version: typeof parsed.version === 'number' ? parsed.version : SCHEMA_VERSION,
      tailored: [...byKey.values()],
    },
    existed: true,
    malformed: false,
  };
}

/** Normalize a raw overlays array into `{type:string,detail:string}[]` (drop invalid types). */
function normalizeOverlays(raw) {
  const out = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const o of list) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    if (typeof o.type !== 'string' || !OVERLAY_TYPES.has(o.type)) continue;
    const detail = typeof o.detail === 'string' ? o.detail : '';
    out.push({ type: o.type, detail });
  }
  return out;
}

/**
 * Apply the per-type dedupe (BR-CAT-016) to an overlay list, preserving record order:
 *   - pin/override/disable/fork: keep at most ONE per type — the LATEST detail wins.
 *   - layer/gate: MAY repeat but are deduped by the pair (type, detail).
 * @param {{type:string,detail:string}[]} overlays @returns {{type:string,detail:string}[]}
 */
function dedupeOverlays(overlays) {
  /** @type {Map<string,{type:string,detail:string}>} single-per-type -> the latest */
  const single = new Map();
  /** @type {Set<string>} (type|detail) keys already seen for repeatable types */
  const seenPair = new Set();
  /** @type {{type:string,detail:string}[]} repeatable overlays in first-seen order */
  const repeatable = [];
  for (const o of overlays) {
    if (SINGLE_PER_TYPE.has(o.type)) {
      single.set(o.type, o); // latest detail per type wins
    } else {
      const k = `${o.type}|${o.detail}`;
      if (seenPair.has(k)) continue;
      seenPair.add(k);
      repeatable.push(o);
    }
  }
  // Deterministic order: by type, then detail (single-per-type and repeatable merged + sorted).
  const merged = [...single.values(), ...repeatable];
  merged.sort(compareOverlay);
  return merged;
}

/** Deterministic overlay order: by type, then by detail. */
function compareOverlay(a, b) {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
}

/**
 * The deterministic on-disk shape: schema/version stamped, `tailored` deduped on (uid,sourceId),
 * each entry's overlays deduped per type, sorted by uid then sourceId. Entries with NO overlays
 * are dropped (an empty overlay set is not a meaningful tailoring — removal collapses to nothing).
 * @param {{uid:string,sourceId:string|null,overlays:{type:string,detail:string}[]}[]} tailored
 */
function normalizeForWrite(tailored) {
  /** @type {Map<string,{uid:string,sourceId:string|null,overlays:{type:string,detail:string}[]}>} */
  const byKey = new Map();
  for (const e of tailored) {
    if (!e || typeof e.uid !== 'string' || !e.uid) continue;
    const sourceId = typeof e.sourceId === 'string' && e.sourceId ? e.sourceId : null;
    const overlays = dedupeOverlays(normalizeOverlays(e.overlays));
    if (overlays.length === 0) continue; // drop empty entries (no meaningful tailoring)
    const key = entryKey(e.uid, sourceId);
    const prior = byKey.get(key);
    if (prior) prior.overlays = dedupeOverlays([...prior.overlays, ...overlays]);
    else byKey.set(key, { uid: e.uid, sourceId, overlays });
  }
  const list = [...byKey.values()];
  list.sort(compareEntries);
  return { schema: SCHEMA_TAG, version: SCHEMA_VERSION, tailored: list };
}

/** The collision-safe key for a (uid, sourceId) pair (null sourceId -> the sentinel ' '). */
function entryKey(uid, sourceId) {
  return `${uid} ${sourceId === null ? ' ' : sourceId}`;
}

/** Deterministic order: by uid, then by sourceId (null first). */
function compareEntries(a, b) {
  if (a.uid !== b.uid) return a.uid < b.uid ? -1 : 1;
  const sa = a.sourceId;
  const sb = b.sourceId;
  if (sa === sb) return 0;
  if (sa === null) return -1;
  if (sb === null) return 1;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Composition read-view reuse (the adoption gate + base-value JOIN, BR-CAT-015)
// ---------------------------------------------------------------------------

/**
 * Ask the compose operator to LIST the project's adopted resources, JOINed to their catalog
 * records. We REUSE manager/compose.mjs `run('list')` verbatim (ADR-0021 §4) — the adopted set is
 * exactly the tailorability gate, and each entry already carries the base values (kind/version/
 * criticality) the resolved preview folds over. Fail-open: any failure degrades to an empty adopted
 * list + a WARN finding (the tailoring list is still a valid, empty envelope).
 *
 * Returns a Map keyed by `entryKey(uid, sourceId)` -> the joined composition entry
 * `{ uid, kind, sourceId, version, criticality }`.
 *
 * @param {string} activeRoot
 * @returns {Promise<{ byKey:Map<string,any>, findings:import('./lib/findings.mjs').Finding[] }>}
 */
async function adoptedByKey(activeRoot) {
  const findings = [];
  /** @type {Map<string, any>} */
  const byKey = new Map();
  try {
    const res = await composeRun('list', [], { cwd: activeRoot });
    const adopted = res && res.data && Array.isArray(res.data.adopted) ? res.data.adopted : [];
    for (const e of adopted) {
      if (!e || typeof e.uid !== 'string' || !e.uid) continue;
      const sourceId = typeof e.sourceId === 'string' && e.sourceId ? e.sourceId : null;
      byKey.set(entryKey(e.uid, sourceId), { ...e, sourceId });
    }
  } catch (e) {
    findings.push(finding('WARN', 'tailor', `compose list failed: ${e && e.message ? e.message : String(e)} — empty adopted set`));
  }
  return { byKey, findings };
}

// ---------------------------------------------------------------------------
// Resolved preview — the deterministic fold (ADR-0021 §3, BR-CAT-014)
// ---------------------------------------------------------------------------

/**
 * Compute the base resolved values from a JOINed composition entry. The catalog record carries
 * `version`, `status`, `criticality`, and `kind`; `model`/`residency`/`activation`/`body` are not
 * catalog fields, so they take documented, prototype-consistent defaults (proto-data.js `R()`:
 * model="sonnet", residency="conditional", status="active"). `activation` defaults to "default"
 * (the gate fold's else branch), and `body` to "source" (the field tracks its source).
 * @param {any} entry @returns {{model:string,residency:string,activation:string,body:string,status:string,version:string}}
 */
function baseResolved(entry) {
  const e = entry || {};
  return {
    model: typeof e.model === 'string' && e.model ? e.model : 'sonnet',
    residency: typeof e.residency === 'string' && e.residency ? e.residency : 'conditional',
    activation: typeof e.activation === 'string' && e.activation ? e.activation : 'default',
    body: typeof e.body === 'string' && e.body ? e.body : 'source',
    status: typeof e.status === 'string' && e.status ? e.status : 'active',
    version: typeof e.version === 'string' && e.version ? e.version : (e.version != null ? String(e.version) : ''),
  };
}

/** The frontmatter fields an `override` overlay may set in the resolved preview. */
const OVERRIDE_FIELDS = new Set(['model', 'residency', 'activation', 'status', 'version', 'criticality']);

/**
 * Fold the overlays over the base record to compute the deterministic RESOLVED PREVIEW (a
 * display-only VIEW, BR-CAT-014). The fold is total + documented (ADR-0021 §3); an unknown or
 * unparseable detail LEAVES the base value and adds an INFO finding (never errors, never guesses,
 * never fabricates). Overlays apply in their (already-deterministic) record order.
 *
 * @param {any} entry The JOINed composition entry (base values).
 * @param {{type:string,detail:string}[]} overlays
 * @returns {{ resolved:{model:string,residency:string,activation:string,body:string,status:string,version:string}, findings:import('./lib/findings.mjs').Finding[] }}
 */
function resolvePreview(entry, overlays) {
  const resolved = baseResolved(entry);
  const findings = [];
  const uid = entry && entry.uid ? entry.uid : '(unknown)';
  for (const o of overlays) {
    switch (o.type) {
      case 'pin': {
        const d = o.detail.trim();
        if (d) resolved.version = d;
        else findings.push(finding('INFO', 'tailor', `pin overlay on "${uid}" has no version detail — leaving base version "${resolved.version}"`));
        break;
      }
      case 'override': {
        const parsed = parseOverride(o.detail);
        if (!parsed) {
          findings.push(finding('INFO', 'tailor', `override overlay on "${uid}" detail "${o.detail}" is not "field → value" — leaving base values`));
        } else if (!OVERRIDE_FIELDS.has(parsed.field)) {
          findings.push(finding('INFO', 'tailor', `override overlay on "${uid}" targets unknown field "${parsed.field}" — leaving base values (known: ${[...OVERRIDE_FIELDS].sort().join(', ')})`));
        } else {
          resolved[parsed.field] = parsed.value;
        }
        break;
      }
      case 'gate': {
        const d = o.detail.trim();
        resolved.activation = d || 'default';
        break;
      }
      case 'fork':
        resolved.body = 'forked · local edits';
        break;
      case 'layer':
        resolved.body = 'source + project layer';
        break;
      case 'disable':
        resolved.status = 'disabled';
        break;
      default:
        findings.push(finding('INFO', 'tailor', `unknown overlay type "${o.type}" on "${uid}" — ignored`));
    }
  }
  return { resolved, findings };
}

/**
 * Parse an `override` detail "field → value" (the arrow is U+2192 RIGHTWARDS ARROW; we also accept
 * the ASCII "->" for ergonomics). Returns `{ field, value }` (trimmed) or null when there is no
 * arrow. Both sides must be non-empty.
 * @param {string} detail @returns {{field:string,value:string}|null}
 */
function parseOverride(detail) {
  const s = typeof detail === 'string' ? detail : '';
  let idx = s.indexOf('→'); // "→"
  let arrowLen = 1;
  if (idx < 0) {
    idx = s.indexOf('->');
    arrowLen = 2;
  }
  if (idx < 0) return null;
  const field = s.slice(0, idx).trim();
  const value = s.slice(idx + arrowLen).trim();
  if (!field || !value) return null;
  return { field, value };
}

// ---------------------------------------------------------------------------
// normalize — mirrors compose.mjs#normalize (with --type + --detail value-opts)
// ---------------------------------------------------------------------------

/**
 * Normalise `ctx`/`args` to { apply, source, type, detail, detailGiven, positional, flags }.
 * `--source <id>`, `--type <t>`, and `--detail <s>` are value-opts; `--apply` is the write toggle.
 * A trailing non-flag positional after the verb is the uid (add/remove). `detailGiven` records
 * whether `--detail` was present (even as ""), so add/remove can distinguish "no detail" from an
 * intentional empty detail (fork/disable).
 */
function normalize(args, ctx) {
  const flags = new Set();
  const positional = [];
  /** @type {Record<string,string>} */
  const opts = {};
  const given = new Set();
  const argList = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  const VALUE_OPTS = new Set(['source', 'type', 'detail']);
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
        given.add(name);
      } else if (VALUE_OPTS.has(name) && i + 1 < argList.length && !String(argList[i + 1]).startsWith('--')) {
        opts[name] = String(argList[i + 1]);
        given.add(name);
        i++;
      } else if (VALUE_OPTS.has(name)) {
        // present with no value (e.g. trailing `--detail`) — treat as an empty value but "given".
        opts[name] = '';
        given.add(name);
      }
    } else {
      positional.push(a);
    }
  }
  if (ctx && ctx.flags instanceof Set) for (const f of ctx.flags) flags.add(f);
  const apply = flags.has('apply') || flags.has('write') || (ctx && (ctx.apply === true || ctx.write === true));
  const sourceRaw = opts.source != null ? opts.source : (ctx && ctx.opts && ctx.opts.source) || null;
  const source = typeof sourceRaw === 'string' && sourceRaw.length > 0 ? sourceRaw : null;
  const type = typeof opts.type === 'string' && opts.type.length > 0 ? opts.type : null;
  const detail = given.has('detail') ? opts.detail : (ctx && ctx.opts && typeof ctx.opts.detail === 'string' ? ctx.opts.detail : null);
  const detailGiven = given.has('detail') || (ctx && ctx.opts && typeof ctx.opts.detail === 'string');
  return { apply: !!apply, source, type, detail, detailGiven: !!detailGiven, positional, flags };
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr. Returns `{ ok, data, findings, summary }`. Fail-open: any
 * internal failure degrades to an ok-ish empty result, never a throw.
 *
 * `list` writes NOTHING. `add`/`remove` write ONLY `.forge/tailoring.json` under the active root
 * and ONLY under `--apply`; the default is always a preview. NO model invocation, and NO `.claude/`
 * file or library record is ever touched (the resolved preview is a VIEW — application is Slice 5).
 *
 * @param {string} subcmd list | add | remove
 * @param {any} args string[] | { positional, flags, opts }
 * @param {any} ctx { cwd?, root?, flags?, opts?, apply?, write? }
 * @returns {Promise<{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const n = normalize(args, ctx);
    const activeRoot = resolveActiveRoot(ctx);
    switch (subcmd) {
      case 'list':
        return await doList(activeRoot);
      case 'add':
        return await doMutate(activeRoot, n.positional[0] || null, n.source, n.type, n.detail, n.detailGiven, n.apply, 'add');
      case 'remove':
        return await doMutate(activeRoot, n.positional[0] || null, n.source, n.type, n.detail, n.detailGiven, n.apply, 'remove');
      default:
        return result(false, { usage: usageText() }, [
          finding('ERROR', 'tailor', `unknown tailor subcommand: ${subcmd || '(none)'}`),
        ]);
    }
  } catch (e) {
    return result(false, null, [
      finding('ERROR', 'tailor', `tailor error: ${e && e.message ? e.message : String(e)}`),
    ]);
  }
}

/**
 * `list` — read tailoring.json, JOIN each tailored (uid, sourceId) entry to its ADOPTED
 * composition record (reusing `compose list`) for kind + base values, fold the overlays into a
 * resolved preview, sorted deterministically by uid then sourceId. An entry whose resource is no
 * longer ADOPTED (an ORPHAN — e.g. after a compose remove or unsubscribe) is surfaced as a WARN
 * and dropped from the listed set, but NEVER deleted from the file (BR-CAT-015). Read-only.
 *
 * Returns `data { tailoringPath, tailored:[ { uid, sourceId, kind, overlays:[{type,detail}],
 * resolved:{...} } ], counts:{ tailored, overlays } }` (ADR-0021 §6).
 */
async function doList(activeRoot) {
  const findings = [];
  const { tail, existed, malformed } = readTailoring(activeRoot);
  if (malformed) {
    findings.push(finding('WARN', relTailoring(activeRoot), 'tailoring.json is not a JSON object — treating as empty'));
  } else if (!existed) {
    findings.push(finding('INFO', relTailoring(activeRoot), 'no tailoring file yet — nothing tailored (opt-in)'));
  }

  const { byKey, findings: adoptFindings } = await adoptedByKey(activeRoot);
  for (const f of adoptFindings) findings.push(f);

  const tailored = [];
  let overlayCount = 0;
  for (const e of tail.tailored) {
    const key = entryKey(e.uid, e.sourceId);
    const adopted = byKey.get(key);
    if (!adopted) {
      findings.push(finding('WARN', relTailoring(activeRoot),
        `tailored "${e.uid}"${e.sourceId ? ` (source "${e.sourceId}")` : ' (library-local)'} is no longer adopted (orphan) — listed-out but retained; \`forge tailor remove\` to drop it (BR-CAT-015)`));
      continue;
    }
    const overlays = dedupeOverlays(e.overlays);
    const { resolved, findings: foldFindings } = resolvePreview(adopted, overlays);
    for (const f of foldFindings) findings.push(f);
    overlayCount += overlays.length;
    tailored.push({
      uid: e.uid,
      sourceId: e.sourceId,
      kind: typeof adopted.kind === 'string' ? adopted.kind : '',
      overlays,
      resolved,
    });
  }
  tailored.sort(compareEntries);

  return result(true, {
    tailoringPath: tailoringPath(activeRoot),
    tailored,
    counts: { tailored: tailored.length, overlays: overlayCount },
  }, findings, {
    tailored: tailored.length,
    overlays: overlayCount,
  });
}

/**
 * Shared add/remove core. Validates the uid + overlay type, resolves the target (uid, sourceId),
 * and — for ADD — validates the resource is ADOPTED (reusing the compose read-view, BR-CAT-015);
 * REMOVE does NOT consult adoption (an orphan must stay editable/removable). Computes the additive
 * overlay change with the per-type dedupe (BR-CAT-016) and (under --apply) persists it atomically.
 *
 * Returns a plan `data { uid, sourceId, type, detail, tailoringPath, applied, written, action,
 * changed, overlays:[…], plan:{changed} }` so the preview and the apply share one shape.
 *
 * @param {string} activeRoot @param {string|null} uid @param {string|null} source
 * @param {string|null} type @param {string|null} detail @param {boolean} detailGiven
 * @param {boolean} apply @param {'add'|'remove'} action
 */
async function doMutate(activeRoot, uid, source, type, detail, detailGiven, apply, action) {
  const findings = [];
  if (!uid) {
    return result(false, { usage: usageText() }, [
      finding('ERROR', 'tailor', `${action} requires a <uid> argument ("<kind>:<id>", e.g. "skill:code-review")`),
    ]);
  }
  if (!UID_RE.test(uid)) {
    return result(false, { uid, action, plan: { changed: false } }, [
      finding('ERROR', 'tailor', `invalid uid "${uid}" (must be "<kind>:<id>", e.g. "skill:code-review")`),
    ]);
  }
  if (source !== null && !SOURCE_ID_RE.test(source)) {
    return result(false, { uid, sourceId: source, action, plan: { changed: false } }, [
      finding('ERROR', 'tailor', `invalid --source "${source}" (a source id like "acme-skills", or omit for the library-local copy)`),
    ]);
  }
  if (!type) {
    return result(false, { uid, sourceId: source, action, plan: { changed: false } }, [
      finding('ERROR', 'tailor', `${action} requires --type <${[...OVERLAY_TYPES].join('|')}>`),
    ]);
  }
  if (!OVERLAY_TYPES.has(type)) {
    return result(false, { uid, sourceId: source, type, action, plan: { changed: false } }, [
      finding('ERROR', 'tailor', `invalid overlay type "${type}" (must be one of ${[...OVERLAY_TYPES].join('|')})`),
    ]);
  }

  // detail handling: REQUIRED for pin/override/layer/gate; OPTIONAL (MAY be "") for fork/disable.
  // For ADD, an absent --detail on a required type is an ERROR; absent on an optional type -> "".
  let effectiveDetail = detailGiven && typeof detail === 'string' ? detail : '';
  if (action === 'add' && !DETAIL_OPTIONAL.has(type) && (!detailGiven || effectiveDetail.trim() === '')) {
    return result(false, { uid, sourceId: source, type, action, plan: { changed: false } }, [
      finding('ERROR', 'tailor', `overlay type "${type}" requires --detail <s> (e.g. ${detailHint(type)})`),
    ]);
  }

  const { tail, malformed } = readTailoring(activeRoot);
  if (malformed) {
    return result(false, { uid, sourceId: source, type, action, plan: { changed: false } }, [
      finding('ERROR', relTailoring(activeRoot), 'tailoring.json is not a JSON object — refusing to edit'),
    ]);
  }

  const sourceId = source;
  const targetKey = entryKey(uid, sourceId);
  const where = sourceId === null ? '(library-local)' : `(source "${sourceId}")`;

  // ADD validates the resource is ADOPTED (BR-CAT-015). REMOVE does not (orphans stay removable).
  if (action === 'add') {
    const { byKey, findings: adoptFindings } = await adoptedByKey(activeRoot);
    for (const f of adoptFindings) findings.push(f);
    if (!byKey.has(targetKey)) {
      return result(false, { uid, sourceId, type, action, plan: { changed: false } }, [
        ...findings,
        finding('ERROR', 'tailor', `"${uid}" ${where} is not ADOPTED in this project's composition — only adopted resources are tailorable. Adopt it first (forge compose adopt "${uid}"${sourceId ? ` --source ${sourceId}` : ''} --apply), then tailor (BR-CAT-015).`),
      ]);
    }
  }

  // Locate (or, for add, create) the entry for (uid, sourceId) and apply the overlay change.
  const entries = tail.tailored.map((e) => ({ uid: e.uid, sourceId: e.sourceId, overlays: e.overlays.slice() }));
  let entry = entries.find((e) => entryKey(e.uid, e.sourceId) === targetKey) || null;
  let changed = false;
  const overlay = { type, detail: effectiveDetail };

  if (action === 'add') {
    if (!entry) {
      entry = { uid, sourceId, overlays: [] };
      entries.push(entry);
    }
    const before = entry.overlays.slice();
    // Append + dedupe: for single-per-type a second add REPLACES the prior detail; layer/gate dedupe
    // by (type, detail) so an identical repeat is a no-op (BR-CAT-016).
    entry.overlays = dedupeOverlays([...entry.overlays, overlay]);
    changed = !overlaysEqual(before, entry.overlays);
    if (changed) {
      findings.push(finding('INFO', 'tailor', `add overlay {${type}${effectiveDetail ? `: "${effectiveDetail}"` : ''}} to "${uid}" ${where} (intention only — not applied to .claude/ here; ADR-0021 §3)`));
    } else {
      findings.push(finding('WARN', relTailoring(activeRoot), `overlay {${type}${effectiveDetail ? `: "${effectiveDetail}"` : ''}} on "${uid}" ${where} already recorded — no change (idempotent)`));
    }
  } else {
    // REMOVE: drop matching overlay(s) by type, optionally narrowed by detail. Absent -> no-op WARN.
    if (!entry) {
      findings.push(finding('WARN', relTailoring(activeRoot), `"${uid}" ${where} has no tailoring — nothing to remove (idempotent)`));
    } else {
      const before = entry.overlays.slice();
      entry.overlays = entry.overlays.filter((o) => {
        if (o.type !== type) return true;
        if (detailGiven && typeof detail === 'string') return o.detail !== detail; // narrowed by detail
        return false; // drop all of this type
      });
      changed = !overlaysEqual(before, entry.overlays);
      if (changed) {
        findings.push(finding('INFO', 'tailor', `remove overlay(s) {${type}${detailGiven ? `: "${detail}"` : ''}} from "${uid}" ${where}`));
      } else {
        findings.push(finding('WARN', relTailoring(activeRoot), `no {${type}${detailGiven ? `: "${detail}"` : ''}} overlay on "${uid}" ${where} — nothing to remove (idempotent)`));
      }
    }
  }

  const nextTailored = entries;
  const normalized = normalizeForWrite(nextTailored);

  let written = false;
  if (apply && changed) {
    written = writeJsonAtomic(tailoringPath(activeRoot), normalized);
    if (!written) findings.push(finding('WARN', relTailoring(activeRoot), 'could not write tailoring.json'));
  } else if (!apply && changed) {
    findings.push(finding('INFO', relTailoring(activeRoot), 'dry-run: pass --apply to write the change'));
  }

  // The surviving overlays for THIS entry (after normalize), for the plan/preview shape.
  const survivor = normalized.tailored.find((e) => entryKey(e.uid, e.sourceId) === targetKey);
  const overlays = survivor ? survivor.overlays : [];

  return result(true, {
    uid,
    sourceId,
    type,
    detail: effectiveDetail,
    tailoringPath: tailoringPath(activeRoot),
    applied: !!apply,
    written,
    action,
    changed,
    overlays,
    plan: { changed },
  }, findings, {
    [action]: changed ? 1 : 0,
    written: written ? 1 : 0,
  });
}

/** Structural equality of two overlay lists (order-insensitive after dedupe). */
function overlaysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = a.slice().sort(compareOverlay);
  const sb = b.slice().sort(compareOverlay);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i].type !== sb[i].type || sa[i].detail !== sb[i].detail) return false;
  }
  return true;
}

/** A short example detail for an error message, per type. */
function detailHint(type) {
  switch (type) {
    case 'pin': return '"v3.2.0"';
    case 'override': return '"model → opus"';
    case 'layer': return '"+ project rule fragment"';
    case 'gate': return '"paths: src/**"';
    default: return '"…"';
  }
}

/**
 * C4 `summarize(state)` — pure; map a run-state to a one-panel summary. Returns a `(no data)` panel
 * when no tailored array is present (fail-open).
 * @param {any} state @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  const tailored = state && typeof state === 'object' && Array.isArray(state.tailored) ? state.tailored : null;
  if (!tailored) {
    return makePanel({ panel: 'tailor', ok: false, lines: ['(no data)'], hint: 'forge tailor list' });
  }
  let overlays = 0;
  for (const t of tailored) if (t && Array.isArray(t.overlays)) overlays += t.overlays.length;
  return makePanel({
    panel: 'tailor',
    ok: true,
    lines: [`${tailored.length} tailored`, `${overlays} overlay${overlays === 1 ? '' : 's'}`],
  });
}

/** Build a Panel with a non-enumerable toString (mirrors compose.mjs#makePanel). */
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

/** Stamp a C2 finding from this module (tailor pre-filled). */
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
    'forge tailor list [--json]',
    'forge tailor add <uid> --type <pin|override|layer|gate|fork|disable> --detail <s> [--source <id>] [--apply]',
    'forge tailor remove <uid> --type <t> [--detail <s>] [--source <id>] [--apply]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Human render (print side)
// ---------------------------------------------------------------------------

/**
 * Render a ModuleResult as human text (print side). Returns the exit code. PRINT happens ONLY in
 * the script entry; run() never writes stdout.
 * @param {string} subcmd @param {{ok:boolean,data:any,findings:any[],summary:any}} res @returns {number}
 */
function renderHuman(subcmd, res) {
  const out = [];
  const data = res.data || {};
  if (data.usage) {
    out.push(data.usage);
  } else if (subcmd === 'list') {
    const tailored = Array.isArray(data.tailored) ? data.tailored : [];
    if (tailored.length === 0) out.push('tailor: nothing tailored (forge tailor add <uid> --type <t> --detail <s>)');
    for (const t of tailored) {
      const src = t.sourceId === null ? 'library-local' : t.sourceId;
      const ov = (t.overlays || []).map((o) => `${o.type}${o.detail ? `=${o.detail}` : ''}`).join(', ');
      const r = t.resolved || {};
      out.push(`  ${t.uid}\t${t.kind || '?'}\t${src}\t[${ov}]\tresolved: model=${r.model} status=${r.status} version=${r.version} activation=${r.activation} body=${r.body}`);
    }
  } else if (subcmd === 'add' || subcmd === 'remove') {
    const where = data.sourceId === null || data.sourceId === undefined ? '(library-local)' : `(source "${data.sourceId}")`;
    out.push(`tailor ${subcmd} ${data.uid || ''} ${where} {${data.type || ''}${data.detail ? `: "${data.detail}"` : ''}}: ${data.changed ? 'changed' : 'no change'}${data.applied ? `, ${data.written ? 'written' : (data.changed ? 'not written' : 'nothing to write')}` : (data.changed ? ' (preview — pass --apply)' : '')}`);
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
//   node manager/tailor.mjs <subcmd> [flags] [uid]
// Renders human text, or the C3 --json envelope under --json. PRINT happens ONLY here.
// NEVER process.exit() at import time — the isMain() guard protects the node:test runner.
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
  // The active root is the process cwd (bin/forge.mjs runs us in the project cwd).
  run(subcmd, rest, { cwd: process.cwd() })
    .then((res) => {
      if (json) {
        const env = envelope({
          command: `tailor ${subcmd || ''}`.trim(),
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
