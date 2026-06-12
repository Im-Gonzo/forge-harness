// @ts-check
/**
 * conflict — the manager's per-project CONFLICT + ADJUDICATION operator (ADR-0020).
 *
 * GROUNDING IN THE BACKBONE. A project-level CONFLICT is exactly a uid that resolves to
 * >= 2 DISTINCT candidate records in the project's catalog READ-VIEW (ADR-0018) — i.e. the
 * dedup `uid-collision` (same uid, different bytes) or `near-dup` (similar but not identical)
 * classes of catalog.md §5.1, observed ACROSS the read-view's library-local + subscribed-slice
 * sources rather than inside one admission. `unique`/`exact-dup` are NOT conflicts. The conflict
 * set is DERIVED, never stored (BR-CAT-010): we REUSE the catalog operator's record production
 * (manager/catalog.mjs `run('dedup')`) — exactly as slices.mjs/compose.mjs reuse `run('build')` —
 * filter to the read-view, and group a uid's peers into its candidate list. We never re-scan and
 * never introduce a parallel classifier beside dedup.
 *
 * DETERMINISTIC-COLLECTION ONLY (BR-CAT-011, METHOD §7). This operator is the
 * deterministic-collection half: it COLLECTS conflicts and CONSUMES already-recorded signals —
 * the judge verdict from the sidecar `.forge/catalog-verdicts.json` (the same store
 * `forge catalog judge`/`audit` writes, BR-CAT-001) and eval scores from the eval-harness
 * (manager/eval-harness.mjs) ONLY when a REAL score exists. It MUST NOT invoke the judge agent
 * (`bundles/catalog-judge.md`) or ANY model, and it NEVER fabricates a score or a verdict — a
 * missing score is `null` (the UI shows "—"); a missing verdict is `judge: null`.
 *
 * ADJUDICATION POLICY + STATE (BR-CAT-012). The project sets a per-criticality policy —
 * `{ normal, compliance, safety }`, each `"auto" | "block"` (ADR-0013) — persisted under the
 * ACTIVE ROOT in `.forge/adjudication.json` (`forge.adjudication.v1`,
 * schemas/adjudication.schema.json). The DEFAULT is all-block (conservative; consistent with
 * sources untrusted / slices unsubscribed / resources unadopted). A conflict's `state` derives:
 *
 *   state(c) = choice != null  -> "manual"
 *            ; else policy[c.criticality] == "auto" -> "auto"
 *            ; else "blocking".
 *
 * A conflict is BLOCKING iff state == "blocking". The composition is "blocked" while any
 * read-view conflict is blocking (the Slice-2 seam).
 *
 * RESOLVE IS A HUMAN T2 PICK (BR-CAT-013, BR-CAT-003). `resolve <uid> --winner <sourceId|library>`
 * records the human's pick in `choices`; on `--apply` it ALSO updates the composition
 * (`.forge/composition.json`) so the winner's `(uid, sourceId)` is adopted and the losing peers
 * for that uid are removed — REUSING the ADR-0019 compose helpers (manager/compose.mjs `adopt`/
 * `remove`), never duplicating the write logic. Policy `"auto"` relaxes the per-conflict pick for
 * composition-level adoption ONLY; a resolve that would REPLACE an already-admitted LIBRARY
 * resource stays a T2 human action even under `"auto"` — recorded via the human's explicit
 * `--winner` + `--apply` and NEVER self-applied (BR-CAT-003).
 *
 * SUGGESTED falls back gracefully (BR-CAT-013): the eval-highest candidate (real scores only) ->
 * else the recorded judge `winner` -> else `null` ("needs human"). It is a HINT, never an
 * automatic decision.
 *
 * The two roots, kept STRICTLY separate (mirrors compose.mjs/slices.mjs):
 *   - FORGE_ROOT  — this library's install location. The catalog record production we reuse
 *                   (catalog.mjs) resolves it from its own module URL; the verdict sidecar lives
 *                   there too (git-tracked .forge/). We never re-scan.
 *   - ACTIVE ROOT — the target PROJECT (ctx.cwd / ctx.root / process.cwd()). adjudication.json,
 *                   composition.json, and subscriptions.json are read/written HERE — per-project state.
 *
 * HARD INVARIANTS (the plugin payload contract): zero runtime deps (node: builtins + relative
 * imports only); additive-never-destructive; writers PREVIEW by default (write only under
 * `--apply`); fail-open (no public entry throws past its surface — it degrades to a safe
 * `{ok,data,findings,summary}` envelope). Dual-mode with an `isMain()` guard — NEVER
 * process.exit() at import time. NO model/judge invocation.
 *
 * Subcommands (C4 `run(subcmd, args, ctx)`):
 *   - `list`                                     — derive conflicts from the catalog dedup view,
 *                                                  filtered to the read-view; attach judge/eval
 *                                                  signals; compute suggested + state. Read-only.
 *   - `resolve <uid> --winner <sourceId|library> [--apply]` — record the human pick; on --apply
 *                                                  update the composition (winner adopted, losers
 *                                                  removed) via compose helpers. Idempotent.
 *   - `policy [--set normal=auto|block] [--set compliance=...] [--set safety=...] [--apply]`
 *                                                  — get (no --set) or set the policy.
 *
 * @module manager/conflict
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import { readJson, writeJsonAtomic, forgeStateDir, forgeHome } from './lib/store.mjs';
// REUSE the catalog operator's DEDUP production (ADR-0020 §1, BR-CAT-010). We import its run()
// and ask it to `dedup` the unified catalog (library ∪ synced sources), then derive the
// per-project READ-VIEW from THOSE records + the subscription set — exactly as slices.mjs and
// compose.mjs do. We never re-scan and never re-classify; a conflict's candidate set is a pure
// function of the dedup classes catalog.mjs already produces. Still a relative specifier
// (zerodep-clean), and DETERMINISTIC — dedup spends no model call.
import { run as catalogRun } from './catalog.mjs';
// REUSE the ADR-0019 composition helpers for resolve --apply (BR-CAT-013): we adopt the winner's
// (uid, sourceId) and remove the losing peers via compose.mjs, never duplicating the write logic.
import { run as composeRun } from './compose.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The emitter stamped on findings this module raises (C2 `conflict`). */
const SOURCE = 'conflict';

/** The on-disk adjudication schema tag (matches schemas/adjudication.schema.json). */
const SCHEMA_TAG = 'forge.adjudication.v1';

/** The adjudication file's current version integer. */
const SCHEMA_VERSION = 1;

/** The criticality dimensions the policy keys on (ADR-0013), in a deterministic order. */
const CRITICALITIES = ['normal', 'compliance', 'safety'];

/** The closed policy mode set (mirrors schemas/adjudication.schema.json#policyMode). */
const POLICY_MODES = new Set(['auto', 'block']);

/** The DEFAULT policy: all-block (conservative — every conflict needs an explicit human pick). */
function defaultPolicy() {
  return { normal: 'block', compliance: 'block', safety: 'block' };
}

/** The dedup classes that constitute a project-level conflict (BR-CAT-010). */
const CONFLICT_CLASSES = new Set(['uid-collision', 'near-dup']);

/** The uid grammar "<kind>:<id>" (mirrors schemas/adjudication.schema.json#uid). */
const UID_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;

/** A source id grammar (mirrors schemas/adjudication.schema.json#winner string branch). */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Root + path resolution (mirrors compose.mjs)
// ---------------------------------------------------------------------------

/**
 * The ACTIVE PROJECT root the adjudication/composition files live under. Mirrors compose.mjs:
 * ctx.cwd / ctx.root, else the process cwd. Adjudication is per-project state (ADR-0020 §5).
 * @param {any} ctx @returns {string}
 */
function resolveActiveRoot(ctx) {
  return (ctx && (ctx.cwd || ctx.root)) || process.cwd();
}

/** The adjudication file path under the active root (the only file this module writes). */
function adjudicationPath(activeRoot) {
  return path.join(activeRoot, '.forge', 'adjudication.json');
}

/** The subscriptions file path under the active root (read-only here — slices.mjs OWNS it). */
function subscriptionsPath(activeRoot) {
  return path.join(activeRoot, '.forge', 'subscriptions.json');
}

/** Project-relative adjudication path for finding paths (fail-open). */
function relAdjudication(activeRoot) {
  try {
    return path.relative(activeRoot, adjudicationPath(activeRoot)) || adjudicationPath(activeRoot);
  } catch {
    return path.join('.forge', 'adjudication.json');
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

/** The verdict sidecar path `<FORGE_HOME>/.forge/catalog-verdicts.json` (the catalog `judge`/`audit`
 *  store; relocated to the global config root by ADR-0023). `conflict` only READS it here, to surface
 *  the recorded judge verdict; catalog.mjs OWNS and writes it. The `forgeRoot` arg is retained for the
 *  signature; the file is FORGE_HOME-rooted (machine-level GLOBAL federation state). */
function verdictsPath(_forgeRoot) {
  return path.join(forgeHome(), '.forge', 'catalog-verdicts.json');
}

// ---------------------------------------------------------------------------
// Adjudication reads (forge.adjudication.v1)
// ---------------------------------------------------------------------------

/** A fresh, empty adjudication object (the initial shape: all-block, no choices). */
function emptyAdjudication() {
  return { schema: SCHEMA_TAG, version: SCHEMA_VERSION, policy: defaultPolicy(), choices: [] };
}

/**
 * Read + normalize the adjudication file. An ABSENT file degrades to a fresh empty object (the
 * additive contract: we may create it). A present-but-malformed file degrades to
 * `{ malformed:true }` so a writer can refuse to edit. The policy is normalized to a complete
 * `{ normal, compliance, safety }` (unknown/absent dimensions default to "block"); choices are
 * normalized to `{ uid:string, winner:string|null }` (non-string uids dropped; a non-string
 * winner coerced to null = library-local; last write per uid wins). Fail-open: never throws.
 *
 * @param {string} activeRoot
 * @returns {{ adj:{schema:string,version:number,policy:Record<string,string>,choices:{uid:string,winner:string|null}[]}, existed:boolean, malformed:boolean }}
 */
function readAdjudication(activeRoot) {
  const abs = adjudicationPath(activeRoot);
  let existed = false;
  try {
    existed = fs.statSync(abs).isFile();
  } catch {
    existed = false;
  }
  if (!existed) {
    return { adj: emptyAdjudication(), existed: false, malformed: false };
  }
  const parsed = readJson(abs);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { adj: emptyAdjudication(), existed: true, malformed: true };
  }
  return {
    adj: {
      schema: typeof parsed.schema === 'string' ? parsed.schema : SCHEMA_TAG,
      version: typeof parsed.version === 'number' ? parsed.version : SCHEMA_VERSION,
      policy: normalizePolicy(parsed.policy),
      choices: normalizeChoices(parsed.choices),
    },
    existed: true,
    malformed: false,
  };
}

/** Normalize a raw policy object into a complete `{ normal, compliance, safety }` (default block). */
function normalizePolicy(raw) {
  const out = defaultPolicy();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const c of CRITICALITIES) {
      if (typeof raw[c] === 'string' && POLICY_MODES.has(raw[c])) out[c] = raw[c];
    }
  }
  return out;
}

/** Normalize a raw choices array into `{ uid, winner:string|null }[]` (last write per uid wins). */
function normalizeChoices(raw) {
  /** @type {Map<string,{uid:string,winner:string|null}>} */
  const byUid = new Map();
  const list = Array.isArray(raw) ? raw : [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (typeof e.uid !== 'string' || !e.uid) continue;
    const winner = typeof e.winner === 'string' && e.winner ? e.winner : null;
    byUid.set(e.uid, { uid: e.uid, winner }); // last write per uid wins
  }
  return [...byUid.values()];
}

/**
 * The deterministic on-disk shape: schema/version stamped, policy complete, choices deduped on
 * uid (last write wins) and sorted by uid.
 * @param {Record<string,string>} policy @param {{uid:string,winner:string|null}[]} choices
 */
function normalizeForWrite(policy, choices) {
  const norm = normalizeChoices(choices);
  norm.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  return { schema: SCHEMA_TAG, version: SCHEMA_VERSION, policy: normalizePolicy(policy), choices: norm };
}

// ---------------------------------------------------------------------------
// Subscriptions read (read-only — slices.mjs OWNS the writes)
// ---------------------------------------------------------------------------

/**
 * Read the project's subscribed slice-id set (read-only). Absent/malformed degrades to an empty
 * set (fail-open) — the read-view then is just the library-local records. Mirrors compose.mjs.
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
// Catalog dedup production reuse (the conflict-derivation seam, BR-CAT-010/011)
// ---------------------------------------------------------------------------

/**
 * Ask the catalog operator to DEDUP the unified catalog and return its classified records. We
 * REUSE catalog.mjs `run('dedup')` verbatim (ADR-0020 §1) — never re-scanning, never
 * re-classifying — so a conflict's candidate set is a pure function of the dedup classes
 * catalog.mjs already produces. `dedup` is DETERMINISTIC (no model call). Fail-open: any failure
 * degrades to an empty record list + a WARN finding (the conflict list is still a valid, empty
 * envelope).
 * @returns {Promise<{ records: any[], findings: import('./lib/findings.mjs').Finding[] }>}
 */
async function catalogDedupRecords() {
  const findings = [];
  let records = [];
  try {
    const res = await catalogRun('dedup', [], {});
    records = res && res.data && Array.isArray(res.data.records) ? res.data.records : [];
  } catch (e) {
    findings.push(finding('WARN', 'conflict', `catalog dedup failed: ${e && e.message ? e.message : String(e)} — no conflicts`));
    records = [];
  }
  return { records, findings };
}

/**
 * The provenance sourceId for a record (null for a library-local/admitted record). Mirrors
 * compose.mjs's read-view key derivation.
 */
function recordSourceId(rec) {
  const src = rec && rec.source;
  return src && typeof src.sourceId === 'string' && src.sourceId ? src.sourceId : null;
}

/**
 * Filter the dedup-classified catalog records to the per-project READ-VIEW (BR-CAT-006/010): a
 * record is visible IFF it is library-local (source === null, ALWAYS visible) OR its slice id
 * "<sourceId>/<kind>" is subscribed. Identical to compose.mjs's read-view rule.
 * @param {any[]} records @param {Set<string>} subscribedSet @returns {any[]}
 */
function filterReadView(records, subscribedSet) {
  const out = [];
  for (const rec of records) {
    if (!rec || typeof rec.uid !== 'string' || !rec.uid) continue;
    const sourceId = recordSourceId(rec);
    if (sourceId === null) {
      out.push(rec); // library-local is always in the read-view
    } else {
      const kind = typeof rec.kind === 'string' ? rec.kind : '';
      if (kind && subscribedSet.has(`${sourceId}/${kind}`)) out.push(rec);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signal consumption — judge verdict (sidecar) + eval scores (BR-CAT-011)
// ---------------------------------------------------------------------------

/** The NUL key separator joining "<sourceId> <uid>" in the verdict sidecar (collision-safe). */
const KEY_SEP = ' ';

/**
 * Read the verdict sidecar fail-open into `{ records: {} }`. A missing/malformed file yields the
 * empty canonical shape. We CONSUME this store (the catalog `judge`/`audit` writes it); we never
 * write it here.
 * @param {string} forgeRoot @returns {Record<string, any>}
 */
function readVerdictRecords(forgeRoot) {
  const raw = readJson(verdictsPath(forgeRoot));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw.records && typeof raw.records === 'object' && !Array.isArray(raw.records) ? raw.records : {};
}

/**
 * Look up the RECORDED judge verdict for a uid across the conflict's candidates (BR-CAT-011). The
 * sidecar is keyed by "<sourceId> <uid>" so the SAME uid from two sources keeps independent
 * verdict trails; we take the first recorded verdict found among the candidate sourceIds (the
 * library-local key "" included). Returns `{ verdict, winner, rationale }` (winner consumed if the
 * producer recorded one, else null) or `null` when no verdict is recorded. We NEVER invoke the
 * judge or fabricate a verdict.
 *
 * @param {Record<string,any>} verdictRecords @param {string} uid
 * @param {(string|null)[]} candidateSourceIds @returns {{verdict:string,winner:string|null,rationale:string}|null}
 */
function consumeJudge(verdictRecords, uid, candidateSourceIds) {
  for (const sourceId of candidateSourceIds) {
    const key = `${sourceId === null ? '' : sourceId}${KEY_SEP}${uid}`;
    const entry = verdictRecords[key];
    if (entry && typeof entry === 'object' && entry.judge && typeof entry.judge === 'object'
      && typeof entry.judge.verdict === 'string') {
      return {
        verdict: entry.judge.verdict,
        // The producer's recorded judge may carry an explicit winner sourceId (forward-compatible);
        // we consume it if present, else null (never fabricated).
        winner: typeof entry.judge.winner === 'string' && entry.judge.winner ? entry.judge.winner : null,
        rationale: typeof entry.judge.rationale === 'string' ? entry.judge.rationale : '',
      };
    }
  }
  return null;
}

/**
 * Read any REAL per-uid eval scores from the eval-harness result stores (BR-CAT-011). Scores are
 * CONSUMED only when a real score exists; we NEVER fabricate one. Reads ONLY local result files
 * under the FORGE library `.forge/eval/` (live scores) and `evals/harness/results/` (authored
 * corpus) — NO model call. Returns a Map(uid -> { score:number, metrics:[{k,v}] }); a uid with no
 * real score is simply absent (the caller attaches score = null).
 *
 * The eval result rows are tolerant: a row may carry `{ uid, score|grade, metrics }`. We accept a
 * numeric `score` (or a numeric metric we can surface); a non-numeric grade (e.g. "U"/"—") yields
 * no score. Fail-open throughout.
 *
 * @param {string} forgeRoot @returns {Map<string,{score:number,metrics:{k:string,v:string}[]}>}
 */
function readEvalScores(forgeRoot) {
  /** @type {Map<string,{score:number,metrics:{k:string,v:string}[]}>} */
  const byUid = new Map();
  const dirs = [
    path.join(forgeStateDir(forgeRoot), 'eval'),
    path.join(forgeRoot, 'evals', 'harness', 'results'),
  ];
  for (const dir of dirs) {
    for (const name of ['results.json', 'dashboard.json']) {
      let rows = [];
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        rows = Array.isArray(obj) ? obj : Array.isArray(obj && obj.artifacts) ? obj.artifacts : [];
      } catch {
        continue; // not present — try the next file
      }
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const uid = typeof row.uid === 'string' ? row.uid : '';
        if (!uid || byUid.has(uid)) continue; // first store wins (live before authored)
        const ev = row.eval && typeof row.eval === 'object' ? row.eval : row;
        const score = pickRealScore(ev);
        if (score === null) continue; // no REAL numeric score — never fabricate
        byUid.set(uid, { score, metrics: pickMetrics(ev) });
      }
    }
  }
  return byUid;
}

/** Extract a REAL numeric score from an eval payload, or null (never coerce U/grade to a number). */
function pickRealScore(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.score === 'number' && Number.isFinite(ev.score)) return ev.score;
  const m = ev.metrics && typeof ev.metrics === 'object' ? ev.metrics : null;
  if (m) {
    // Prefer a catch^k-style aggregate if present and numeric; otherwise no score.
    for (const k of ['catch_pow_k', 'catchPowK', 'catch_rate', 'pass_rate']) {
      if (typeof m[k] === 'number' && Number.isFinite(m[k])) return m[k];
    }
  }
  return null;
}

/** Extract surface metrics `[{k,v}]` from an eval payload (string-valued; empty when none). */
function pickMetrics(ev) {
  const out = [];
  const m = ev && ev.metrics && typeof ev.metrics === 'object' && !Array.isArray(ev.metrics) ? ev.metrics : null;
  if (m) {
    for (const k of Object.keys(m).sort()) {
      const v = m[k];
      if (typeof v === 'number' || typeof v === 'string') out.push({ k, v: String(v) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conflict assembly (the CONFLICT shape, ADR-0020 §1)
// ---------------------------------------------------------------------------

/** The candidate's security scan state (string), defaulting to '' when unknown. */
function candidateSecurity(rec) {
  return rec && rec.security && typeof rec.security.scan === 'string' ? rec.security.scan : '';
}

/** A candidate version string, fail-open to ''. */
function candidateVersion(rec) {
  if (rec && typeof rec.version === 'string') return rec.version;
  if (rec && rec.version != null) return String(rec.version);
  return '';
}

/**
 * Group the read-view records by uid and assemble a CONFLICT for every uid with a conflict-class
 * (uid-collision/near-dup) AND >= 2 DISTINCT candidate records (BR-CAT-010). A candidate is
 * distinct by (sourceId): the SAME uid from the library and a source — or from two sources — are
 * distinct candidates. A uid with a single read-view candidate is NOT a conflict. We attach the
 * eval score (real-only, else null) + recorded judge verdict (else null), then compute suggested +
 * state from the policy + recorded choice.
 *
 * @param {any[]} readViewRecords The dedup-classified records, filtered to the read-view.
 * @param {Record<string,string>} policy The per-criticality adjudication policy.
 * @param {Map<string,{uid:string,winner:string|null}>} choiceByUid Recorded human choices.
 * @param {Record<string,any>} verdictRecords The verdict sidecar records.
 * @param {Map<string,{score:number,metrics:{k:string,v:string}[]}>} evalByUid Real eval scores.
 * @returns {object[]} The conflicts, sorted deterministically by uid.
 */
function assembleConflicts(readViewRecords, policy, choiceByUid, verdictRecords, evalByUid) {
  /** @type {Map<string, any[]>} uid -> its read-view records */
  const byUid = new Map();
  for (const rec of readViewRecords) {
    const uid = typeof rec.uid === 'string' ? rec.uid : '';
    if (!uid) continue;
    let arr = byUid.get(uid);
    if (!arr) {
      arr = [];
      byUid.set(uid, arr);
    }
    arr.push(rec);
  }

  const conflicts = [];
  for (const uid of [...byUid.keys()].sort()) {
    const recs = byUid.get(uid) || [];
    // A conflict requires at least one record classified as a conflict class (uid-collision/near-dup).
    const isConflictClass = recs.some((r) => r.dedup && CONFLICT_CLASSES.has(r.dedup.class));
    if (!isConflictClass) continue;

    // DISTINCT candidates by sourceId (BR-CAT-010): collapse multiple records from one source to
    // one candidate (the first deterministically), keep library-local (null) and each source apart.
    /** @type {Map<string|null, any>} sourceId -> the chosen record for that candidate */
    const bySource = new Map();
    for (const r of recs) {
      const sid = recordSourceId(r);
      if (!bySource.has(sid)) bySource.set(sid, r);
    }
    if (bySource.size < 2) continue; // a single distinct candidate is NOT a conflict (BR-CAT-010)

    // Candidate list, sorted: library-local (null) first, then by sourceId.
    const candSources = [...bySource.keys()].sort(compareSourceId);
    const candidates = candSources.map((sid) => {
      const rec = bySource.get(sid);
      const ev = evalByUid.get(uid) || null;
      // The eval score keys on uid; attach it to a candidate only if real. (A per-candidate score
      // model is a future extension — today the harness keys on uid, so all candidates of a uid
      // share the uid's real score, or null when none exists.)
      const score = ev && typeof ev.score === 'number' ? ev.score : null;
      const metrics = ev && Array.isArray(ev.metrics) ? ev.metrics : [];
      return {
        sourceId: sid,
        version: candidateVersion(rec),
        score,
        metrics,
        security: candidateSecurity(rec),
      };
    });

    const first = bySource.get(candSources[0]) || recs[0];
    const kind = typeof first.kind === 'string' ? first.kind : '';
    const criticality = typeof first.criticality === 'string' && first.criticality ? first.criticality : 'normal';

    const judge = consumeJudge(verdictRecords, uid, candSources);
    const suggested = computeSuggested(candidates, judge);

    const choiceEntry = choiceByUid.get(uid);
    const choice = choiceEntry ? choiceEntry.winner : null;
    const hasChoice = !!choiceEntry;
    const state = deriveState(hasChoice, policy, criticality);

    conflicts.push({
      uid,
      kind,
      criticality,
      candidates,
      judge,
      suggested,
      choice,
      state,
    });
  }
  return conflicts;
}

/** Deterministic source-id order: library-local (null) first, then lexicographic. */
function compareSourceId(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/**
 * Compute the SUGGESTED winner sourceId with a graceful fallback (BR-CAT-013): the eval-highest
 * candidate (when real scores exist) -> else the recorded judge `winner` (when recorded) -> else
 * null ("needs human"). Never fabricated.
 *
 * @param {{sourceId:string|null,score:number|null}[]} candidates
 * @param {{verdict:string,winner:string|null,rationale:string}|null} judge
 * @returns {string|null}
 */
function computeSuggested(candidates, judge) {
  // 1. eval-highest candidate (only candidates that carry a REAL numeric score participate).
  let best = null;
  for (const c of candidates) {
    if (typeof c.score === 'number') {
      if (best === null || c.score > best.score) best = c;
    }
  }
  if (best !== null) return best.sourceId;
  // 2. else the recorded judge winner (consumed, never produced).
  if (judge && typeof judge.winner === 'string' && judge.winner) return judge.winner;
  // 3. else null ("needs human") — no fabrication.
  return null;
}

/**
 * Derive a conflict's state (BR-CAT-012): a recorded choice -> "manual"; else policy[criticality]
 * == "auto" -> "auto"; else "blocking".
 * @param {boolean} hasChoice @param {Record<string,string>} policy @param {string} criticality
 * @returns {'manual'|'auto'|'blocking'}
 */
function deriveState(hasChoice, policy, criticality) {
  if (hasChoice) return 'manual';
  const mode = policy && typeof policy[criticality] === 'string' ? policy[criticality] : 'block';
  return mode === 'auto' ? 'auto' : 'blocking';
}

// ---------------------------------------------------------------------------
// normalize — mirrors compose.mjs#normalize (with --winner + repeatable --set)
// ---------------------------------------------------------------------------

/**
 * Normalise `ctx`/`args` to { apply, winner, sets, positional, flags }. `--winner <id>` is a
 * value-opt (the resolve pick). `--set <dim=mode>` is a REPEATABLE value-opt (the policy setter) —
 * we collect every occurrence into `sets`. `--apply` is the write toggle. A trailing non-flag
 * positional after the verb is the uid (resolve).
 */
function normalize(args, ctx) {
  const flags = new Set();
  const positional = [];
  /** @type {Record<string,string>} */
  const opts = {};
  /** @type {string[]} every --set value (repeatable) */
  const sets = [];
  const argList = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  const VALUE_OPTS = new Set(['winner', 'set']);
  for (let i = 0; i < argList.length; i++) {
    const a = argList[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      flags.add(name);
      let value = null;
      if (eq >= 0) {
        value = body.slice(eq + 1);
      } else if (VALUE_OPTS.has(name) && i + 1 < argList.length && !String(argList[i + 1]).startsWith('--')) {
        value = String(argList[i + 1]);
        i++;
      }
      if (value !== null) {
        if (name === 'set') sets.push(value);
        else opts[name] = value;
      }
    } else {
      positional.push(a);
    }
  }
  if (ctx && ctx.flags instanceof Set) for (const f of ctx.flags) flags.add(f);
  const apply = flags.has('apply') || flags.has('write') || (ctx && (ctx.apply === true || ctx.write === true));
  const winnerRaw = opts.winner != null ? opts.winner : (ctx && ctx.opts && ctx.opts.winner) || null;
  const winner = typeof winnerRaw === 'string' && winnerRaw.length > 0 ? winnerRaw : null;
  return { apply: !!apply, winner, sets, positional, flags };
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr. Returns `{ ok, data, findings, summary }`. Fail-open: any
 * internal failure degrades to an ok-ish empty result, never a throw.
 *
 * `list` writes NOTHING. `resolve`/`policy` write ONLY `.forge/adjudication.json` (and, on a
 * resolve --apply, `.forge/composition.json` via the compose helpers) under the active root and
 * ONLY under `--apply`; the default is always a preview. NO model/judge invocation.
 *
 * @param {string} subcmd list | resolve | policy
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
      case 'resolve':
        return await doResolve(activeRoot, n.positional[0] || null, n.winner, n.apply, ctx);
      case 'policy':
        return doPolicy(activeRoot, n.sets, n.apply);
      default:
        return result(false, { usage: usageText() }, [
          finding('ERROR', 'conflict', `unknown conflict subcommand: ${subcmd || '(none)'}`),
        ]);
    }
  } catch (e) {
    return result(false, null, [
      finding('ERROR', 'conflict', `conflict error: ${e && e.message ? e.message : String(e)}`),
    ]);
  }
}

/**
 * `list` — derive conflicts from the catalog DEDUP view (reused), filtered to the project
 * read-view, grouping each conflict-class uid's distinct candidates; attach the recorded judge
 * verdict + real eval scores; compute suggested + state from the policy + recorded choices.
 * Read-only, fail-open, NO model call (BR-CAT-010/011).
 *
 * Returns `data { adjudicationPath, policy, conflicts:[ <CONFLICT> ], counts:{ total, blocking,
 * auto, manual } }` (ADR-0020 §6).
 */
async function doList(activeRoot) {
  const findings = [];
  const { adj, existed, malformed } = readAdjudication(activeRoot);
  if (malformed) {
    findings.push(finding('WARN', relAdjudication(activeRoot), 'adjudication.json is not a JSON object — treating as default (all-block, no choices)'));
  } else if (!existed) {
    findings.push(finding('INFO', relAdjudication(activeRoot), 'no adjudication file yet — policy defaults to all-block; no recorded choices (opt-in)'));
  }

  const forgeRoot = selfForgeRoot();
  const subscribedSet = readSubscribedSet(activeRoot);
  const { records, findings: catFindings } = await catalogDedupRecords();
  for (const f of catFindings) findings.push(f);

  const readView = filterReadView(records, subscribedSet);
  const verdictRecords = readVerdictRecords(forgeRoot);
  const evalByUid = readEvalScores(forgeRoot);
  const choiceByUid = new Map(adj.choices.map((c) => [c.uid, c]));

  const conflicts = assembleConflicts(readView, adj.policy, choiceByUid, verdictRecords, evalByUid);

  const counts = { total: conflicts.length, blocking: 0, auto: 0, manual: 0 };
  for (const c of conflicts) {
    if (c.state === 'blocking') counts.blocking++;
    else if (c.state === 'auto') counts.auto++;
    else if (c.state === 'manual') counts.manual++;
  }

  if (conflicts.length === 0) {
    findings.push(finding('INFO', 'conflict', 'no read-view conflicts — every adopted uid resolves to a single candidate'));
  } else if (counts.blocking > 0) {
    findings.push(finding('WARN', 'conflict', `${counts.blocking} blocking conflict(s) — the composition is blocked until each is resolved (forge conflict resolve <uid> --winner <sourceId|library> --apply)`));
  }

  return result(true, {
    adjudicationPath: adjudicationPath(activeRoot),
    policy: adj.policy,
    conflicts,
    counts,
  }, findings, {
    total: counts.total,
    blocking: counts.blocking,
    auto: counts.auto,
    manual: counts.manual,
  });
}

/**
 * `resolve <uid> --winner <sourceId|"library"> [--apply]` — record the human's T2 pick in
 * `choices`. On `--apply` ALSO update the composition (`.forge/composition.json`) so the winner's
 * `(uid, sourceId)` is adopted and the losing peers for that uid are removed, REUSING the ADR-0019
 * compose helpers (manager/compose.mjs). Idempotent. Preview by default. NEVER self-applies a
 * library replace — recording the human's explicit choice IS the deliberate T2 action (BR-CAT-003,
 * BR-CAT-013).
 *
 * `--winner library` (or `--winner` omitted-equivalent) selects the library-local copy
 * (sourceId === null); any other value is a source id.
 */
async function doResolve(activeRoot, uid, winnerArg, apply, ctx) {
  const findings = [];
  if (!uid) {
    return result(false, { usage: usageText() }, [
      finding('ERROR', 'conflict', 'resolve requires a <uid> argument ("<kind>:<id>", e.g. "skill:run-eval")'),
    ]);
  }
  if (!UID_RE.test(uid)) {
    return result(false, { uid, plan: { changed: false } }, [
      finding('ERROR', 'conflict', `invalid uid "${uid}" (must be "<kind>:<id>", e.g. "skill:run-eval")`),
    ]);
  }
  if (winnerArg === null) {
    return result(false, { uid, plan: { changed: false } }, [
      finding('ERROR', 'conflict', 'resolve requires --winner <sourceId|"library"> (the human T2 pick; use "library" for the library-local copy)'),
    ]);
  }
  // "library" (case-insensitive) is the library-local copy (sourceId === null); else a source id.
  const isLibrary = winnerArg.toLowerCase() === 'library';
  const winner = isLibrary ? null : winnerArg;
  if (winner !== null && !SOURCE_ID_RE.test(winner)) {
    return result(false, { uid, winner, plan: { changed: false } }, [
      finding('ERROR', 'conflict', `invalid --winner "${winnerArg}" (a source id like "acme-skills", or "library" for the library-local copy)`),
    ]);
  }

  const { adj, malformed } = readAdjudication(activeRoot);
  if (malformed) {
    return result(false, { uid, winner, plan: { changed: false } }, [
      finding('ERROR', relAdjudication(activeRoot), 'adjudication.json is not a JSON object — refusing to edit'),
    ]);
  }

  // Record the choice (last write per uid wins). Idempotent: an identical recorded choice is a no-op.
  const prior = adj.choices.find((c) => c.uid === uid) || null;
  const sameChoice = prior && prior.winner === winner;
  const nextChoices = adj.choices.filter((c) => c.uid !== uid).concat([{ uid, winner }]);
  const where = winner === null ? '(library-local)' : `(source "${winner}")`;

  if (sameChoice) {
    findings.push(finding('WARN', relAdjudication(activeRoot), `"${uid}" already resolved to ${where} — no change (idempotent)`));
  } else {
    findings.push(finding('INFO', 'conflict', `resolve "${uid}" -> winner ${where}: recorded the human T2 pick (BR-CAT-013)`));
  }
  const choiceChanged = !sameChoice;

  // The composition write (winner adopted, losers removed) happens on --apply via compose.mjs.
  let written = false;
  let composeApplied = false;
  const composeFindings = [];
  if (apply) {
    written = writeJsonAtomic(adjudicationPath(activeRoot), normalizeForWrite(adj.policy, nextChoices));
    if (!written) {
      findings.push(finding('WARN', relAdjudication(activeRoot), 'could not write adjudication.json'));
    } else {
      // Update the composition: adopt the winner's (uid, sourceId), remove the losing peers. We
      // REUSE manager/compose.mjs (BR-CAT-013) rather than duplicating the write logic. A resolve
      // that supersedes an admitted library resource is THIS deliberate human --apply, never
      // self-applied (BR-CAT-003).
      const res = await applyToComposition(uid, winner, activeRoot, ctx);
      composeApplied = res.applied;
      for (const f of res.findings) composeFindings.push(f);
    }
  } else if (choiceChanged) {
    findings.push(finding('INFO', relAdjudication(activeRoot), 'dry-run: pass --apply to record the pick and update the composition'));
  }

  for (const f of composeFindings) findings.push(f);

  return result(true, {
    uid,
    winner,
    adjudicationPath: adjudicationPath(activeRoot),
    applied: !!apply,
    written,
    composeApplied,
    changed: choiceChanged,
    choices: normalizeForWrite(adj.policy, nextChoices).choices,
    plan: { changed: choiceChanged },
  }, findings, {
    resolved: choiceChanged ? 1 : 0,
    written: written ? 1 : 0,
  });
}

/**
 * Apply a resolved winner to the composition (BR-CAT-013): adopt the winner's (uid, sourceId) and
 * remove the LOSING peers for that uid. We REUSE manager/compose.mjs `adopt`/`remove` — we do not
 * duplicate the write logic. The losing peers are the conflict's OTHER candidate sourceIds (from
 * the current read-view) AND any other adopted (uid, sourceId) entries for this uid in the
 * composition. Fail-open: a compose failure degrades to a WARN; the recorded choice still stands.
 *
 * @param {string} uid @param {string|null} winner @param {string} activeRoot @param {any} ctx
 * @returns {Promise<{applied:boolean, findings:import('./lib/findings.mjs').Finding[]}>}
 */
async function applyToComposition(uid, winner, activeRoot, ctx) {
  const findings = [];
  const cwd = activeRoot;
  // 1. Determine the losing peers from the CURRENT read-view conflict candidates.
  /** @type {Set<string|null>} */
  const losers = new Set();
  try {
    const subscribedSet = readSubscribedSet(activeRoot);
    const { records } = await catalogDedupRecords();
    const readView = filterReadView(records, subscribedSet);
    for (const rec of readView) {
      if (rec.uid !== uid) continue;
      const sid = recordSourceId(rec);
      if (sid !== winner) losers.add(sid);
    }
  } catch (e) {
    findings.push(finding('WARN', 'conflict', `could not derive losing peers for "${uid}": ${e && e.message ? e.message : String(e)}`));
  }
  // 2. Also drop any already-adopted peer entries for this uid that are not the winner (so a prior
  //    adoption of a now-losing candidate is superseded).
  try {
    const compRaw = readJson(path.join(activeRoot, '.forge', 'composition.json'));
    const adopted = compRaw && Array.isArray(compRaw.adopted) ? compRaw.adopted : [];
    for (const e of adopted) {
      if (!e || typeof e !== 'object') continue;
      if (e.uid !== uid) continue;
      const sid = typeof e.sourceId === 'string' && e.sourceId ? e.sourceId : null;
      if (sid !== winner) losers.add(sid);
    }
  } catch {
    /* no composition yet — nothing previously adopted to drop */
  }

  // 3. Adopt the winner (idempotent in compose.mjs). `--source` is the winner sourceId, or omitted
  //    for the library-local copy. compose validates read-view membership (BR-CAT-008).
  const adoptArgs = ['adopt', uid, '--apply'];
  if (winner !== null) adoptArgs.push('--source', winner);
  try {
    const res = await composeRun('adopt', adoptArgs.slice(1), { cwd });
    if (res && res.ok) {
      findings.push(finding('INFO', 'conflict', `composition: adopted winner "${uid}"${winner === null ? ' (library-local)' : ` (source "${winner}")`}`));
    } else {
      const why = res && Array.isArray(res.findings) ? res.findings.filter((f) => f.level === 'ERROR').map((f) => f.message).join('; ') : '';
      findings.push(finding('WARN', 'conflict', `composition adopt of winner "${uid}" did not apply${why ? `: ${why}` : ''} — the recorded choice still stands`));
    }
  } catch (e) {
    findings.push(finding('WARN', 'conflict', `composition adopt failed: ${e && e.message ? e.message : String(e)}`));
  }

  // 4. Remove each losing peer (idempotent — an unadopted peer is a no-op in compose.mjs).
  let removed = 0;
  for (const sid of [...losers].sort(compareSourceId)) {
    const removeArgs = ['--apply'];
    if (sid !== null) removeArgs.push('--source', sid);
    try {
      const res = await composeRun('remove', [uid, ...removeArgs], { cwd });
      if (res && res.ok && res.data && res.data.changed) removed++;
    } catch {
      /* fail-open: a torn remove never aborts the resolve */
    }
  }
  if (removed > 0) {
    findings.push(finding('INFO', 'conflict', `composition: dropped ${removed} losing peer(s) for "${uid}"`));
  }

  return { applied: true, findings };
}

/**
 * `policy [--set <dim>=<mode>]... [--apply]` — get (no --set) or set the per-criticality policy.
 * Each `--set` is `<normal|compliance|safety>=<auto|block>`; values are validated. Preview by
 * default; --apply writes adjudication.json atomically + additively (creating it on first
 * --apply, preserving the recorded choices). BR-CAT-012.
 */
function doPolicy(activeRoot, sets, apply) {
  const findings = [];
  const { adj, malformed } = readAdjudication(activeRoot);
  if (malformed) {
    return result(false, { policy: defaultPolicy(), plan: { changed: false } }, [
      finding('ERROR', relAdjudication(activeRoot), 'adjudication.json is not a JSON object — refusing to edit'),
    ]);
  }

  // GET (no --set): just return the current policy.
  if (!Array.isArray(sets) || sets.length === 0) {
    return result(true, {
      adjudicationPath: adjudicationPath(activeRoot),
      policy: adj.policy,
      applied: false,
      written: false,
      changed: false,
      plan: { changed: false },
    }, findings, { policy: 1 });
  }

  // SET: parse + validate each --set <dim>=<mode>.
  const nextPolicy = { ...adj.policy };
  let changed = false;
  for (const raw of sets) {
    const eq = String(raw).indexOf('=');
    const dim = eq >= 0 ? String(raw).slice(0, eq) : String(raw);
    const mode = eq >= 0 ? String(raw).slice(eq + 1) : '';
    if (!CRITICALITIES.includes(dim)) {
      return result(false, { policy: adj.policy, plan: { changed: false } }, [
        finding('ERROR', 'conflict', `invalid policy dimension "${dim}" (must be one of ${CRITICALITIES.join('|')})`),
      ]);
    }
    if (!POLICY_MODES.has(mode)) {
      return result(false, { policy: adj.policy, plan: { changed: false } }, [
        finding('ERROR', 'conflict', `invalid policy mode "${mode}" for "${dim}" (must be auto|block)`),
      ]);
    }
    if (nextPolicy[dim] !== mode) {
      nextPolicy[dim] = mode;
      changed = true;
    }
  }

  if (changed) {
    findings.push(finding('INFO', 'conflict', `policy: ${CRITICALITIES.map((c) => `${c}=${nextPolicy[c]}`).join(' ')}`));
  } else {
    findings.push(finding('WARN', relAdjudication(activeRoot), 'policy unchanged — no change (idempotent)'));
  }

  let written = false;
  if (apply && changed) {
    written = writeJsonAtomic(adjudicationPath(activeRoot), normalizeForWrite(nextPolicy, adj.choices));
    if (!written) findings.push(finding('WARN', relAdjudication(activeRoot), 'could not write adjudication.json'));
  } else if (!apply && changed) {
    findings.push(finding('INFO', relAdjudication(activeRoot), 'dry-run: pass --apply to write the policy'));
  }

  return result(true, {
    adjudicationPath: adjudicationPath(activeRoot),
    policy: nextPolicy,
    applied: !!apply,
    written,
    changed,
    plan: { changed },
  }, findings, {
    policy: 1,
    written: written ? 1 : 0,
  });
}

/**
 * C4 `summarize(state)` — pure; map a run-state to a one-panel summary. Returns a `(no data)`
 * panel when no conflicts array is present (fail-open).
 * @param {any} state @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  const conflicts = state && typeof state === 'object' && Array.isArray(state.conflicts) ? state.conflicts : null;
  if (!conflicts) {
    return makePanel({ panel: 'conflict', ok: false, lines: ['(no data)'], hint: 'forge conflict list' });
  }
  const blocking = conflicts.filter((c) => c && c.state === 'blocking').length;
  return makePanel({
    panel: 'conflict',
    ok: blocking === 0,
    lines: [`${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}`, `${blocking} blocking`],
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

/** Stamp a C2 finding from this module (conflict pre-filled). */
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
    'forge conflict list [--json]',
    'forge conflict resolve <uid> --winner <sourceId|"library"> [--apply]   (uid = "<kind>:<id>")',
    'forge conflict policy [--set normal=auto|block] [--set compliance=...] [--set safety=...] [--apply]',
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
    const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    if (conflicts.length === 0) out.push('conflict: no read-view conflicts');
    for (const c of conflicts) {
      const cands = (c.candidates || []).map((cd) => (cd.sourceId === null ? 'library' : cd.sourceId)).join(', ');
      out.push(`  [${c.state}] ${c.uid}\t${c.criticality}\tcandidates: ${cands}\tsuggested: ${c.suggested === null ? '—' : c.suggested}`);
    }
  } else if (subcmd === 'resolve') {
    const where = data.winner === null || data.winner === undefined ? '(library-local)' : `(source "${data.winner}")`;
    out.push(`conflict resolve ${data.uid || ''} ${where}: ${data.changed ? 'recorded' : 'no change'}${data.applied ? `, ${data.written ? 'written' : 'not written'}${data.composeApplied ? ' + composition updated' : ''}` : (data.changed ? ' (preview — pass --apply)' : '')}`);
  } else if (subcmd === 'policy') {
    const p = data.policy || {};
    out.push(`conflict policy: ${CRITICALITIES.map((c) => `${c}=${p[c] || 'block'}`).join(' ')}${data.applied ? (data.written ? ' (written)' : (data.changed ? ' (not written)' : '')) : (data.changed ? ' (preview — pass --apply)' : '')}`);
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
//   node manager/conflict.mjs <subcmd> [flags] [uid]
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
          command: `conflict ${subcmd || ''}`.trim(),
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
