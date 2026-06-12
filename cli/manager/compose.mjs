// @ts-check
/**
 * compose — the manager's per-project COMPOSITION + ADOPTION operator (ADR-0019).
 *
 * RELATION TO THE BACKBONE. The existing `catalog admit -> library` path is UNCHANGED:
 * admit still promotes a catalog record into the global, git-tracked LIBRARY (ADR-0017).
 * This module adds a SEPARATE, ADDITIVE per-project layer — the COMPOSITION — beside it.
 * ADOPT != ADMIT: adopt does NOT write the library, run the admission pipeline, or consult
 * the T2 gate. It only RECORDS a per-project selection. Admission state never affects
 * adoptability (BR-CAT-008).
 *
 * A COMPOSITION is the per-active-root set of resources a project has ADOPTED from its
 * catalog READ-VIEW. An adopted entry is identified by the PAIR (uid, sourceId), where
 * `sourceId === null` is the library-local copy and a non-null `sourceId` is the source the
 * resource was adopted from. The same uid adopted from the library and from a source are two
 * DISTINCT entries (BR-CAT-007).
 *
 * The READ-VIEW (ADR-0018 §"read-view", BR-CAT-006) is exactly the gate adopt validates
 * against: a resource is adoptable IFF it is
 *   - LIBRARY-LOCAL  (catalog record source === null), which is ALWAYS in the read-view; OR
 *   - SUBSCRIBED     (a source record whose slice id "<sourceId>/<kind>" is in the project's
 *                     .forge/subscriptions.json `subscribed` set).
 * We derive this read-view by REUSING the catalog operator's record production
 * (manager/catalog.mjs `run('build')`) — exactly as manager/slices.mjs does — and filtering
 * to library-local ∪ subscribed-slice records. We never re-scan; the read-view is a pure
 * function of the catalog records + the subscription set, so it matches the slice view
 * byte-for-byte.
 *
 * PERSISTENCE. The only file this module writes is, UNDER THE ACTIVE PROJECT ROOT (not the
 * git-tracked library): `<activeRoot>/.forge/composition.json`
 * (`forge.composition.v1`, schemas/composition.schema.json):
 *
 *   { "schema": "forge.composition.v1", "version": 1,
 *     "adopted": [ { "uid": "agent:hello", "sourceId": "fx" },
 *                  { "uid": "skill:greet", "sourceId": null } ] }
 *
 * A newly-visible resource defaults UNADOPTED (opt-in, consistent with slices defaulting
 * unsubscribed — ADR-0018, and sources defaulting untrusted — ADR-0017). Writes are
 * ADDITIVE + idempotent + never destructive (writeJsonAtomic via lib/store.mjs); adopt/remove
 * only add/drop the one (uid, sourceId) entry. An adopted entry whose resource is no longer
 * in the read-view (an ORPHAN — e.g. after the slice was unsubscribed) is REPORTED as a WARN
 * and dropped from the listed set, but NEVER deleted from the file (BR-CAT-009).
 *
 * The two roots, kept STRICTLY separate (mirrors slices.mjs/mcp.mjs/memory.mjs):
 *   - FORGE_ROOT  — this library's install location. The catalog record production we reuse
 *                   (catalog.mjs) resolves it from its own module URL; we never re-scan.
 *   - ACTIVE ROOT — the target PROJECT (ctx.cwd / ctx.root / process.cwd()). composition.json
 *                   AND subscriptions.json are read/written HERE — per-project state.
 *
 * HARD INVARIANTS (the plugin payload contract): zero runtime deps (node: builtins +
 * relative imports only — lint/validate-manager-zerodep.mjs enforces this);
 * additive-never-destructive; writers PREVIEW by default (write only under `--apply`);
 * fail-open (no public entry throws past its surface — it degrades to a safe
 * `{ok,data,findings,summary}` envelope). Dual-mode with an `isMain()` guard — NEVER
 * process.exit() at import time.
 *
 * Subcommands (C4 `run(subcmd, args, ctx)`):
 *   - `list`                              — read composition.json, JOIN each entry to its
 *                                           catalog record to resolve kind/version/criticality;
 *                                           drop orphans (WARN, never delete). Read-only.
 *   - `adopt <uid> [--source <id>] [--apply]`  — validate the resource is in the read-view; record
 *                                           { uid, sourceId }. Idempotent. Preview by default.
 *   - `remove <uid> [--source <id>] [--apply]` — remove the matching entry. Idempotent (absent no-op).
 *
 * SLICE-3+ SEAMS (do NOT build now): Slice 3 adds conflicts/adjudication; Slice 4 overlays/
 * tailoring; Slice 5 the per-project lockfile. This module deliberately leaves those clean —
 * the (uid, sourceId) key is the minimal identity a later duplicate-adoption conflict needs.
 *
 * @module manager/compose
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import { readJson, writeJsonAtomic } from './lib/store.mjs';
// REUSE the catalog operator's record production (ADR-0019 §2, BR-CAT-009). We import its
// run() and ask it to `build` the unified catalog (library ∪ synced sources), then derive the
// per-project READ-VIEW from THOSE records + the subscription set — exactly as slices.mjs
// does. We never re-scan, so a composition entry's resolved kind/version/criticality matches
// the catalog view byte-for-byte. Still a relative specifier (zerodep-clean).
import { run as catalogRun } from './catalog.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The emitter stamped on findings this module raises (C2 `compose`). */
const SOURCE = 'compose';

/** The on-disk composition schema tag (matches schemas/composition.schema.json). */
const SCHEMA_TAG = 'forge.composition.v1';

/** The composition file's current version integer. */
const SCHEMA_VERSION = 1;

/** The uid grammar "<kind>:<id>" (mirrors schemas/composition.schema.json#uid). */
const UID_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;

/** A source id grammar (mirrors schemas/composition.schema.json#sourceId string branch). */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Root + path resolution (mirrors slices.mjs)
// ---------------------------------------------------------------------------

/**
 * The ACTIVE PROJECT root the composition file lives under. Mirrors slices.mjs: ctx.cwd /
 * ctx.root, else the process cwd. Composition is per-project state (ADR-0019 §1), so this is
 * NOT the forge library root.
 * @param {any} ctx @returns {string}
 */
function resolveActiveRoot(ctx) {
  return (ctx && (ctx.cwd || ctx.root)) || process.cwd();
}

/** The composition file path under the active root (the only file this module writes). */
function compositionPath(activeRoot) {
  return path.join(activeRoot, '.forge', 'composition.json');
}

/** The subscriptions file path under the active root (read-only here — slices.mjs OWNS it). */
function subscriptionsPath(activeRoot) {
  return path.join(activeRoot, '.forge', 'subscriptions.json');
}

/** Project-relative composition path for finding paths (fail-open). */
function relComposition(activeRoot) {
  try {
    return path.relative(activeRoot, compositionPath(activeRoot)) || compositionPath(activeRoot);
  } catch {
    return path.join('.forge', 'composition.json');
  }
}

// ---------------------------------------------------------------------------
// Composition reads (forge.composition.v1)
// ---------------------------------------------------------------------------

/** A fresh, empty composition object (the initial shape). */
function emptyComposition() {
  return { schema: SCHEMA_TAG, version: SCHEMA_VERSION, adopted: [] };
}

/**
 * Read + normalize the composition file. An ABSENT file degrades to a fresh empty set (the
 * additive contract: we may create it). A present-but-malformed file degrades to
 * `{ malformed:true }` so a writer can refuse to edit. Each adopted entry is normalized to
 * `{ uid:string, sourceId:string|null }` (non-string uids dropped; a non-string sourceId
 * coerced to null = library-local). Fail-open: never throws.
 *
 * @param {string} activeRoot
 * @returns {{ comp:{schema:string,version:number,adopted:{uid:string,sourceId:string|null}[]}, existed:boolean, malformed:boolean }}
 */
function readComposition(activeRoot) {
  const abs = compositionPath(activeRoot);
  let existed = false;
  try {
    existed = fs.statSync(abs).isFile();
  } catch {
    existed = false;
  }
  if (!existed) {
    return { comp: emptyComposition(), existed: false, malformed: false };
  }
  const parsed = readJson(abs);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { comp: emptyComposition(), existed: true, malformed: true };
  }
  const rawAdopted = Array.isArray(parsed.adopted) ? parsed.adopted : [];
  const adopted = [];
  for (const e of rawAdopted) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (typeof e.uid !== 'string' || !e.uid) continue;
    const sourceId = typeof e.sourceId === 'string' && e.sourceId ? e.sourceId : null;
    adopted.push({ uid: e.uid, sourceId });
  }
  return {
    comp: {
      schema: typeof parsed.schema === 'string' ? parsed.schema : SCHEMA_TAG,
      version: typeof parsed.version === 'number' ? parsed.version : SCHEMA_VERSION,
      adopted,
    },
    existed: true,
    malformed: false,
  };
}

/**
 * The deterministic on-disk shape: schema/version stamped, `adopted` deduped on (uid,sourceId)
 * and sorted by uid then sourceId (null sorts before any source id, deterministically).
 * @param {{uid:string,sourceId:string|null}[]} adopted
 */
function normalizeForWrite(adopted) {
  const seen = new Set();
  const uniq = [];
  for (const e of adopted) {
    if (!e || typeof e.uid !== 'string' || !e.uid) continue;
    const sourceId = typeof e.sourceId === 'string' && e.sourceId ? e.sourceId : null;
    const key = entryKey(e.uid, sourceId);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push({ uid: e.uid, sourceId });
  }
  uniq.sort(compareEntries);
  return { schema: SCHEMA_TAG, version: SCHEMA_VERSION, adopted: uniq };
}

/** The collision-safe key for a (uid, sourceId) pair (null sourceId -> the sentinel ' '). */
function entryKey(uid, sourceId) {
  return `${uid} ${sourceId === null ? ' ' : sourceId}`;
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
// Subscriptions read (read-only — slices.mjs OWNS the writes)
// ---------------------------------------------------------------------------

/**
 * Read the project's subscribed slice-id set (read-only). Absent/malformed degrades to an
 * empty set (fail-open) — the read-view then is just the library-local records. Mirrors the
 * shape slices.mjs persists (forge.subscriptions.v1).
 * @param {string} activeRoot @returns {Set<string>}
 */
function readSubscribedSet(activeRoot) {
  const parsed = readJson(subscriptionsPath(activeRoot));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
  const list = Array.isArray(parsed.subscribed)
    ? parsed.subscribed.filter((s) => typeof s === 'string')
    : [];
  return new Set(list);
}

// ---------------------------------------------------------------------------
// Catalog record production reuse (the read-view seam)
// ---------------------------------------------------------------------------

/**
 * Ask the catalog operator to BUILD the unified catalog and return its records. We REUSE
 * catalog.mjs `run('build')` verbatim (ADR-0019 §2) — never re-scanning — so a record's
 * identity matches the catalog view exactly. Fail-open: any failure degrades to an empty
 * record list + a WARN finding (the composition list is still a valid, empty envelope).
 * @returns {Promise<{ records: any[], findings: import('./lib/findings.mjs').Finding[] }>}
 */
async function catalogRecords() {
  const findings = [];
  let records = [];
  try {
    const res = await catalogRun('build', [], {});
    records = res && res.data && Array.isArray(res.data.records) ? res.data.records : [];
  } catch (e) {
    findings.push(finding('WARN', 'compose', `catalog build failed: ${e && e.message ? e.message : String(e)} — empty read-view`));
    records = [];
  }
  return { records, findings };
}

/**
 * Derive the per-project READ-VIEW from the catalog records + the subscription set
 * (BR-CAT-006). A record is in the read-view IFF it is library-local (source === null), which
 * is ALWAYS visible, OR its slice id "<sourceId>/<kind>" is subscribed.
 *
 * Returns a Map keyed by `entryKey(uid, sourceId)` — sourceId is the record's provenance
 * sourceId (null for library-local) — so an adopt/list JOIN is an O(1) lookup keyed by the
 * SAME (uid, sourceId) pair the composition stores. We also return a per-uid index of which
 * sourceIds a uid is visible from, so adopt can disambiguate (a source-only uid needs
 * --source; a library-local uid may omit it).
 *
 * @param {any[]} records @param {Set<string>} subscribedSet
 * @returns {{ byKey:Map<string,any>, sourcesByUid:Map<string,Set<string|null>> }}
 */
function deriveReadView(records, subscribedSet) {
  /** @type {Map<string, any>} key -> catalog record (the visible one) */
  const byKey = new Map();
  /** @type {Map<string, Set<string|null>>} uid -> set of sourceIds it is visible from */
  const sourcesByUid = new Map();
  for (const rec of records) {
    if (!rec || typeof rec.uid !== 'string' || !rec.uid) continue;
    const src = rec.source;
    const sourceId = src && typeof src.sourceId === 'string' && src.sourceId ? src.sourceId : null;
    let visible = false;
    if (sourceId === null) {
      // Library-local records are ALWAYS in the read-view (BR-CAT-006).
      visible = true;
    } else {
      const kind = typeof rec.kind === 'string' ? rec.kind : '';
      if (kind && subscribedSet.has(`${sourceId}/${kind}`)) visible = true;
    }
    if (!visible) continue;
    const key = entryKey(rec.uid, sourceId);
    if (!byKey.has(key)) byKey.set(key, rec);
    let set = sourcesByUid.get(rec.uid);
    if (!set) {
      set = new Set();
      sourcesByUid.set(rec.uid, set);
    }
    set.add(sourceId);
  }
  return { byKey, sourcesByUid };
}

// ---------------------------------------------------------------------------
// normalize — mirrors slices.mjs#normalize (with a --source value-opt)
// ---------------------------------------------------------------------------

/**
 * Normalise `ctx`/`args` to { apply, source, positional, flags }. `--source <id>` is a
 * value-opt (the adopt/remove disambiguator); `--apply` is the write toggle. A trailing
 * non-flag positional after the verb is the uid (adopt/remove).
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
  // `--source` present with no value (or an empty string) is treated as "not provided".
  const sourceRaw = opts.source != null ? opts.source : (ctx && ctx.opts && ctx.opts.source) || null;
  const source = typeof sourceRaw === 'string' && sourceRaw.length > 0 ? sourceRaw : null;
  return { apply: !!apply, source, positional, flags };
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr. Returns `{ ok, data, findings, summary }`.
 * Fail-open: any internal failure degrades to an ok-ish empty result, never a throw.
 *
 * `list` writes NOTHING. `adopt`/`remove` write ONLY `.forge/composition.json` under the
 * active root and ONLY under `--apply`; the default is always a preview.
 *
 * @param {string} subcmd list | adopt | remove
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
      case 'adopt':
        return await doAdopt(activeRoot, n.positional[0] || null, n.source, n.apply);
      case 'remove':
        return await doRemove(activeRoot, n.positional[0] || null, n.source, n.apply);
      default:
        return result(false, { usage: usageText() }, [
          finding('ERROR', 'compose', `unknown compose subcommand: ${subcmd || '(none)'}`),
        ]);
    }
  } catch (e) {
    return result(false, null, [
      finding('ERROR', 'compose', `compose error: ${e && e.message ? e.message : String(e)}`),
    ]);
  }
}

/**
 * `list` — read composition.json, JOIN each adopted (uid, sourceId) entry to its catalog
 * READ-VIEW record (reusing the catalog record production) to resolve kind/version/
 * criticality, sorted deterministically by uid then sourceId. An entry whose resource is no
 * longer in the read-view (an ORPHAN — e.g. its slice was unsubscribed) is surfaced as a WARN
 * and dropped from the listed set, but NEVER deleted from the file (BR-CAT-009). Read-only.
 *
 * Returns `data { compositionPath, adopted:[ { uid, kind, sourceId, version, criticality } ],
 * counts:{ adopted, sources } }` (ADR-0019 §"compose list").
 */
async function doList(activeRoot) {
  const findings = [];
  const { comp, existed, malformed } = readComposition(activeRoot);
  if (malformed) {
    findings.push(finding('WARN', relComposition(activeRoot), 'composition.json is not a JSON object — treating as empty'));
  } else if (!existed) {
    findings.push(finding('INFO', relComposition(activeRoot), 'no composition file yet — nothing adopted (opt-in)'));
  }

  const subscribedSet = readSubscribedSet(activeRoot);
  const { records, findings: catFindings } = await catalogRecords();
  for (const f of catFindings) findings.push(f);
  const { byKey } = deriveReadView(records, subscribedSet);

  // JOIN each adopted entry to its read-view record; drop orphans (WARN), never delete them.
  const adopted = [];
  for (const e of comp.adopted) {
    const key = entryKey(e.uid, e.sourceId);
    const rec = byKey.get(key);
    if (!rec) {
      findings.push(finding('WARN', relComposition(activeRoot),
        `adopted "${e.uid}"${e.sourceId ? ` (source "${e.sourceId}")` : ' (library-local)'} is no longer in the read-view (orphan) — listed-out but retained; \`forge compose remove\` to drop it (BR-CAT-009)`));
      continue;
    }
    adopted.push({
      uid: e.uid,
      kind: typeof rec.kind === 'string' ? rec.kind : '',
      sourceId: e.sourceId,
      version: typeof rec.version === 'string' ? rec.version : (rec.version != null ? String(rec.version) : ''),
      criticality: typeof rec.criticality === 'string' ? rec.criticality : '',
    });
  }
  adopted.sort(compareEntries);

  const sources = new Set();
  for (const a of adopted) if (a.sourceId !== null) sources.add(a.sourceId);

  return result(true, {
    compositionPath: compositionPath(activeRoot),
    adopted,
    counts: { adopted: adopted.length, sources: sources.size },
  }, findings, {
    adopted: adopted.length,
    sources: sources.size,
  });
}

/**
 * `adopt <uid> [--source <id>] [--apply]` — record the resource (uid, sourceId) in the
 * composition. Validates the resource is in the project READ-VIEW (BR-CAT-008): adoptable IFF
 * library-local (source === null) OR its slice is subscribed. The chosen sourceId is `--source`
 * when given, else null (library-local). When a uid resolves ONLY from a source (no
 * library-local copy) and `--source` is omitted, ERROR asking for `--source` (never guess).
 * Idempotent. Preview by default; --apply writes atomically + additively (creating the file
 * on first --apply). Adopt does NOT admit, write the library, or run the pipeline (BR-CAT-008).
 */
async function doAdopt(activeRoot, uid, source, apply) {
  return mutate(activeRoot, uid, source, apply, 'adopt');
}

/**
 * `remove <uid> [--source <id>] [--apply]` — drop the matching (uid, sourceId) entry from the
 * composition. The entry to remove is (uid, sourceId=--source||null). Idempotent: an absent
 * entry is a no-op WARN. Preview by default; --apply writes atomically + additively (every
 * other entry preserved). Does NOT touch the library or admission state (BR-CAT-009).
 */
async function doRemove(activeRoot, uid, source, apply) {
  return mutate(activeRoot, uid, source, apply, 'remove');
}

/**
 * Shared adopt/remove core. Validates the uid, resolves the target (uid, sourceId), reads the
 * current set, computes the additive change, and (under --apply) persists it atomically.
 *
 * For ADOPT it consults the READ-VIEW (catalog records + subscriptions) — refusing a resource
 * that is not visible, and ERRORing for a source-only uid when --source is omitted. For REMOVE
 * it does NOT consult the read-view (an orphan must stay removable), it just drops the
 * matching (uid, sourceId) entry.
 *
 * Returns a plan `data { uid, sourceId, compositionPath, applied, written, action, changed,
 * adopted:[…], plan:{changed} }` so the preview and the apply share one shape.
 *
 * @param {string} activeRoot @param {string|null} uid @param {string|null} source
 * @param {boolean} apply @param {'adopt'|'remove'} action
 */
async function mutate(activeRoot, uid, source, apply, action) {
  const findings = [];
  if (!uid) {
    return result(false, { usage: usageText() }, [
      finding('ERROR', 'compose', `${action} requires a <uid> argument ("<kind>:<id>", e.g. "agent:hello")`),
    ]);
  }
  if (!UID_RE.test(uid)) {
    return result(false, { uid, action, plan: { changed: false } }, [
      finding('ERROR', 'compose', `invalid uid "${uid}" (must be "<kind>:<id>", e.g. "agent:hello")`),
    ]);
  }
  if (source !== null && !SOURCE_ID_RE.test(source)) {
    return result(false, { uid, sourceId: source, action, plan: { changed: false } }, [
      finding('ERROR', 'compose', `invalid --source "${source}" (a source id like "acme-skills", or omit for the library-local copy)`),
    ]);
  }

  const { comp, malformed } = readComposition(activeRoot);
  if (malformed) {
    return result(false, { uid, sourceId: source, action, plan: { changed: false } }, [
      finding('ERROR', relComposition(activeRoot), 'composition.json is not a JSON object — refusing to edit'),
    ]);
  }

  // The target (uid, sourceId) — `--source` wins; null means the library-local copy.
  let sourceId = source;

  // ADOPT validates READ-VIEW membership (BR-CAT-008). REMOVE does not (orphans stay removable).
  if (action === 'adopt') {
    const subscribedSet = readSubscribedSet(activeRoot);
    const { records, findings: catFindings } = await catalogRecords();
    for (const f of catFindings) findings.push(f);
    const { byKey, sourcesByUid } = deriveReadView(records, subscribedSet);

    const visibleFrom = sourcesByUid.get(uid) || new Set();
    if (visibleFrom.size === 0) {
      return result(false, { uid, sourceId: source, action, plan: { changed: false } }, [
        ...findings,
        finding('ERROR', 'compose', `"${uid}" is not in this project's read-view — it is neither library-local nor from a subscribed slice. Subscribe its slice (forge slice subscribe "<sourceId>/<kind>") or check the uid (BR-CAT-008).`),
      ]);
    }
    if (source === null) {
      // No --source: prefer the library-local copy if visible; otherwise it is ambiguous /
      // source-only — ERROR asking for --source (never guess, BR-CAT-008).
      if (!visibleFrom.has(null)) {
        const fromList = [...visibleFrom].filter((s) => s !== null).sort();
        return result(false, { uid, sourceId: null, action, plan: { changed: false }, visibleFrom: fromList }, [
          ...findings,
          finding('ERROR', 'compose', `"${uid}" is not library-local; it is visible only from source(s) [${fromList.join(', ')}] — pass --source <id> to choose (BR-CAT-008).`),
        ]);
      }
      sourceId = null; // adopt the library-local copy.
    } else if (!byKey.has(entryKey(uid, source))) {
      // --source given, but that (uid, source) pair is not visible in the read-view.
      const fromList = [...visibleFrom].map((s) => (s === null ? 'library-local' : s)).sort();
      return result(false, { uid, sourceId: source, action, plan: { changed: false }, visibleFrom: fromList }, [
        ...findings,
        finding('ERROR', 'compose', `"${uid}" from source "${source}" is not in the read-view (visible from [${fromList.join(', ')}]) — subscribe its slice or fix --source (BR-CAT-008).`),
      ]);
    }
  }

  const current = comp.adopted;
  const targetKey = entryKey(uid, sourceId);
  const present = current.some((e) => entryKey(e.uid, e.sourceId) === targetKey);
  /** @type {{uid:string,sourceId:string|null}[]} */
  let nextAdopted = current;
  let changed = false;
  const where = sourceId === null ? '(library-local)' : `(source "${sourceId}")`;

  if (action === 'adopt') {
    if (present) {
      findings.push(finding('WARN', relComposition(activeRoot), `"${uid}" ${where} already adopted — no change (idempotent)`));
    } else {
      nextAdopted = [...current, { uid, sourceId }];
      changed = true;
      findings.push(finding('INFO', 'compose', `adopt "${uid}" ${where}: recorded in this project's composition (adopt != admit — the library is unchanged, ADR-0019 §3)`));
    }
  } else {
    if (!present) {
      findings.push(finding('WARN', relComposition(activeRoot), `"${uid}" ${where} not adopted — nothing to remove (idempotent)`));
    } else {
      nextAdopted = current.filter((e) => entryKey(e.uid, e.sourceId) !== targetKey);
      changed = true;
      findings.push(finding('INFO', 'compose', `remove "${uid}" ${where}: dropped from this project's composition`));
    }
  }

  let written = false;
  if (apply && changed) {
    written = writeJsonAtomic(compositionPath(activeRoot), normalizeForWrite(nextAdopted));
    if (!written) findings.push(finding('WARN', relComposition(activeRoot), 'could not write composition.json'));
  } else if (!apply && changed) {
    findings.push(finding('INFO', relComposition(activeRoot), 'dry-run: pass --apply to write the change'));
  }

  return result(true, {
    uid,
    sourceId,
    compositionPath: compositionPath(activeRoot),
    applied: !!apply,
    written,
    action,
    changed,
    adopted: normalizeForWrite(nextAdopted).adopted,
    plan: { changed },
  }, findings, {
    [action]: changed ? 1 : 0,
    written: written ? 1 : 0,
  });
}

/**
 * C4 `summarize(state)` — pure; map a run-state to a one-panel summary. Returns a `(no data)`
 * panel when no adopted array is present (fail-open).
 * @param {any} state @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  const adopted = state && typeof state === 'object' && Array.isArray(state.adopted) ? state.adopted : null;
  if (!adopted) {
    return makePanel({ panel: 'compose', ok: false, lines: ['(no data)'], hint: 'forge compose list' });
  }
  const sources = new Set();
  for (const a of adopted) if (a && a.sourceId) sources.add(a.sourceId);
  return makePanel({
    panel: 'compose',
    ok: true,
    lines: [`${adopted.length} adopted`, `${sources.size} source${sources.size === 1 ? '' : 's'}`],
  });
}

/** Build a Panel with a non-enumerable toString (mirrors slices.mjs#makePanel). */
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

/** Stamp a C2 finding from this module (compose pre-filled). */
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
    'forge compose list',
    'forge compose adopt <uid> [--source <id>] [--apply]     (uid = "<kind>:<id>")',
    'forge compose remove <uid> [--source <id>] [--apply]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Human render (print side)
// ---------------------------------------------------------------------------

/**
 * Render a ModuleResult as human text (print side). Returns the exit code. PRINT happens ONLY
 * in the script entry; run() never writes stdout.
 * @param {string} subcmd @param {{ok:boolean,data:any,findings:any[],summary:any}} res @returns {number}
 */
function renderHuman(subcmd, res) {
  const out = [];
  const data = res.data || {};
  if (data.usage) {
    out.push(data.usage);
  } else if (subcmd === 'list') {
    const adopted = Array.isArray(data.adopted) ? data.adopted : [];
    if (adopted.length === 0) out.push('compose: nothing adopted (forge compose adopt <uid>)');
    for (const a of adopted) {
      const src = a.sourceId === null ? 'library-local' : a.sourceId;
      out.push(`  ${a.uid}\t${a.kind || '?'}\t${src}\t${a.version || '-'}\t${a.criticality || '-'}`);
    }
  } else if (subcmd === 'adopt' || subcmd === 'remove') {
    const where = data.sourceId === null || data.sourceId === undefined ? '(library-local)' : `(source "${data.sourceId}")`;
    out.push(`compose ${subcmd} ${data.uid || ''} ${where}: ${data.changed ? 'changed' : 'no change'}${data.applied ? `, ${data.written ? 'written' : (data.changed ? 'not written' : 'nothing to write')}` : (data.changed ? ' (preview — pass --apply)' : '')}`);
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
//   node manager/compose.mjs <subcmd> [flags] [uid]
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
          command: `compose ${subcmd || ''}`.trim(),
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
