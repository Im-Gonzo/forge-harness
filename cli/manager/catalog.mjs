// @ts-check
/**
 * catalog — the manager's federated-catalog + admission operator (ADR-0017).
 *
 * The CATALOG is the SUPERSET of discoverable resources: everything in the active
 * LIBRARY (today's registry) PLUS every resource synced from a registered external
 * SOURCE (manager/source.mjs). A catalog-only resource is DISCOVERABLE but INERT —
 * it is never resolved by composition, installed, or executed until it is ADMITTED
 * into the library via `forge catalog admit` (catalog-until-admitted, LOCKED fork
 * #2). The LIBRARY is the active, curated subset; the CATALOG is the discoverable
 * whole. This module owns the catalog VIEW + the admission/revoke lifecycle; the
 * source REGISTRY half lives in manager/source.mjs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CATALOG RECORD shape (the contract Build agents consume verbatim)
 * ─────────────────────────────────────────────────────────────────────────────
 * A catalog record = a registry ARTIFACT record (schemas/registry.schema.json) +
 * federated `source` provenance + an `admissionState` + dedup/judge verdict slots:
 *
 * @typedef {Object} CatalogSourceProvenance
 * @property {string} sourceId   The source id this record came from (-> manifests/sources.json#sources[].id).
 * @property {string} repoUrl    Clone URL (git) or filesystem path (local) of the source.
 * @property {string} ref        Branch/tag/commit the source tracks.
 * @property {string} commit     Exact upstream commit the bytes were synced from (.forge/sources.lock).
 * @property {string} importedAt ISO-8601 timestamp the record entered the catalog.
 * @property {string} trust      The SOURCE's trust level at build time ('untrusted'|'reviewed'|'')
 *           copied from manifests/sources.json. The T2 admit gate consults it: admitting an
 *           EXECUTABLE kind from a source whose trust !== 'reviewed' requires a human override.
 *
 * @typedef {Object} CatalogDedupVerdict
 * @property {'unique'|'exact-dup'|'uid-collision'|'near-dup'} class
 *           Deterministic dedup classification vs the existing catalog/library:
 *             - 'unique'        — no peer; admittable without conflict resolution.
 *             - 'exact-dup'     — identical contentHash to a peer (ADR-0005); no-op admit.
 *             - 'uid-collision' — same uid, DIFFERENT bytes (a conflict → judge/T2 gate).
 *             - 'near-dup'      — similar but not identical (a conflict → judge).
 * @property {string[]} peers    uids of the peer record(s) this verdict refers to.
 *
 * @typedef {Object} CatalogJudgeVerdict
 * @property {string} verdict    The agent's decision (e.g. 'admit'|'reject'|'supersede').
 * @property {string} rationale  Short human-readable rationale.
 *
 * @typedef {Object} CatalogDeterministicScan
 *           A LIGHTWEIGHT SUMMARY of the layer-1 deterministic scanners (F11 scaling fix).
 *           The scanners (scan-injection + scan-resource-safety) can emit THOUSANDS of
 *           findings per record on a real source (one real-world source produced 656,329 evidence
 *           entries across 434 records → a ~189 MB list payload). Embedding every finding,
 *           per record, in the LIST output (build/ls/dedup) does NOT scale — the web bridge
 *           accumulates the whole string and JSON.parse fails. So the LIST carries a SUMMARY,
 *           NOT all evidence. The full findings are computed in `runSecurityScan` to determine
 *           the headline `scan` state (flagged/clean) EXACTLY as before, then discarded once
 *           the summary is built — only `scan` (the classification) and this summary survive
 *           into the record. Full deterministic evidence is reproducible on demand by re-running
 *           the scanners on a single candidate at audit time (the per-record cost is bounded).
 * @property {number} findingCount  Total number of deterministic findings the scanners produced.
 * @property {number} high          Count of high-severity findings (drives flagged + the gate).
 * @property {number} medium        Count of medium-severity findings (also drives flagged).
 * @property {Array<Object>} sample  The FIRST few findings (default 3) verbatim
 *           ({ rule, severity, path, line, evidence, message }) — a representative preview,
 *           NOT the whole set. Empty when no signature matched.
 *
 * @typedef {Object} CatalogAuditorVerdict
 * @property {string} agent     The auditor agent id (e.g. 'injection-auditor', 'repo-safety-auditor').
 * @property {'clean'|'suspicious'|'malicious'} verdict
 *           The auditor's semantic verdict (repo-safety-auditor maps safe→clean / risky→suspicious /
 *           malicious→malicious into this slot; its raw safe|risky|malicious + recommended action
 *           live in its evidence). 'suspicious'|'malicious' → quarantine.
 * @property {string[]} evidence  Quoted file:line evidence backing the verdict.
 *
 * @typedef {Object} CatalogSecurity
 * @property {'pending'|'clean'|'flagged'|'quarantined'} scan
 *           Overall security-scan state (ADR-0017 §5a): 'pending' = not yet run;
 *           'clean' = deterministic + auditor passes; 'flagged' = a deterministic
 *           scanner matched; 'quarantined' = flagged/auditor-adverse → never auto-admitted.
 * @property {CatalogDeterministicScan} deterministic  Layer-1 scanner results (always run, cheap).
 * @property {CatalogAuditorVerdict[]} auditors        Layer-2 auditor agent verdicts (on flag, or
 *           ALWAYS for executable kinds). Empty when no auditor ran.
 * @property {boolean} humanOverride  Set ONLY by a deliberate human action (T2). The pipeline never
 *           sets it. A quarantined candidate — and any executable kind from an untrusted source —
 *           cannot be admitted until this is true.
 *
 * @typedef {Object} CatalogRecord
 * @property {string} uid        Registry artifact uid "<kind>:<id>".
 * @property {string} kind       Registry artifact kind.
 * @property {string} id         Kind-local id.
 *           ...all other registry ARTIFACT fields (path, contentHash, revision,
 *           version, status, criticality, owner, description, tags, modules,
 *           dependsOn, eval, createdAt, updatedAt) — see schemas/registry.schema.json.
 * @property {CatalogSourceProvenance|null} source
 *           Federated provenance. null for an owned/library-local record.
 * @property {'catalog'|'admitted'|'quarantined'} admissionState
 *           - 'catalog'     — discoverable but INERT (default for synced records).
 *           - 'admitted'    — promoted into the active library (a normal artifact).
 *           - 'quarantined' — flagged by validate/security-scan/test or a held conflict; never active.
 * @property {CatalogSecurity} security   Security-scan gate slot (ADR-0017 §5a).
 * @property {CatalogDedupVerdict} dedup   Dedup classification slot (deterministic).
 * @property {CatalogJudgeVerdict|null} judge
 *           Agent verdict slot, populated ONLY on a conflict (uid-collision/near-dup);
 *           null otherwise (deterministic outcomes spend NO model call).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADMISSION PIPELINE (contract now; logic in a later Build phase)
 * ─────────────────────────────────────────────────────────────────────────────
 *   validate (structural; lint/run-all over a STAGING dir) ->
 *   security-scan (safety; §5a — deterministic scanners THEN auditor agents) ->
 *   dedup (deterministic) -> judge (agent, ONLY on conflict) ->
 *   test (eval-harness if a golden set) -> admit.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY-SCAN GATE (ADR-0017 §5a — between validate and dedup)
 * ─────────────────────────────────────────────────────────────────────────────
 *   - Layer 1, DETERMINISTIC (cheap, runs first on every candidate): the two zero-dep
 *     scanners scanInjection() + scanResourceSafety() (imported below). Their findings
 *     populate record.security.deterministic.findings.
 *   - Layer 2, AUDITOR AGENTS (for what static cannot catch): agents/injection-auditor.md
 *     + agents/repo-safety-auditor.md run when layer 1 flags anything, AND ALWAYS for
 *     EXECUTABLE kinds (hook/command/any .mjs/.sh). Their verdicts populate
 *     record.security.auditors[].
 *   - OUTCOME: any deterministic flag OR any adverse auditor verdict → admissionState
 *     "quarantined"; a quarantined candidate is admittable ONLY by explicit HUMAN
 *     override (T2; record.security.humanOverride). Executable kinds from an untrusted
 *     source ALWAYS require auditor verdicts + human override even on a clean scan.
 *   - INVARIANT: scanners + auditors treat candidate content as UNTRUSTED DATA, never
 *     instructions (rules/prompt-defense-baseline.md). sync only clones+reads; fetched
 *     code is NEVER executed during scan or admission.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY STANCE (external repos are UNTRUSTED — baked into the contract now)
 * ─────────────────────────────────────────────────────────────────────────────
 *   - Admitting an EXECUTABLE kind (hook/command) from a source whose trust !==
 *     "reviewed", a deterministically FLAGGED/QUARANTINED candidate, OR a candidate
 *     with an ADVERSE auditor verdict (suspicious|malicious) is HUMAN-GATED (T2):
 *     `admit` REFUSES it unless `--override` (the human T2 apply). These gates are LIVE
 *     (evaluateAdmitGate); only the library-activation side-effect is deferred.
 *   - `admit`/`revoke` here CONSULT the gate + RECORD their outcome to the verdict
 *     sidecar; they do not yet flip live library state. They always return VALID
 *     envelopes so the CLI never crashes.
 *
 * HARD INVARIANTS (the plugin payload contract): zero runtime deps (node: builtins
 * + relative imports only — lint/validate-manager-zerodep.mjs enforces this);
 * additive-never-destructive; writers PREVIEW by default; fail-open (no public entry
 * throws past its surface — it degrades to a safe `{ok,data,findings,summary}`
 * envelope). Dual-mode with an `isMain()` guard — NEVER process.exit() at import time.
 *
 * Subcommands (C4 `run(subcmd, args, ctx)`):
 *   - `build`         — LIVE: assemble the unified catalog = local library (registry,
 *                       source=null/admitted) ∪ every synced source's resources
 *                       (source-tagged/catalog). Runs the DETERMINISTIC security scan
 *                       (runSecurityScan) on every SOURCE candidate and MERGES the
 *                       recorded sidecar verdicts back in. Read-only. { schema, records:[...] }.
 *   - `ls`            — LIVE: list catalog records (the build view).
 *   - `dedup`         — LIVE: deterministic dedup classification across the catalog;
 *                       populates record.dedup={class,peers} + emits counts + conflicts.
 *   - `audit <uid> --agent <name> --verdict clean|suspicious|malicious [--evidence <s>] [--apply]`
 *                     — RECORD an auditor AGENT's verdict (the agent runs in the Claude
 *                       session; this verb only persists it) → sidecar auditors[]. Dry-run
 *                       by default; --apply writes.
 *   - `judge <uid> --verdict keep|replace|both|quarantine [--rationale <s>] [--apply]`
 *                     — RECORD the JUDGE agent's conflict decision → sidecar judge. Dry-run
 *                       by default; --apply writes.
 *   - `admit <uid> [--source <id>] [--override] [--apply]`
 *                     — CONSULT the T2 security gate (evaluateAdmitGate) AND, when it clears
 *                       (or --override for a T2 human-approved case) under --apply, ACTIVATE
 *                       the candidate into the active library: resolve the canonical target
 *                       (kind+id → componentCandidates), COPY the resource bytes from the
 *                       source resource root to the target (skills copy the whole dir),
 *                       and record provenance in manifests/admitted.json. A REPLACE of an
 *                       existing library resource needs --override (T2) and backs up the
 *                       replaced bytes for revoke. Dry-run prints the activation PLAN (writes
 *                       nothing). SECURITY: copies bytes only, NEVER executes.
 *   - `revoke <uid> [--apply]`
 *                     — DELETE the copied library target (restore a replaced original from
 *                       the admitted record's backup) and drop the uid from admitted.json +
 *                       RECORD the outcome. Dry-run plans; --apply executes; idempotent.
 *
 * @module manager/catalog
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
// The storage SEAM (ADR-0003, SPEC-09). We route the verdict SIDECAR through the same
// atomic temp-rename writer + fail-open JSON reader the registry uses — no direct `fs`
// for state — and resolve its path under the git-tracked `forgeStateDir()` (.forge/).
import { readJson, writeJsonAtomic, forgeStateDir, forgeHome } from './lib/store.mjs';
// Security-scan gate scanners (ADR-0017 §5a, layer 1). These are DETERMINISTIC,
// zero-dep, fail-open functions the admission pipeline runs on a candidate. Importing
// them here makes the security-scan step's contract REAL even while the logic is a
// stub — Build agents wire the planned engine behind these exact signatures. They only
// READ + pattern-match the candidate; candidate code is NEVER executed (untrusted DATA).
import { scanInjection } from './lib/scan-injection.mjs';
import { scanResourceSafety } from './lib/scan-resource-safety.mjs';
// kind<->path resolution (SPEC-01). admit ACTIVATION resolves the canonical LIBRARY
// target for a cleared candidate by reusing `componentCandidates` — the SAME mapping
// the registry scan + composition validator use — so an admitted artifact lands at the
// exact path the registry will later rediscover it at (no drift). We never EXECUTE the
// resolver's targets; admit only COPIES bytes (ADR-0017 §security: fetched code is data).
import { componentCandidates } from './lib/resolve-kind.mjs';
// The PURE library scanner (manager/registry.mjs#buildRegistry). It walks a root and
// returns registry ARTIFACT records — the exact base shape a CatalogRecord wraps. We
// reuse it VERBATIM for the local library AND for each synced source's resource root,
// so a catalog record's identity/contentHash matches the registry's byte-for-byte. The
// Foundation comment refers to it as `../registry.mjs`; the module physically lives
// beside us at `manager/registry.mjs`, so the correct zero-dep relative import is
// `./registry.mjs` (a sibling, still a node:-or-relative specifier — zerodep-clean).
import { buildRegistry } from './registry.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The emitter stamped on findings this module raises (C2 `source`). */
const SOURCE = 'catalog';

/**
 * The admission pipeline stages, in order (the contract; logic lands later). The
 * security-scan SAFETY gate sits between validate (structural) and dedup (ADR-0017 §5a).
 */
const PIPELINE = ['validate', 'security-scan', 'dedup', 'judge', 'test', 'admit'];

/**
 * Executable artifact kinds — these ALWAYS require auditor verdicts + human override (§5a).
 * `mcp` is included because an MCP server resource configures/launches an external program
 * (a command/url the host process spawns); admitting one from an untrusted source is exactly
 * as dangerous as a hook/command, so the executable-from-untrusted gate, the
 * repo-safety-auditor requirement, AND the resource-safety scan ALL apply to it.
 */
const EXECUTABLE_KINDS = ['hook', 'command', 'mcp'];

/**
 * Script file extensions a hook `command` may invoke (mirrors scan-resource-safety's
 * CODE_EXT). `resolveScanTargets` follows a hook's hooks.json command to the first token
 * whose extension is in this set — the real script to scan, NOT the `hooks/hooks.json#<id>`
 * registry pseudo-path (the BLOCKING bypass this fix closes).
 */
const HOOK_SCRIPT_EXT = new Set(['.mjs', '.js', '.cjs', '.sh', '.bash', '.zsh', '.ts', '.mts', '.cts']);

/** Fast membership test for the executable-kind T2 gate. */
const EXECUTABLE_KIND_SET = new Set(EXECUTABLE_KINDS);

/**
 * The trust level a source must carry before an EXECUTABLE kind may be admitted from
 * it (mirrors source.mjs#TRUST_REVIEWED — the human untrusted→reviewed flip). Any other
 * trust value (untrusted/'' /unknown) gates an executable admission behind T2 override.
 */
const TRUST_REVIEWED = 'reviewed';

/**
 * Deterministic-scan states the admit gate REFUSES on (security.scan ∈ this set →
 * blocked unless --override). 'clean'/'pending' are admittable (pending = a library
 * record we never scan; a clean source candidate passes the scan gate).
 */
const BLOCKING_SCAN_STATES = new Set(['flagged', 'quarantined']);

/** Auditor verdicts the admit gate REFUSES on (any auditor at/above this → blocked). */
const ADVERSE_AUDITOR_VERDICTS = new Set(['malicious', 'suspicious']);

// SECURITY (round 2 FIX 2): there is DELIBERATELY no out-of-band env-token confirmation for a
// HIGH-RISK admit. A bare env token (e.g. FORGE_ADMIT_CONFIRM===uid) is FORGEABLE — an in-session
// agent with Bash can `export` it itself and the spawned child inherits the agent's env, so it is
// NOT a genuine-human signal. The ONLY accepted HIGH-RISK override is an interactive-TTY readline
// confirmation (typing the exact uid); a non-interactive caller is REFUSED regardless of --override.

/**
 * The auditor agent ids the strengthened admit gate (require-auditor) requires a POSITIVE
 * clearance from before a SOURCE candidate may be admitted (ADR-0017 §5a):
 *   - INJECTION_AUDITOR — a 'clean' verdict is REQUIRED for EVERY source candidate (the
 *     deterministic scanner is a cheap pre-filter; the agent auditor is the required
 *     semantic net a paraphrase the regex misses still cannot slip past).
 *   - REPO_SAFETY_AUDITOR — additionally REQUIRED for EXECUTABLE kinds, and its verdict
 *     must NOT be adverse (risky/suspicious|malicious). It maps its raw safe|risky|malicious
 *     into the clean|suspicious|malicious slot (catalog doc) — we also reject the raw
 *     'risky'/'safe-absent' forms defensively.
 */
const INJECTION_AUDITOR = 'injection-auditor';
const REPO_SAFETY_AUDITOR = 'repo-safety-auditor';

/** Raw repo-safety-auditor verdicts (pre-mapping) the gate treats as adverse if recorded verbatim. */
const REPO_SAFETY_RAW_ADVERSE = new Set(['risky', 'malicious']);

/** The permitted vocabularies for the recorded agent verdicts (lenient: anything else → WARN). */
const AUDITOR_VERDICTS = new Set(['clean', 'suspicious', 'malicious']);
const JUDGE_VERDICTS = new Set(['keep', 'replace', 'both', 'quarantine']);

// ---------------------------------------------------------------------------
// Verdict SIDECAR — the agent verdicts the CLI records but does not compute.
// ---------------------------------------------------------------------------
//
// The auditor/judge AGENTS run inside the Claude session, NOT in this CLI. The CLI
// only RECORDS their verdicts (and admit/revoke outcomes) so a later `build` can read
// them back and merge them into the live-computed catalog records. We persist them to
// a sidecar JSON beside the registry state.
//
// SIDECAR PATH:  <forgeRoot>/.forge/catalog-verdicts.json
//
// SIDECAR SHAPE (forge.catalog-verdicts.v1):
//   {
//     "schema": "forge.catalog-verdicts.v1",
//     "version": 1,
//     "records": {
//        // key = "<sourceId>\u0000<uid>"  (sourceId is the source provenance id;
//        //                                  "" for the local/admitted library)
//        "anthropic-cookbook\u0000command:deploy": {
//          "sourceId": "anthropic-cookbook",
//          "uid": "command:deploy",
//          "auditors": [
//            { "agent": "injection-auditor", "verdict": "clean",
//              "evidence": ["agents/x.md:12 quoted text"], "recordedAt": "<iso>" }
//          ],
//          "judge": { "verdict": "keep", "rationale": "…", "recordedAt": "<iso>" } | null,
//          "admissions": [
//            { "action": "admit"|"revoke", "outcome": "admitted"|"refused"|"revoked",
//              "override": false, "reasons": ["…"], "recordedAt": "<iso>" }
//          ]
//        }
//     }
//   }
//
// The sidecar is keyed by "<sourceId>\u0000<uid>" so the SAME uid from two different
// sources (a uid-collision) keeps independent verdict trails. `build` reads it back and
// merges auditors → record.security.auditors[], judge → record.judge, and re-derives
// security.scan when an auditor verdict is adverse. Persisted atomically (store.mjs);
// dry-run by default, --apply writes (mirrors the manager's preview-by-default stance).

/** The verdict-sidecar schema tag + version (every persisted file carries these). */
const VERDICTS_SCHEMA_TAG = 'forge.catalog-verdicts.v1';
const VERDICTS_SCHEMA_VERSION = 1;

/** The NUL key separator joining "<sourceId>\u0000<uid>" in the sidecar (collision-safe). */
const KEY_SEP = '\u0000';

// ---------------------------------------------------------------------------
// ADMITTED MANIFEST — the provenance record of what admit ACTIVATED into the library.
// ---------------------------------------------------------------------------
//
// admit ACTIVATION copies a cleared candidate's bytes from its source resource root to
// the canonical LIBRARY target (componentCandidates). Every activation appends one
// provenance record to manifests/admitted.json so `revoke` can find + remove the copied
// target (and restore a replaced original). This is the AUTHORITATIVE list of admitted
// artifacts; the verdict sidecar's admissions[] keeps the audit trail, this keeps the
// reversible LIBRARY state. schemas/admitted.schema.json describes the on-disk shape.
//
// SHAPE (forge.admitted.v1):
//   {
//     "schema": "forge.admitted.v1",
//     "version": 1,
//     "admitted": [
//       { "uid": "agent:code-reviewer", "sourceId": "anthropic-cookbook",
//         "repoUrl": "https://…", "ref": "main", "commit": "abc123",
//         "kind": "agent", "targetPath": "agents/code-reviewer.md",
//         "admittedAt": "<iso>",
//         "replaced": { "path": "agents/code-reviewer.md", "backupB64": "<base64>" } }
//     ]
//   }
//
// `targetPath`/`replaced.path` are repo-relative (POSIX) under the FORGE library root.
// `replaced` is present ONLY when activation overwrote an existing library file (a REPLACE,
// T2/--override); its backupB64 is the base64 of the original bytes so revoke can restore.

/** The admitted-manifest schema tag + version (every persisted file carries these). */
const ADMITTED_SCHEMA_TAG = 'forge.admitted.v1';
const ADMITTED_SCHEMA_VERSION = 1;

/**
 * Map a SINGULAR registry kind (the catalog/uid vocabulary) to the PLURAL component kind
 * `componentCandidates` expects. Only the kinds the task enumerates as admittable resolve
 * to a canonical target; any other kind (validator/engine/hook/meta-test) returns ''
 * and is NOT activatable here (admit refuses with a clear reason — those are never copied
 * from an untrusted source in this phase).
 */
const KIND_TO_COMPONENT = {
  agent: 'agents',
  skill: 'skills',
  command: 'commands',
  rule: 'rules',
  bundle: 'bundles',
  workflow: 'workflows',
  mcp: 'mcp',
};

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

/** Best-effort FORGE library root = two levels up from this module (manager/..). */
function selfForgeRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

// ---------------------------------------------------------------------------
// normalize — mirrors mcp.mjs#normalize
// ---------------------------------------------------------------------------

/**
 * Flags that take a VALUE (the next non-`--` token, or a `--flag=value` form).
 * Everything else is a boolean toggle (e.g. `--apply`). Keeping this list explicit
 * lets `audit`/`judge` read `--agent <name> --verdict <v> --evidence <s>` etc. while
 * `admit`/`revoke` keep their bare `--apply`/`--override` toggles, and a value token
 * is never mistaken for a positional <uid>.
 */
const VALUE_FLAGS = new Set(['agent', 'verdict', 'evidence', 'rationale', 'now', 'source']);

/**
 * Normalise `ctx`/`args` to { apply, positional, flags, values }.
 *
 * `flags` is the Set of boolean toggles seen (apply, override, …). `values` is a
 * Map(name → string) for the VALUE_FLAGS (the last occurrence wins). A value flag
 * accepts both `--agent injection-auditor` (consume next token) and `--agent=injection-auditor`.
 */
function normalize(args, ctx) {
  const flags = new Set();
  const values = new Map();
  const positional = [];
  const argList = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  for (let i = 0; i < argList.length; i++) {
    const a = argList[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      if (VALUE_FLAGS.has(name)) {
        if (eq >= 0) {
          values.set(name, body.slice(eq + 1));
        } else if (i + 1 < argList.length && typeof argList[i + 1] === 'string' && !argList[i + 1].startsWith('--')) {
          values.set(name, argList[++i]); // consume the next token as this flag's value
        } else {
          values.set(name, ''); // value flag with no value → empty string (fail-open)
        }
      } else {
        flags.add(name);
      }
    } else {
      positional.push(a);
    }
  }
  if (ctx && ctx.flags instanceof Set) for (const f of ctx.flags) flags.add(f);
  if (ctx && ctx.values instanceof Map) for (const [k, v] of ctx.values) if (!values.has(k)) values.set(k, v);
  const apply = flags.has('apply') || flags.has('write') || (ctx && (ctx.apply === true || ctx.write === true));
  return { apply: !!apply, positional, flags, values };
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr. Returns `{ ok, data, findings, summary }`.
 * Fail-open: any internal failure degrades to an ok-ish empty result, never a throw.
 *
 * ALL verbs are PLANNED stubs this phase: they activate/de-activate/persist NOTHING
 * and return VALID envelopes (`build`/`ls` an empty catalog) so the CLI never crashes
 * and Build agents inherit the exact CatalogRecord + pipeline contract above.
 *
 * @param {string} subcmd build | ls | dedup | audit | judge | admit | revoke
 * @param {any} args string[] | { positional, flags }
 * @param {any} ctx { flags?, apply?, write?, values? }
 * @returns {Promise<{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const n = normalize(args, ctx);
    switch (subcmd) {
      case 'build':
        return doBuild();
      case 'ls':
        return doLs();
      case 'dedup':
        return doDedup();
      case 'audit':
        return doAudit(n);
      case 'judge':
        return doJudge(n);
      case 'admit':
        return doAdmit(n);
      case 'revoke':
        return doRevoke(n);
      default:
        return result(false, { usage: usageText() }, [
          finding('ERROR', 'catalog', `unknown catalog subcommand: ${subcmd || '(none)'}`),
        ]);
    }
  } catch (e) {
    return result(false, null, [
      finding('ERROR', 'catalog', `catalog error: ${e && e.message ? e.message : String(e)}`),
    ]);
  }
}

/**
 * `build` — assemble the UNIFIED catalog: the active LIBRARY (this CLI's registry
 * artifacts) UNION every resource synced from a registered source, each wrapped as a
 * CatalogRecord (registry artifact + `source` provenance + `admissionState` + the
 * `security`/`dedup`/`judge` verdict slots, all at their deterministic defaults).
 *
 *   - Local library: `buildRegistry(FORGE_ROOT)` → records tagged source=null,
 *     admissionState="admitted" (the active, curated library).
 *   - Each manifests/sources.json source: locate its cache dir, AUTO-DETECT the
 *     resource root inside it (marketplace.json plugin subdir → <cache>/agents|skills
 *     → one level down), `buildRegistry(resourceRoot)` → records tagged with
 *     {sourceId,repoUrl,ref,commit,importedAt} provenance and admissionState="catalog".
 *
 * READ-ONLY: build never writes (no --apply needed). Fail-open: a missing/unsynced/
 * malformed source degrades to an INFO/WARN finding and contributes zero records; it
 * never aborts the build. `records: []` is the canonical empty shape (no sources, no
 * library files).
 *
 * @returns {{ok:boolean, data:{schema:string, records:CatalogRecord[]}, findings:any[], summary:object}}
 */
function doBuild() {
  const forgeRoot = selfForgeRoot();
  const findings = [];

  // --- 1. LOCAL LIBRARY (the active, admitted subset) ----------------------
  /** @type {CatalogRecord[]} */
  let records = [];
  try {
    const built = buildRegistry(forgeRoot, null);
    const artifacts = Array.isArray(built.artifacts) ? built.artifacts : [];
    records = artifacts.map((a) => toCatalogRecord(a, null, 'admitted'));
    // Surface the library scanner's own ERROR findings (unreadable/malformed) so a
    // broken local artifact is visible in the catalog build, never silently dropped.
    for (const f of built.findings || []) {
      if (f && f.level === 'ERROR') findings.push(finding('ERROR', f.path || 'catalog', `library: ${f.message}`));
    }
  } catch (e) {
    findings.push(finding('ERROR', 'catalog', `library scan failed: ${e && e.message ? e.message : String(e)}`));
    records = [];
  }
  const libraryCount = records.length;

  // --- 2. EVERY SYNCED SOURCE (discoverable, INERT until admitted) ---------
  const { sources, lock } = readSourcesAndLock(forgeRoot);
  let sourcesWithRecords = 0;
  for (const src of sources) {
    const sourceId = src && typeof src.id === 'string' ? src.id : null;
    if (!sourceId) continue;
    const located = locateResourceRoot(src);
    if (!located.cacheExists) {
      const isLocal = src && src.kind === 'local';
      findings.push(finding('INFO', 'catalog', isLocal
        ? `source "${sourceId}" (local) path not found at ${located.cacheDir} — check its url/path`
        : `source "${sourceId}" not synced yet (no cache at ${located.cacheDir}) — run \`forge source sync ${sourceId}\``));
      continue;
    }
    if (!located.resourceRoot) {
      findings.push(finding('WARN', 'catalog', `source "${sourceId}" synced but no resource root detected (no agents/, skills/, marketplace plugin, or one-level-down dir under ${located.cacheDir})`));
      continue;
    }
    const provenance = makeProvenance(src, lock.get(sourceId) || null);
    let added = 0;
    let flaggedHere = 0;
    try {
      const built = buildRegistry(located.resourceRoot, null);
      const artifacts = Array.isArray(built.artifacts) ? built.artifacts : [];
      // DEFENSE-IN-DEPTH (ADR-0017 §5a): walk the WHOLE source resource root ONCE for
      // EVERY executable file (*.mjs/.js/.cjs/.sh/.bash/.zsh + any shebanged file) and
      // safety-scan them — scanResourceSafety already accepts a directory and recurses.
      // This catches a malicious script that is NOT a registered hook (so it would never
      // be reached by per-record resolution), flagging the whole source. Computed once
      // per source (not per record) and folded into every source candidate so the source
      // cannot be admitted while it carries any high/medium executable finding.
      const sourceWideFindings = scanSourceExecutables(located.resourceRoot);
      for (const a of artifacts) {
        const rec = toCatalogRecord(a, provenance, 'catalog');
        // SECURITY-SCAN GATE (ADR-0017 §5a, layer 1). Source candidates are UNTRUSTED;
        // run the deterministic scanners over the candidate's REAL file (resolving a
        // hook's script from hooks.json, NOT the hooks/hooks.json#<id> pseudo-path) and
        // fold the result + the source-wide executable findings into rec.security.
        // Fail-open per record: a torn scan never aborts build (see runSecurityScan).
        runSecurityScan(rec, located.resourceRoot, sourceWideFindings);
        if (rec.security && (rec.security.scan === 'flagged' || rec.security.scan === 'quarantined')) flaggedHere++;
        records.push(rec);
        added++;
      }
    } catch (e) {
      findings.push(finding('WARN', 'catalog', `source "${sourceId}" scan failed: ${e && e.message ? e.message : String(e)} — skipped`));
      continue;
    }
    if (added > 0) sourcesWithRecords++;
    findings.push(finding('INFO', 'catalog', `source "${sourceId}": ${added} catalog record(s) from ${located.detection} (root ${located.resourceRoot})`));
    if (flaggedHere > 0) {
      findings.push(finding('WARN', 'catalog', `source "${sourceId}": ${flaggedHere} record(s) flagged by the deterministic security scan (ADR-0017 §5a) — held for an auditor + the T2 admit gate`));
    }
  }

  // --- 3. MERGE recorded AGENT verdicts from the sidecar -------------------
  // The auditor/judge AGENTS run in the Claude session, not here; their verdicts (and
  // admit/revoke outcomes) were RECORDED to .forge/catalog-verdicts.json by the audit/
  // judge/admit verbs. The catalog is computed LIVE, so we read them back now and merge
  // them into the freshly-built records (security.auditors[], judge, scan re-derive).
  const mergedFindings = mergeVerdicts(records, forgeRoot);
  for (const f of mergedFindings) findings.push(f);

  if (records.length === 0) {
    findings.push(finding('INFO', 'catalog', 'empty catalog — no library artifacts and no synced sources'));
  }
  const flagged = records.filter((r) => r.security && (r.security.scan === 'flagged' || r.security.scan === 'quarantined')).length;
  return result(true, { schema: 'forge.catalog.v1', records }, findings, {
    records: records.length,
    library: libraryCount,
    catalog: records.length - libraryCount,
    sources: sources.length,
    sourcesWithRecords,
    flagged,
  });
}

/**
 * `ls` — list the unified catalog (the build view). Same records as `build`, the
 * canonical listing surface. Read-only.
 */
function doLs() {
  const res = doBuild();
  return res;
}

/**
 * `dedup` — DETERMINISTIC dedup classification across the unified catalog. Builds the
 * catalog (build view), classifies every record against every OTHER record, populates
 * each record.dedup = { class, peers:[uids] }, and emits a summary: per-class counts +
 * a `conflicts` set (uid-collision/near-dup — the records the judge agent will later
 * resolve during `admit`). No model call here (deterministic only).
 *
 * CLASSIFICATION (each record vs. all others; precedence high→low, first match wins):
 *   1. exact-dup     — identical `contentHash` to ANOTHER record (a content twin;
 *                      ADR-0005). Local/admitted twins are preferred in the peers list
 *                      (an exact-dup of an already-admitted record is a no-op admit).
 *   2. uid-collision — SAME `uid` (kind:id) but DIFFERENT `contentHash`, AND the peers
 *                      come from a DIFFERENT source (provenance.sourceId, null=local).
 *                      Two sources (or a source vs. the library) claiming one uid with
 *                      different bytes → a hard conflict for the judge/T2 gate.
 *   3. near-dup      — SAME `kind` AND "similar enough" by the deterministic heuristic
 *                      (see `nearDupPeers`): same `id`, OR Jaccard(tags) >= 0.6, OR
 *                      equal normalized description. A soft conflict for the judge.
 *   4. unique        — none of the above; admittable without conflict resolution.
 *
 * A record's class is the HIGHEST-precedence relation it has with ANY peer; `peers`
 * lists the uids of every record matching that winning relation.
 *
 * @returns {{ok:boolean, data:any, findings:any[], summary:object}}
 */
function doDedup() {
  const buildRes = doBuild();
  /** @type {CatalogRecord[]} */
  const records = Array.isArray(buildRes.data && buildRes.data.records) ? buildRes.data.records : [];
  const findings = (buildRes.findings || []).slice();

  classifyCatalog(records); // mutates each record.dedup in place

  const counts = { unique: 0, 'exact-dup': 0, 'uid-collision': 0, 'near-dup': 0 };
  const conflicts = [];
  for (const r of records) {
    const cls = r.dedup && r.dedup.class ? r.dedup.class : 'unique';
    counts[cls] = (counts[cls] || 0) + 1;
    if (cls === 'uid-collision' || cls === 'near-dup') {
      conflicts.push({ uid: r.uid, class: cls, peers: (r.dedup && r.dedup.peers) || [] });
    }
  }
  // Stable conflict order: class (collisions before near-dups), then uid.
  conflicts.sort((a, b) => (a.class < b.class ? -1 : a.class > b.class ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));

  if (conflicts.length > 0) {
    findings.push(finding('WARN', 'catalog', `${conflicts.length} dedup conflict(s) (${counts['uid-collision']} uid-collision, ${counts['near-dup']} near-dup) — held for the judge/T2 gate during admit`));
  } else {
    findings.push(finding('INFO', 'catalog', `dedup clean — ${counts.unique} unique, ${counts['exact-dup']} exact-dup, no conflicts`));
  }

  return result(true, {
    schema: 'forge.catalog.v1',
    records,
    counts,
    conflicts,
  }, findings, {
    records: records.length,
    unique: counts.unique,
    exactDup: counts['exact-dup'],
    uidCollision: counts['uid-collision'],
    nearDup: counts['near-dup'],
    conflicts: conflicts.length,
  });
}

// ---------------------------------------------------------------------------
// build helpers — CatalogRecord assembly + source resource-root auto-detect
// ---------------------------------------------------------------------------

/**
 * Wrap a registry ARTIFACT record as a CatalogRecord: the artifact fields VERBATIM
 * plus the four federated slots at their deterministic defaults. `security` defaults to
 * the `pending` gate slot; for a SOURCE candidate `build` then calls `runSecurityScan`,
 * which flips `scan` to `clean`/`flagged` and merges sidecar auditor verdicts (a library
 * record stays `pending` — we never scan our own trusted library). `dedup` defaults to
 * `unique` (overwritten by `classifyCatalog`); `judge` is null until a recorded judge
 * verdict is merged from the sidecar (or a conflict is resolved during admit).
 *
 * @param {import('./registry.mjs').RegistryArtifact} artifact
 * @param {CatalogSourceProvenance|null} source
 * @param {'catalog'|'admitted'|'quarantined'} admissionState
 * @returns {CatalogRecord}
 */
function toCatalogRecord(artifact, source, admissionState) {
  return {
    ...artifact,
    source: source || null,
    admissionState,
    security: defaultSecurity(),
    dedup: { class: 'unique', peers: [] },
    judge: null,
  };
}

/**
 * The default (pre-scan) CatalogSecurity slot: nothing has been scanned yet. The
 * `deterministic` slot is the LIGHTWEIGHT SUMMARY shape (F11 scaling fix) — never the
 * full findings array — so even an unscanned/library record carries the small shape.
 */
function defaultSecurity() {
  return { scan: 'pending', deterministic: emptyDeterministicSummary(), auditors: [], humanOverride: false };
}

/** The empty deterministic-scan SUMMARY (no findings). Mirrors the F11 summary shape. */
function emptyDeterministicSummary() {
  return { findingCount: 0, high: 0, medium: 0, sample: [] };
}

/** Number of `sample` findings carried verbatim in the LIST summary (a small preview, not all). */
const DETERMINISTIC_SAMPLE_SIZE = 3;

/**
 * SUMMARIZE a full deterministic-findings array into the lightweight LIST shape (F11).
 *
 * The deterministic scanners can return thousands of findings per record on a real
 * source; embedding them all, per record, in the build/ls/dedup LIST blows the payload
 * up to ~189 MB (a real-world source: 656,329 findings). This SUMMARY keeps the classification-relevant
 * COUNTS (high/medium drive `scan` + the admit gate) plus a small representative
 * `sample` (first N findings), and DROPS the rest of the evidence from the list payload.
 *
 * The headline `scan` state is computed SEPARATELY in `runSecurityScan` over the FULL
 * findings (via `hasHighOrMedium`) BEFORE summarizing, so the classification is unchanged
 * — only the OUTPUT payload shrinks. Pure.
 *
 * @param {any[]} findings  The full deduped findings array (discarded after summarizing).
 * @returns {{findingCount:number, high:number, medium:number, sample:any[]}}
 */
function summarizeDeterministic(findings) {
  const list = Array.isArray(findings) ? findings : [];
  let high = 0;
  let medium = 0;
  for (const f of list) {
    const sev = f && typeof f.severity === 'string' ? f.severity : '';
    if (sev === 'high') high++;
    else if (sev === 'medium') medium++;
  }
  return {
    findingCount: list.length,
    high,
    medium,
    sample: list.slice(0, DETERMINISTIC_SAMPLE_SIZE),
  };
}

/**
 * Build the CatalogSourceProvenance for a record from its source manifest entry +
 * lockfile pin. `commit` and `importedAt` come from .forge/sources.lock when present
 * (the exact synced sha + time); they degrade to '' when the source is unsynced/
 * unpinned. `ref` prefers the lock's pinned ref, falling back to the manifest ref.
 *
 * @param {any} src   The manifests/sources.json entry { id, url, ref, ... }.
 * @param {any} lockEntry The .forge/sources.lock entry { id, url, ref, commit, syncedAt } or null.
 * @returns {CatalogSourceProvenance}
 */
function makeProvenance(src, lockEntry) {
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    sourceId: str(src && src.id),
    repoUrl: str((src && src.url)) || str(lockEntry && lockEntry.url),
    ref: str((lockEntry && lockEntry.ref)) || str(src && src.ref),
    commit: str(lockEntry && lockEntry.commit),
    importedAt: str(lockEntry && lockEntry.syncedAt),
    // Carry the source's trust level into the record so the T2 admit gate (executable
    // kind from a non-reviewed source → human override) is self-contained.
    trust: str(src && src.trust),
  };
}

/**
 * Read the GLOBAL sources manifest (`<FORGE_HOME>/manifests/sources.json`, sources[]) +
 * the sync lockfile (`<FORGE_HOME>/.forge/sources.lock`, commit pins), both fail-open.
 * Both live under the machine-level global config root (ADR-0023), where source.mjs now
 * persists them — NOT under the FORGE_ROOT library checkout. We read them with `fs`
 * directly (one-writer-per-file: source.mjs OWNS sources.json; we only READ it here), so
 * the catalog VIEW = CORE library (FORGE_ROOT registry) ∪ synced sources still holds.
 * The `forgeRoot` arg is retained for the signature; the federation state is FORGE_HOME-rooted.
 *
 * @param {string} forgeRoot
 * @returns {{ sources: any[], lock: Map<string, any> }}
 */
function readSourcesAndLock(forgeRoot) {
  /** @type {any[]} */
  let sources = [];
  try {
    const raw = fs.readFileSync(path.join(forgeHome(), 'manifests', 'sources.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.sources)) sources = parsed.sources;
  } catch {
    sources = []; // absent/malformed → no sources (fail-open)
  }
  /** @type {Map<string, any>} */
  const lock = new Map();
  try {
    const raw = fs.readFileSync(path.join(forgeHome(), '.forge', 'sources.lock'), 'utf8');
    const parsed = JSON.parse(raw);
    const entries = parsed && Array.isArray(parsed.sources) ? parsed.sources : [];
    for (const e of entries) {
      if (e && typeof e.id === 'string') lock.set(e.id, e);
    }
  } catch {
    /* no lockfile yet → no commit pins (fail-open) */
  }
  return { sources, lock };
}

/**
 * The machine-local managed cache dir for a source (LOCKED fork #1; mirrors
 * source.mjs's planned `~/.claude/forge-sources/<id>`). We READ it with fs to scan
 * synced bytes; we never write it. `~` is resolved against os.homedir().
 *
 * @param {string} sourceId @returns {string}
 */
function sourceCacheDir(sourceId) {
  let home = '';
  try {
    home = os.homedir() || '';
  } catch {
    home = '';
  }
  return path.join(home, '.claude', 'forge-sources', sourceId);
}

/**
 * AUTO-DETECT a synced source's resource ROOT inside its cache dir — the directory
 * `buildRegistry` should walk. Probes, in order:
 *   1. <cache>/.claude-plugin/marketplace.json exists → follow its first plugin's
 *      `source` subdir (the standard Claude Code marketplace layout); the plugin root
 *      is where agents/skills/commands live.
 *   2. <cache>/agents or <cache>/skills exists → the cache IS the resource root.
 *   3. Otherwise probe ONE level down: the first immediate subdir that itself contains
 *      an agents/ or skills/ dir (e.g. <cache>/cli) is the resource root.
 * Returns the absolute resourceRoot (or null if none found) plus cacheExists + a
 * human `detection` label. Fail-open: any fs error degrades to "no root found".
 *
 * @param {string} sourceId
 * @returns {{cacheDir:string, cacheExists:boolean, resourceRoot:string|null, detection:string}}
 */
function locateResourceRoot(src) {
  const sourceId = src && typeof src.id === 'string' ? src.id : '';
  const kind = src && typeof src.kind === 'string' ? src.kind : 'git';
  // Local sources are read DIRECTLY from their recorded path (no clone/copy); git
  // sources are read from the managed cache (~/.claude/forge-sources/<id>).
  const cacheDir = kind === 'local'
    ? path.resolve(src && typeof src.url === 'string' ? src.url : '')
    : sourceCacheDir(sourceId);
  let cacheExists = false;
  try {
    cacheExists = fs.statSync(cacheDir).isDirectory();
  } catch {
    cacheExists = false;
  }
  if (!cacheExists) return { cacheDir, cacheExists: false, resourceRoot: null, detection: 'no-cache' };

  // 1. marketplace.json plugin source subdir.
  const mkt = path.join(cacheDir, '.claude-plugin', 'marketplace.json');
  if (isFile(mkt)) {
    const sub = firstPluginSourceSubdir(mkt);
    if (sub) {
      const root = path.resolve(cacheDir, sub);
      // TRAVERSAL DEFENSE: a marketplace.json is UNTRUSTED data; its plugin `source` subdir
      // could be `../..` (or absolute) and point the scanner/admit at an arbitrary local
      // tree outside the source cache. REJECT any root not CONTAINED under cacheDir.
      if (isContained(cacheDir, root) && hasResourceDir(root)) {
        return { cacheDir, cacheExists: true, resourceRoot: root, detection: `marketplace plugin subdir "${sub}"` };
      }
    }
    // marketplace present but its subdir escaped/lacked resources → fall through to probing.
  }

  // 2. cache itself is the resource root.
  if (hasResourceDir(cacheDir)) {
    return { cacheDir, cacheExists: true, resourceRoot: cacheDir, detection: 'cache root (agents/ or skills/)' };
  }

  // 3. one level down: first immediate subdir holding agents/ or skills/.
  let entries = [];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === '.git' || ent.name === '.claude' || ent.name === 'node_modules' || ent.name === '.claude-plugin') continue;
    const child = path.join(cacheDir, ent.name);
    // TRAVERSAL DEFENSE (same as the marketplace probe): the resolved child must stay
    // contained under cacheDir before we accept it as a resource root.
    if (isContained(cacheDir, child) && hasResourceDir(child)) {
      return { cacheDir, cacheExists: true, resourceRoot: child, detection: `one-level-down subdir "${ent.name}"` };
    }
  }

  return { cacheDir, cacheExists: true, resourceRoot: null, detection: 'no-resource-root' };
}

/** True when `dir` contains an `agents/` or `skills/` subdir (a registry resource root). */
function hasResourceDir(dir) {
  return isDir(path.join(dir, 'agents')) || isDir(path.join(dir, 'skills'));
}

/**
 * Parse a marketplace.json and return the first plugin's `source` subdir (a relative
 * path string), or null. Tolerates the two common `source` shapes: a bare string, or
 * an object `{ source: "./sub" }` / `{ path: "./sub" }`. Fail-open on any parse error.
 *
 * @param {string} marketplacePath @returns {string|null}
 */
function firstPluginSourceSubdir(marketplacePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    const plugins = parsed && Array.isArray(parsed.plugins) ? parsed.plugins : [];
    for (const p of plugins) {
      if (!p) continue;
      const s = p.source != null ? p.source : p.path;
      if (typeof s === 'string' && s.length > 0) return s;
      if (s && typeof s === 'object') {
        const inner = typeof s.path === 'string' ? s.path : typeof s.source === 'string' ? s.source : null;
        if (inner) return inner;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Path-CONTAINMENT predicate: true iff `child` resolves to a path INSIDE (or equal to)
 * `parent`. We compare via `path.relative` (not a string `startsWith`, which mis-handles
 * `/a/b` vs `/a/bc`): a relative result that starts with `..` or is absolute means the
 * child escaped the parent. The traversal defense for untrusted marketplace/probe roots
 * AND the single-file copy realpath assertion. Fail-CLOSED → false on any error.
 *
 * @param {string} parent @param {string} child @returns {boolean}
 */
function isContained(parent, child) {
  try {
    const p = path.resolve(parent);
    const c = path.resolve(child);
    if (c === p) return true;
    const rel = path.relative(p, c);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** fs.statSync isFile, fail-open. */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** fs.statSync isDirectory, fail-open. */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// dedup — deterministic classification
// ---------------------------------------------------------------------------

/**
 * Classify every record in `records` against every OTHER record and write the winning
 * verdict into `record.dedup = { class, peers }`. O(n²) over the catalog (deterministic,
 * no I/O, no model call). Mutates records in place. See `doDedup` for the precedence +
 * the documented near-dup heuristic.
 *
 * @param {CatalogRecord[]} records
 */
function classifyCatalog(records) {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    /** @type {string[]} */
    const exactPeers = [];
    /** @type {string[]} */
    const collisionPeers = [];
    /** @type {string[]} */
    const nearPeers = [];

    for (let j = 0; j < records.length; j++) {
      if (j === i) continue;
      const o = records[j];

      // 1. exact-dup: identical content bytes (same hash) as another record.
      if (r.contentHash && o.contentHash && r.contentHash === o.contentHash) {
        exactPeers.push(o.uid);
        continue; // an exact twin can't also be a uid-collision (same bytes) — skip.
      }
      // 2. uid-collision: same uid, DIFFERENT bytes, from a DIFFERENT source.
      if (r.uid === o.uid && fromDifferentSource(r, o)) {
        collisionPeers.push(o.uid);
        continue;
      }
      // 3. near-dup: same kind AND the similarity heuristic fires.
      if (r.kind === o.kind && isNearDup(r, o)) {
        nearPeers.push(o.uid);
      }
    }

    if (exactPeers.length > 0) {
      // Prefer admitted/local peers first (an exact-dup of an admitted record is a no-op
      // admit), then stable uid order. Peers can repeat a uid across sources → dedupe.
      r.dedup = { class: 'exact-dup', peers: orderPeers(records, exactPeers) };
    } else if (collisionPeers.length > 0) {
      r.dedup = { class: 'uid-collision', peers: orderPeers(records, collisionPeers) };
    } else if (nearPeers.length > 0) {
      r.dedup = { class: 'near-dup', peers: orderPeers(records, nearPeers) };
    } else {
      r.dedup = { class: 'unique', peers: [] };
    }
  }
}

/**
 * Two records are "from a different source" when their provenance sourceIds differ
 * (a null source = the local library is its own "source"). This is what makes a
 * same-uid/different-bytes pair a uid-collision rather than two builds of one repo.
 */
function fromDifferentSource(a, b) {
  const sa = a.source && a.source.sourceId ? a.source.sourceId : null;
  const sb = b.source && b.source.sourceId ? b.source.sourceId : null;
  return sa !== sb;
}

/**
 * NEAR-DUP HEURISTIC (deterministic; caller already required same `kind`). Two records
 * are near-dups when ANY of:
 *   (a) same `id`            — the same kind-local id (e.g. two `code-reviewer` agents),
 *   (b) Jaccard(tags) >= 0.6 — |tags∩| / |tags∪| of their tag sets,
 *   (c) equal normalized description — descriptions equal after lowercasing +
 *       whitespace-collapsing + trimming (empty descriptions do NOT match, so two
 *       tag-less, description-less records are never falsely paired).
 * Pure, symmetric, no I/O.
 */
function isNearDup(a, b) {
  if (a.id && b.id && a.id === b.id) return true; // (a) same id
  if (jaccard(a.tags, b.tags) >= 0.6) return true; // (b) tag overlap
  const da = normDesc(a.description);
  const db = normDesc(b.description);
  if (da && db && da === db) return true; // (c) same normalized description
  return false;
}

/** Jaccard similarity of two string arrays: |∩| / |∪|. Empty∪empty → 0 (not similar). */
function jaccard(aTags, bTags) {
  const A = new Set(Array.isArray(aTags) ? aTags : []);
  const B = new Set(Array.isArray(bTags) ? bTags : []);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Normalize a description for equality: lowercase, collapse whitespace, trim. */
function normDesc(d) {
  return typeof d === 'string' ? d.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

/**
 * Order a peer-uid list for stable, useful output: admitted (local) peers first, then
 * by uid; de-duplicated (a uid may appear from several sources). `records` provides the
 * admissionState lookup.
 */
function orderPeers(records, peerUids) {
  const stateOf = new Map();
  for (const r of records) {
    // First-seen admissionState per uid is fine for ordering (admitted wins if any).
    if (!stateOf.has(r.uid) || r.admissionState === 'admitted') stateOf.set(r.uid, r.admissionState);
  }
  const uniq = [...new Set(peerUids)];
  uniq.sort((x, y) => {
    const ax = stateOf.get(x) === 'admitted' ? 0 : 1;
    const ay = stateOf.get(y) === 'admitted' ? 0 : 1;
    if (ax !== ay) return ax - ay;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return uniq;
}

// ---------------------------------------------------------------------------
// SECURITY-SCAN GATE — runSecurityScan (ADR-0017 §5a, layer 1)
// ---------------------------------------------------------------------------

/**
 * Run the DETERMINISTIC security scan (layer 1) over a CATALOG-state candidate and
 * fold the result into `record.security`. MUTATES the record in place.
 *
 * Scope:
 *   - SKIP local/admitted (trusted-library) records — those have `source === null`
 *     and STAY `scan:'pending'`. We never scan our own curated library; only synced,
 *     untrusted SOURCE candidates are scanned.
 *   - For a source candidate: resolve its REAL executable/text file (NOT the registry
 *     pseudo-path) and scan THAT. A `hook` record's registry path is the synthetic
 *     `hooks/hooks.json#<id>`, which is NOT a real file — joining it to the resource root
 *     yields a non-existent path the scanners ENOENT-fail-open on (the BLOCKING bypass:
 *     a malicious hook script scanned `clean`). We instead resolve the hook's real SCRIPT
 *     file from `hooks/hooks.json` (the matching entry's command/script path) and scan it
 *     with BOTH scanners (a hook is an executable kind). Non-hook candidates resolve to
 *     `path.join(resourceRoot, record.path)` as before.
 *   - Layer 1a `scanInjection(file)` runs on EVERY candidate kind; layer 1b
 *     `scanResourceSafety(file)` runs ADDITIONALLY for executable kinds.
 *   - DEFENSE-IN-DEPTH: `sourceWideFindings` (computed once per source by
 *     {@link scanSourceExecutables}) — a safety scan of EVERY executable file under the
 *     resource root — is merged into EVERY source candidate, so a malicious script that
 *     is not a registered hook still flags the source. All findings land in
 *     `record.security.deterministic.findings`.
 *
 * Outcome:
 *   - `record.security.scan = 'flagged'` if ANY merged finding is severity high|medium,
 *     else `'clean'`. (Low-severity notes — e.g. the scanners' current planned-note —
 *     do NOT flag; the candidate scans clean until a real high/medium signature lands.)
 *
 * Determinism + fail-open per record: the scanners are consumed by their published
 * signature `(candidatePath) -> {verdict, findings}`; any throw or malformed return
 * degrades to zero findings and leaves the record at its pre-scan slot — build never
 * aborts. Candidate content is treated as UNTRUSTED DATA, never executed (§5a invariant).
 *
 * @param {CatalogRecord} record A CATALOG-state record (mutated in place).
 * @param {string} resourceRoot The synced source's resource root (build's located.resourceRoot).
 * @param {{findings:any[], error:boolean}|any[]} [sourceWideFindings] Pre-computed source-wide
 *        executable safety scan result (defense-in-depth), merged into every source candidate.
 *        The `{findings, error}` envelope fails the scan CLOSED when the source-wide walk threw;
 *        a bare array is accepted for back-compat. Defaults to none.
 * @returns {CatalogRecord} The same record, for chaining.
 */
function runSecurityScan(record, resourceRoot, sourceWideFindings) {
  if (!record || typeof record !== 'object') return record;
  // SKIP our own trusted library: source === null → stays scan:'pending'.
  if (!record.source) return record;
  if (!record.security || typeof record.security !== 'object') record.security = defaultSecurity();

  // Resolve the candidate's REAL file(s). For a hook we follow hooks/hooks.json#<id> to
  // the actual script the hook runs (often multiple "type":"command" entries under one
  // id); for every other kind it is the single on-disk artifact path.
  const targets = resolveScanTargets(record, resourceRoot);

  /** @type {any[]} */
  const detFindings = [];
  // FAIL-CLOSED: any scanner throw/contract-violation means the candidate was NOT cleared.
  // We must never read a torn scan back as 'clean' — it becomes 'flagged' (needs-review).
  let scanError = false;
  const isExecutable = EXECUTABLE_KIND_SET.has(record.kind);
  for (const target of targets) {
    // Layer 1a — injection scan runs on EVERY candidate kind.
    const inj = safeScan(() => scanInjection(target));
    if (inj.error) scanError = true;
    for (const f of inj.findings) detFindings.push(f);
    // Layer 1b — code-safety scan runs ADDITIONALLY for executable kinds (hook/command/mcp).
    if (isExecutable) {
      const safety = safeScan(() => scanResourceSafety(target));
      if (safety.error) scanError = true;
      for (const f of safety.findings) detFindings.push(f);
    }
  }
  // DEFENSE-IN-DEPTH — fold in the source-wide executable findings so a non-hook
  // malicious script anywhere under the root still flags this source's records.
  // A torn source-wide walk (errored:true) ALSO fails closed.
  if (sourceWideFindings && typeof sourceWideFindings === 'object' && Array.isArray(sourceWideFindings.findings)) {
    if (sourceWideFindings.error) scanError = true;
    for (const f of sourceWideFindings.findings) detFindings.push(f);
  } else if (Array.isArray(sourceWideFindings)) {
    // Back-compat: a bare findings array (no error envelope).
    for (const f of sourceWideFindings) detFindings.push(f);
  }

  // F11 SCALING FIX: classify over the FULL deduped findings (unchanged), then store a
  // lightweight SUMMARY — NOT all evidence — on the record. The full `deduped` array can
  // hold thousands of findings per record on a real source; embedding them all, per record,
  // in the build/ls/dedup LIST blows the payload up to ~189 MB (a real-world source: 656,329 findings) and
  // the web bridge can't JSON.parse it. We compute `hasHighOrMedium` over the FULL set FIRST
  // (so the headline `scan` state is determined EXACTLY as before — classification unchanged),
  // then summarize and discard the rest of the evidence from the list payload.
  const deduped = dedupeFindings(detFindings);
  // flagged iff any high|medium finding OR a scan ERROR (fail-closed); else clean.
  // (humanOverride/auditors untouched.) A scan error => 'flagged' = needs-review, NEVER clean.
  // CLASSIFICATION runs on the FULL findings — the summary is a payload-only shrink.
  record.security.scan = (scanError || hasHighOrMedium(deduped)) ? 'flagged' : 'clean';
  record.security.deterministic = summarizeDeterministic(deduped);
  return record;
}

/**
 * Resolve the REAL filesystem target(s) a candidate's deterministic scan should read —
 * the fix for the hook pseudo-path bypass.
 *
 *   - HOOK candidate: its registry `path` is the synthetic `hooks/hooks.json#<id>`, never
 *     a real file. We open `<resourceRoot>/hooks/hooks.json`, find the entry whose `id`
 *     matches the hook id (record.id, or the suffix of `hooks/hooks.json#<id>`), and return
 *     the absolute path(s) of the SCRIPT it executes — the `.mjs`/`.sh`/etc. extracted from
 *     each `"type":"command"` entry's `command`/`script`/`path` (expanding a
 *     `${CLAUDE_PLUGIN_ROOT}`-style or relative ref against the resource root). Only paths
 *     that actually exist on disk are returned.
 *   - ANY OTHER kind: the single real file `path.join(resourceRoot, record.path)`.
 *
 * Fail-open: a missing hooks.json, an unmatched id, or an unresolvable command degrades to
 * an empty target list (the source-wide defense-in-depth walk still covers the script).
 *
 * @param {CatalogRecord} record
 * @param {string} resourceRoot
 * @returns {string[]} Absolute paths to scan (deduped).
 */
function resolveScanTargets(record, resourceRoot) {
  const root = typeof resourceRoot === 'string' ? resourceRoot : '';
  if (record.kind === 'hook') {
    return resolveHookScriptFiles(record, root);
  }
  const relPath = typeof record.path === 'string' ? record.path : '';
  if (!relPath) return [];
  // A non-hook record should never carry a '#' pseudo-path, but guard fail-open anyway.
  if (relPath.includes('#')) return [];
  return [root ? path.join(root, relPath) : relPath];
}

/**
 * Resolve a HOOK record to the absolute path(s) of the real script file(s) it runs, by
 * reading the source's `hooks/hooks.json` and matching the hook id. Returns only paths
 * that exist on disk (a `${CLAUDE_PLUGIN_ROOT}`-relative or plain-relative command resolves
 * against `resourceRoot`). Fail-open → [] on any read/parse miss.
 *
 * @param {CatalogRecord} record @param {string} resourceRoot @returns {string[]}
 */
function resolveHookScriptFiles(record, resourceRoot) {
  // The canonical hook id: record.id (e.g. "forge:detect-project"), falling back to the
  // suffix of the "hooks/hooks.json#<id>" pseudo-path.
  let hookId = typeof record.id === 'string' ? record.id : '';
  if (!hookId && typeof record.path === 'string' && record.path.includes('#')) {
    hookId = record.path.slice(record.path.indexOf('#') + 1);
  }
  if (!resourceRoot) return [];
  const hooksJsonPath = path.join(resourceRoot, 'hooks', 'hooks.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  } catch {
    return []; // no/unreadable/malformed hooks.json — fail-open (source-wide walk still covers it)
  }
  const entries = collectHookEntries(parsed);
  /** @type {Set<string>} */
  const targets = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    // Match by the entry's id; if a matched hook can't be resolved we leave it to the walk.
    if (hookId && entry.id !== hookId) continue;
    for (const cmd of collectHookCommands(entry)) {
      const rel = extractScriptRef(cmd);
      if (!rel) continue;
      const abs = resolveCommandPath(rel, resourceRoot);
      if (abs && isFile(abs)) targets.add(abs);
    }
  }
  return [...targets];
}

/**
 * Flatten a parsed hooks.json into the list of top-level hook ENTRIES (each carrying an
 * `id`, a matcher, and a nested `hooks: [...]` command array). The Claude Code layout
 * nests entries under event names (SessionStart/PreToolUse/…); we accept that, a flat
 * `hooks: [...]` array, or a bare array. Fail-open → [].
 *
 * @param {any} parsed @returns {any[]}
 */
function collectHookEntries(parsed) {
  /** @type {any[]} */
  const out = [];
  const push = (v) => { if (Array.isArray(v)) for (const e of v) out.push(e); };
  if (!parsed || typeof parsed !== 'object') return out;
  const hooks = parsed.hooks != null ? parsed.hooks : parsed;
  if (Array.isArray(hooks)) {
    push(hooks);
  } else if (hooks && typeof hooks === 'object') {
    for (const k of Object.keys(hooks)) push(hooks[k]); // per-event arrays
  }
  return out;
}

/**
 * Extract the command STRINGS a hook entry runs: each of its nested `hooks[]` items'
 * `command` (or `script`/`path`) field. Fail-open → [].
 *
 * @param {any} entry @returns {string[]}
 */
function collectHookCommands(entry) {
  /** @type {string[]} */
  const out = [];
  const items = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const cmd = typeof it.command === 'string' ? it.command
      : typeof it.script === 'string' ? it.script
        : typeof it.path === 'string' ? it.path : '';
    if (cmd) out.push(cmd);
  }
  // Some layouts put the command directly on the entry.
  if (typeof entry.command === 'string') out.push(entry.command);
  return out;
}

/**
 * Pull the script file reference out of a hook `command` string. A command is typically
 * a shell line like `node "${CLAUDE_PLUGIN_ROOT}/hooks/detect.mjs"` or `bash ./x.sh`.
 * We scan its tokens for the first that LOOKS like a script path (ends in a known code
 * extension, after stripping quotes). Returns that raw ref (still possibly
 * `${CLAUDE_PLUGIN_ROOT}`-prefixed), or '' if none. Pure.
 *
 * @param {string} command @returns {string}
 */
function extractScriptRef(command) {
  if (typeof command !== 'string' || command.length === 0) return '';
  // Split on whitespace but keep quoted spans intact enough; strip surrounding quotes.
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (const tokRaw of tokens) {
    const tok = tokRaw.replace(/^['"]|['"]$/g, '');
    const dot = tok.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = tok.slice(dot).toLowerCase();
    if (HOOK_SCRIPT_EXT.has(ext)) return tok;
  }
  return '';
}

/**
 * Resolve a hook command's raw script ref to an absolute path under the resource root.
 * `${CLAUDE_PLUGIN_ROOT}` (and `$CLAUDE_PLUGIN_ROOT`) map to the resource root; a leading
 * `./`/`../` or plain relative ref resolves against it; an already-absolute ref is taken
 * verbatim. We then CONTAIN it to the resource root (a `..`-escape resolves outside →
 * rejected) so a candidate cannot point the scanner at an arbitrary local file. Fail-open
 * → '' on any error.
 *
 * @param {string} rel @param {string} resourceRoot @returns {string}
 */
function resolveCommandPath(rel, resourceRoot) {
  try {
    let r = rel.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '').replace(/\$CLAUDE_PLUGIN_ROOT/g, '');
    r = r.replace(/^[/\\]+/, ''); // after stripping the var, treat as root-relative
    const abs = path.isAbsolute(rel) && !rel.includes('CLAUDE_PLUGIN_ROOT')
      ? path.resolve(rel)
      : path.resolve(resourceRoot, r);
    // Containment: only return targets inside the resource root (untrusted ref defense).
    const rootResolved = path.resolve(resourceRoot);
    const relCheck = path.relative(rootResolved, abs);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return '';
    return abs;
  } catch {
    return '';
  }
}

/**
 * DEFENSE-IN-DEPTH (ADR-0017 §5a): safety-scan EVERY executable file under a source's
 * resource root, so a malicious script that is NOT a registered hook still flags the
 * source. `scanResourceSafety` already accepts a DIRECTORY and recurses, selecting code
 * files by extension (*.mjs/.js/.cjs/.sh/.bash/.zsh) or a `#!` shebang — exactly the
 * executable surface we want — so we hand it the whole root once. Fail-open → [].
 *
 * @param {string} resourceRoot
 * @returns {{findings:any[], error:boolean}} the safety scanner's findings + a fail-closed flag
 */
function scanSourceExecutables(resourceRoot) {
  if (typeof resourceRoot !== 'string' || resourceRoot.length === 0) return { findings: [], error: false };
  const res = safeScan(() => scanResourceSafety(resourceRoot));
  return { findings: Array.isArray(res.findings) ? res.findings : [], error: !!res.error };
}

/**
 * De-duplicate findings that the per-record scan and the source-wide walk may both report
 * for the same file:line:rule (a hook whose script is also caught by the walk). Stable:
 * keeps first occurrence. Pure.
 *
 * @param {any[]} findings @returns {any[]}
 */
function dedupeFindings(findings) {
  if (!Array.isArray(findings)) return [];
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const key = `${f.rule || ''} ${f.severity || ''} ${f.path || ''} ${f.line == null ? '' : f.line} ${f.evidence || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** True when any finding is severity 'high' or 'medium' (the flagging threshold). */
function hasHighOrMedium(findings) {
  if (!Array.isArray(findings)) return false;
  for (const f of findings) {
    const sev = f && typeof f.severity === 'string' ? f.severity : '';
    if (sev === 'high' || sev === 'medium') return true;
  }
  return false;
}

/**
 * Invoke a scanner FAIL-CLOSED, normalising to the published contract shape. A scanner
 * THROW or a malformed (non-object) return is treated as a SCAN ERROR: the candidate has
 * NOT been cleared, so we report `error:true` (the caller flips security.scan→'flagged' =
 * needs-review). A torn candidate must NEVER read back as clean — fail-closed, not
 * fail-open. The scan never re-throws, so a single torn candidate still never aborts the
 * whole build. Candidate code is NEVER executed — the scanner only reads + matches.
 *
 * @param {() => {verdict?:string, findings?:any[]}} fn A zero-arg call into a scanner.
 * @returns {{verdict:string, findings:any[], error:boolean}}
 */
function safeScan(fn) {
  try {
    const r = fn();
    if (r && typeof r === 'object') {
      return {
        verdict: typeof r.verdict === 'string' ? r.verdict : 'pending',
        findings: Array.isArray(r.findings) ? r.findings : [],
        error: false,
      };
    }
    // A non-object return is a contract violation: cannot be trusted as a clearance.
    return { verdict: 'pending', findings: [], error: true };
  } catch {
    // A throw means the candidate was never actually scanned → fail CLOSED (needs review).
    return { verdict: 'pending', findings: [], error: true };
  }
}

// ---------------------------------------------------------------------------
// Verdict SIDECAR — read / merge / write (see the SIDECAR block near the top)
// ---------------------------------------------------------------------------

/** Absolute path to the verdict sidecar (`<FORGE_HOME>/.forge/catalog-verdicts.json`, ADR-0023).
 *  GLOBAL federation state: persisted under the machine-level global config root (NOT the
 *  FORGE_ROOT library checkout) so admit/audit verdicts persist across library installs. The
 *  `forgeRoot` arg is kept for the (fail-open) relative-path display helper. */
function verdictsPath(_forgeRoot) {
  return path.join(forgeHome(), '.forge', 'catalog-verdicts.json');
}

/** The NUL-joined sidecar key for a (sourceId, uid) pair. */
function verdictKey(sourceId, uid) {
  return `${typeof sourceId === 'string' ? sourceId : ''}${KEY_SEP}${typeof uid === 'string' ? uid : ''}`;
}

/** A record's sourceId for keying (provenance id, or '' for the local/admitted library). */
function recordSourceId(record) {
  return record && record.source && typeof record.source.sourceId === 'string' ? record.source.sourceId : '';
}

/**
 * Read the verdict sidecar fail-open into `{ schema, version, records: {} }`. A missing/
 * malformed file yields the empty canonical shape; a non-object `records` is reset to {}.
 *
 * @param {string} forgeRoot @returns {{schema:string, version:number, records:Object}}
 */
function readVerdicts(forgeRoot) {
  const empty = { schema: VERDICTS_SCHEMA_TAG, version: VERDICTS_SCHEMA_VERSION, records: {} };
  const raw = readJson(verdictsPath(forgeRoot));
  if (!raw || typeof raw !== 'object') return empty;
  const records = raw.records && typeof raw.records === 'object' && !Array.isArray(raw.records) ? raw.records : {};
  return { schema: VERDICTS_SCHEMA_TAG, version: VERDICTS_SCHEMA_VERSION, records };
}

/** Get (or lazily create) the sidecar entry object for a (sourceId, uid) key. */
function ensureVerdictEntry(store, sourceId, uid) {
  const key = verdictKey(sourceId, uid);
  let e = store.records[key];
  if (!e || typeof e !== 'object') {
    e = { sourceId: sourceId || '', uid: uid || '', auditors: [], judge: null, admissions: [] };
    store.records[key] = e;
  }
  if (!Array.isArray(e.auditors)) e.auditors = [];
  if (!Array.isArray(e.admissions)) e.admissions = [];
  return e;
}

/**
 * Merge the recorded sidecar verdicts into the freshly-built records (build step 3).
 * For each record we look up its `<sourceId> <uid>` entry and:
 *   - append the recorded auditor verdicts → record.security.auditors[]
 *     (mapped to the CatalogAuditorVerdict slot: { agent, verdict, evidence[] });
 *   - set record.judge ← the recorded judge ({ verdict, rationale }), if any;
 *   - RE-DERIVE record.security.scan: if any recorded auditor verdict is adverse
 *     (suspicious|malicious) the record becomes 'quarantined'; otherwise the
 *     deterministic scan state set by runSecurityScan stands.
 * Returns INFO/WARN findings summarising what merged. Pure w.r.t. disk (read-only).
 *
 * @param {CatalogRecord[]} records @param {string} forgeRoot @returns {any[]} findings
 */
function mergeVerdicts(records, forgeRoot) {
  const findings = [];
  const store = readVerdicts(forgeRoot);
  if (!store.records || Object.keys(store.records).length === 0) return findings;

  let auditorMerges = 0;
  let judgeMerges = 0;
  let quarantined = 0;
  for (const r of records) {
    const entry = store.records[verdictKey(recordSourceId(r), r.uid)];
    if (!entry || typeof entry !== 'object') continue;
    if (!r.security || typeof r.security !== 'object') r.security = defaultSecurity();

    const auditors = Array.isArray(entry.auditors) ? entry.auditors : [];
    if (auditors.length > 0) {
      r.security.auditors = auditors.map((a) => ({
        agent: a && typeof a.agent === 'string' ? a.agent : '',
        verdict: a && typeof a.verdict === 'string' ? a.verdict : '',
        evidence: a && Array.isArray(a.evidence) ? a.evidence : [],
      }));
      auditorMerges += auditors.length;
      // Adverse auditor verdict → quarantine (overrides a clean/flagged deterministic state).
      if (r.security.auditors.some((a) => ADVERSE_AUDITOR_VERDICTS.has(a.verdict))) {
        r.security.scan = 'quarantined';
        quarantined++;
      }
    }
    if (entry.judge && typeof entry.judge === 'object' && typeof entry.judge.verdict === 'string') {
      r.judge = {
        verdict: entry.judge.verdict,
        rationale: typeof entry.judge.rationale === 'string' ? entry.judge.rationale : '',
      };
      judgeMerges++;
    }
  }
  if (auditorMerges > 0 || judgeMerges > 0) {
    findings.push(finding('INFO', 'catalog', `merged recorded verdicts from the sidecar: ${auditorMerges} auditor verdict(s), ${judgeMerges} judge verdict(s)${quarantined > 0 ? `, ${quarantined} record(s) quarantined by an adverse auditor` : ''}`));
  }
  return findings;
}

/** Find the FIRST built record matching `uid` (build view). Returns null when absent. */
function findRecordByUid(records, uid) {
  if (!uid) return null;
  for (const r of records) if (r && r.uid === uid) return r;
  return null;
}

/**
 * Find the catalog record to admit for `uid`, honouring an optional `--source <id>` to
 * disambiguate a uid-collision (the SAME uid synced from more than one source). When a
 * source is named we match it exactly (provenance sourceId, '' = the local library);
 * otherwise the first match wins, preferring an already-admitted/local record (so a re-admit
 * of a library uid resolves to the library record). Returns null when absent. Pure.
 *
 * @param {CatalogRecord[]} records @param {string} uid @param {string} wantSource
 * @returns {CatalogRecord|null}
 */
function findRecordForAdmit(records, uid, wantSource) {
  if (!uid) return null;
  if (wantSource) {
    for (const r of records) if (r && r.uid === uid && recordSourceId(r) === wantSource) return r;
    return null;
  }
  let fallback = null;
  for (const r of records) {
    if (!r || r.uid !== uid) continue;
    if (r.admissionState === 'admitted' || !r.source) return r; // prefer local/admitted
    if (!fallback) fallback = r;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// admit ACTIVATION — resolve the library target, plan, copy bytes (ADR-0017)
// ---------------------------------------------------------------------------

/**
 * Plan the ACTIVATION of a cleared candidate into the active library. PURE w.r.t. library
 * state (it only READS source + target to detect a collision) — it computes WHAT admit
 * would copy WHERE, without writing anything. `activateResource` later EXECUTES this plan.
 *
 * Resolution:
 *   - TARGET: the canonical library path from kind+id, via `componentCandidates(forgeRoot,
 *     pluralKind, id)[0]` — the SAME mapping the registry/composition validator use, so the
 *     admitted artifact lands exactly where the registry rediscovers it
 *     (agent->agents/<id>.md, skill->skills/<id>/SKILL.md, command->commands/<id>.md,
 *     rule->rules/<id>.md, bundle->bundles/<id>.md, workflow->workflows/<id>.md,
 *     mcp->mcp/<id>.json).
 *   - SOURCE bytes: a SOURCE candidate's `record.path` is relative to its source resource
 *     root; we re-locate that root (locateResourceRoot over the source manifest entry) and
 *     join it. A skill copies the whole skill DIR (dirname of SKILL.md). A library/local
 *     record (source === null) is already in the library — nothing to copy (not activatable
 *     as a new artifact; revoke/re-admit of a library uid is a no-op activation).
 *   - REPLACE: true iff the resolved target already exists on disk (a collision with a
 *     curated library resource → the T2 replace gate in doAdmit).
 *
 * Fail-open: any unresolved kind/source/path yields `{ activatable:false, reason }` and
 * admit refuses to activate (never throws).
 *
 * @param {CatalogRecord} record @param {string} forgeRoot @param {any[]} findings
 * @returns {{activatable:boolean, reason:string, kind:string, targetPath:string,
 *           targetAbs:string, sourceAbs:string, sourceRel:string, sourceRoot:string,
 *           skill:boolean, replace:boolean}}
 */
function planActivation(record, forgeRoot, findings) {
  const fail = (reason) => ({ activatable: false, reason, kind: record.kind, targetPath: '', targetAbs: '', sourceAbs: '', sourceRel: '', sourceRoot: '', skill: false, replace: false });

  const component = KIND_TO_COMPONENT[record.kind];
  if (!component) return fail(`kind "${record.kind}" is not an activatable resource kind (admittable kinds: ${Object.keys(KIND_TO_COMPONENT).join('/')})`);
  if (!record.id) return fail('record has no id — cannot resolve a canonical library target');

  // Canonical library target = the FIRST componentCandidate (the canonical write path).
  const candidates = componentCandidates(forgeRoot, component, record.id);
  const targetAbs = Array.isArray(candidates) && candidates.length > 0 ? candidates[0] : '';
  if (!targetAbs || targetAbs === '__HOOK__') return fail(`could not resolve a canonical library target for ${record.uid}`);
  const targetPath = repoRel(forgeRoot, targetAbs);
  const isSkill = record.kind === 'skill';

  // SOURCE bytes. A null-source (local/library) record is already in the library; there is
  // nothing to copy — we treat it as not-activatable-as-new (a no-op for an admitted lib uid).
  if (!record.source) {
    return fail(`uid ${record.uid} is a local library record (already active) — nothing to copy/activate`);
  }
  const { abs: sourceAbs, root: sourceRoot } = resolveSourceArtifact(record, forgeRoot);
  if (!sourceAbs) return fail(`could not locate the source bytes for ${record.uid} (source "${recordSourceId(record)}" unsynced or path "${record.path}" missing)`);

  // For a skill we copy the whole skill DIR (dirname of SKILL.md). Both endpoints become dirs.
  const sourcePoint = isSkill ? path.dirname(sourceAbs) : sourceAbs;
  const targetPoint = isSkill ? path.dirname(targetAbs) : targetAbs;
  if (!fsExists(sourcePoint)) return fail(`source ${isSkill ? 'skill dir' : 'file'} not found on disk: ${sourcePoint}`);

  const replace = fsExists(targetPoint);
  return {
    activatable: true,
    reason: '',
    kind: record.kind,
    targetPath,
    targetAbs: targetPoint,
    sourceAbs: sourcePoint,
    sourceRel: relForLog(forgeRoot, sourcePoint),
    sourceRoot,
    skill: isSkill,
    replace,
  };
}

/**
 * EXECUTE a cleared activation plan: COPY the source bytes to the library target and append
 * a provenance record to manifests/admitted.json. On a REPLACE, BACK UP the replaced bytes
 * (base64) into the admitted record FIRST so revoke can restore the original.
 *
 * SECURITY: copies BYTES only (fs read+write); the candidate is NEVER executed — fetched
 * code is untrusted DATA (ADR-0017 §security). A skill copies the whole directory tree.
 *
 * Fail-open: a torn copy leaves the target as-is (best-effort) and returns { ok:false };
 * admit then records 'refused'. Never throws.
 *
 * @param {CatalogRecord} record @param {ReturnType<typeof planActivation>} plan
 * @param {string} forgeRoot @param {any[]} findings
 * @param {{override:boolean, sourceId:string, now:string}} meta
 * @returns {{ok:boolean, targetPath:string, replace:boolean}}
 */
function activateResource(record, plan, forgeRoot, findings, meta) {
  const out = { ok: false, targetPath: plan.targetPath, replace: !!plan.replace };

  // SYMLINK / TRAVERSAL DEFENSE. The source artifact is UNTRUSTED: a synced source could
  // plant `agents/x.md` as a SYMLINK to /etc/passwd, plant a SKILL DIR `skills/<id>` as a
  // symlink to /outside/dir, or hide a symlink in an intermediate path component — any of
  // which would copy bytes from OUTSIDE the source resource root into the library. For BOTH
  // the single-file (agent/command/…) AND the skill (DIRECTORY) cases we: lstat-REFUSE the
  // resolved source endpoint (and, for a skill, its SKILL.md) AND every path component
  // between the source resource root and that endpoint if it is a symlink, THEN realpath the
  // endpoint and assert it is TRULY CONTAINED in plan.sourceRoot (a hardlink/`..` traversal
  // that resolves outside is refused too). copyDirBytes additionally skips per-ENTRY symlinks
  // INSIDE the tree, but it never checked the skill ROOT dir or its ancestors — this is that
  // missing root/component check (the symlinked-skill-directory containment escape).
  {
    const guard = assertNoSymlinkEscape(plan.sourceRoot, plan.sourceAbs, record, plan, findings);
    if (!guard) return out; // a finding was already pushed; refuse activation (no copy)
    if (plan.skill) {
      // For a skill we copy the whole DIR; the actual artifact the registry indexed is its
      // SKILL.md. Refuse if SKILL.md (the leaf inside the dir) is itself a symlink — a
      // dir-internal trick copyDirBytes would otherwise follow only if it were a regular file.
      const skillMd = path.join(plan.sourceAbs, 'SKILL.md');
      let mdSt;
      try {
        mdSt = fs.lstatSync(skillMd);
      } catch {
        // No SKILL.md inside the dir — copyDirBytes still runs; nothing to refuse here.
        mdSt = null;
      }
      if (mdSt && mdSt.isSymbolicLink()) {
        findings.push(finding('ERROR', plan.targetPath, `skill SKILL.md for ${record.uid} is a SYMLINK (${plan.sourceRel}) — REFUSED (an untrusted source must not link bytes into the library)`));
        return out;
      }
    }
  }

  // Back up the replaced bytes (T2 replace) BEFORE overwriting, so revoke can restore.
  let replaced = null;
  if (plan.replace) {
    const backupB64 = backupTargetB64(plan.targetAbs, plan.skill);
    if (backupB64 == null) {
      findings.push(finding('ERROR', plan.targetPath, `could not back up the existing library resource before replace — aborting activation of ${record.uid}`));
      return out;
    }
    replaced = { path: plan.targetPath, backupB64 };
  }

  // COPY the bytes (file or whole skill dir). Never execute.
  const copied = plan.skill
    ? copyDirBytes(plan.sourceAbs, plan.targetAbs)
    : copyFileBytes(plan.sourceAbs, plan.targetAbs);
  if (!copied) {
    findings.push(finding('ERROR', plan.targetPath, `failed to copy ${plan.skill ? 'skill dir' : 'resource bytes'} from ${plan.sourceRel} for ${record.uid} (target left intact)`));
    return out;
  }

  // Append the provenance record to manifests/admitted.json (the reversible state).
  const prov = record.source || {};
  const rec = {
    uid: record.uid,
    sourceId: meta.sourceId || '',
    repoUrl: typeof prov.repoUrl === 'string' ? prov.repoUrl : '',
    ref: typeof prov.ref === 'string' ? prov.ref : '',
    commit: typeof prov.commit === 'string' ? prov.commit : '',
    kind: record.kind,
    targetPath: plan.targetPath,
    admittedAt: meta.now,
  };
  if (replaced) rec.replaced = replaced;

  const wrote = upsertAdmitted(forgeRoot, rec);
  if (!wrote) {
    // ATOMIC ADMIT: the provenance write FAILED. Live bytes with NO provenance record are
    // unrevocable + invisible — an inconsistent half-admit. ROLL BACK: delete the copied
    // target, and on a REPLACE restore the backed-up original. Then REFUSE (ok stays false).
    rollbackActivation(plan, replaced, findings);
    findings.push(finding('ERROR', admittedRel(forgeRoot), `FAILED to record provenance for ${record.uid} in admitted.json — ROLLED BACK the copy (never leave live bytes without a provenance record)`));
    return out;
  }
  findings.push(finding('INFO', admittedRel(forgeRoot), `ACTIVATED ${record.uid} -> ${plan.targetPath}${plan.replace ? ' (REPLACE; original backed up)' : ''}`));
  out.ok = true; // bytes are live AND the provenance record was written (consistent state).
  return out;
}

/**
 * ROLL BACK a copy whose provenance write FAILED (the atomic-admit guard). Deletes the
 * copied target; on a REPLACE, restores the backed-up original from `replaced.backupB64`
 * so the library returns to its pre-admit state. Best-effort + fail-open: it emits a WARN
 * if any rollback step itself fails (an operator may need to clean up), but never throws.
 *
 * @param {ReturnType<typeof planActivation>} plan
 * @param {{path:string, backupB64:string}|null} replaced
 * @param {any[]} findings
 */
function rollbackActivation(plan, replaced, findings) {
  // Remove the freshly-copied target (file or whole skill dir).
  const removed = removePath(plan.targetAbs);
  if (!removed) {
    findings.push(finding('WARN', plan.targetPath, `rollback: could not delete the copied target ${plan.targetPath} — manual cleanup may be needed`));
  }
  // On a REPLACE, restore the original bytes we backed up before overwriting.
  if (replaced && typeof replaced.backupB64 === 'string') {
    const restored = restoreTargetB64(plan.targetAbs, plan.skill, replaced.backupB64);
    findings.push(restored
      ? finding('INFO', plan.targetPath, `rollback: restored the original ${plan.targetPath} from backup`)
      : finding('WARN', plan.targetPath, `rollback: FAILED to restore the original ${plan.targetPath} from backup — manual cleanup may be needed`));
  }
}

/**
 * SYMLINK / TRAVERSAL guard for an activation source endpoint (a FILE for agent/command/…
 * or a DIRECTORY for a skill). The source bytes are UNTRUSTED. We enforce, in order:
 *
 *   1. lstat-REFUSE the endpoint itself if it is a SYMLINK (a single-file `agents/x.md ->
 *      /etc/passwd`, OR a skill ROOT dir `skills/<id> -> /outside/dir`). This is the
 *      defense the skill (directory) path previously SKIPPED — copyDirBytes only skips
 *      per-ENTRY symlinks INSIDE the tree, never the skill root or its ancestors.
 *   2. lstat-REFUSE if ANY intermediate path COMPONENT between `sourceRoot` and the
 *      endpoint is a symlink (an attacker could plant `skills -> /outside` so the root dir
 *      itself is a regular dir but reached THROUGH a linked ancestor).
 *   3. realpath the endpoint and assert it is TRULY CONTAINED in `sourceRoot` (a hardlink
 *      or `..` that resolves outside is refused too). We compare the REALPATH (not the
 *      lexical path) against the realpath of the root — true containment, not string prefix.
 *
 * Pushes a precise ERROR finding and returns FALSE on any refusal; returns TRUE only when
 * the endpoint (and its whole component chain) is symlink-free AND resolves inside the root.
 * Fail-CLOSED: an lstat/realpath error is a refusal. When `sourceRoot` is empty we still
 * lstat-refuse the endpoint + its components (containment is then best-effort skipped).
 *
 * @param {string} sourceRoot The source resource root the endpoint must stay inside.
 * @param {string} endpoint   The absolute source FILE or skill DIR to copy from.
 * @param {CatalogRecord} record
 * @param {ReturnType<typeof planActivation>} plan
 * @param {any[]} findings
 * @returns {boolean}
 */
function assertNoSymlinkEscape(sourceRoot, endpoint, record, plan, findings) {
  const kindLabel = plan.skill ? 'skill dir' : 'source artifact';
  // 1 + 2. lstat the endpoint AND every path component from sourceRoot down to it. lstat
  // does NOT follow links, so each component is checked for being a symlink on its own.
  /** @type {string[]} */
  const components = [];
  if (sourceRoot) {
    let rootResolved;
    try {
      rootResolved = path.resolve(sourceRoot);
    } catch {
      rootResolved = '';
    }
    // Walk from the endpoint UP to (but not including) the root, collecting each component
    // that is contained within the root. Components at/above the root are the trusted source
    // cache spine we re-located ourselves and are not re-checked here.
    let cur = path.resolve(endpoint);
    const guardLimit = 4096; // defensive bound against a pathological loop
    for (let i = 0; i < guardLimit && cur && (!rootResolved || cur !== rootResolved); i++) {
      // Stop once we step outside/above the root (path.dirname of the fs root is itself).
      if (rootResolved && !isContained(rootResolved, cur)) break;
      components.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break; // reached the filesystem root
      cur = parent;
    }
  } else {
    components.push(path.resolve(endpoint)); // no root → at minimum check the endpoint itself
  }
  for (const comp of components) {
    let st;
    try {
      st = fs.lstatSync(comp);
    } catch {
      findings.push(finding('ERROR', plan.targetPath, `could not lstat the ${kindLabel} path component for ${record.uid} (${comp}) — refusing activation`));
      return false;
    }
    if (st.isSymbolicLink()) {
      const isEndpoint = path.resolve(comp) === path.resolve(endpoint);
      findings.push(finding('ERROR', plan.targetPath, isEndpoint
        ? `${kindLabel} for ${record.uid} is a SYMLINK (${plan.sourceRel}) — REFUSED (an untrusted source must not link bytes into the library)`
        : `${kindLabel} for ${record.uid} is reached through a SYMLINK path component (${comp}) — REFUSED (an untrusted source must not link bytes into the library)`));
      return false;
    }
  }

  // 3. realpath the endpoint and assert TRUE containment within the source resource root.
  if (sourceRoot) {
    let realSource;
    let realRoot;
    try {
      realSource = fs.realpathSync(endpoint);
    } catch {
      findings.push(finding('ERROR', plan.targetPath, `could not realpath the ${kindLabel} for ${record.uid} — refusing activation`));
      return false;
    }
    try {
      realRoot = fs.realpathSync(sourceRoot);
    } catch {
      // The root must itself be a real, resolvable dir for a containment claim to mean
      // anything; if it cannot be realpathed we fail CLOSED rather than trust the lexical path.
      findings.push(finding('ERROR', plan.targetPath, `could not realpath the source resource root for ${record.uid} — refusing activation`));
      return false;
    }
    if (!isContained(realRoot, realSource)) {
      findings.push(finding('ERROR', plan.targetPath, `${kindLabel} for ${record.uid} resolves OUTSIDE its source resource root (${plan.sourceRel}) — REFUSED (traversal/symlink escape)`));
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// admit ACTIVATION — source-byte resolution + byte copy + admitted.json store
// ---------------------------------------------------------------------------

/**
 * Resolve a SOURCE candidate's artifact bytes to its ABSOLUTE on-disk path AND its source
 * RESOURCE ROOT. The record's `path` is relative to its source resource root (the dir
 * buildRegistry walked); we re-find that root from the source's manifest entry
 * (locateResourceRoot — the SAME auto-detect `build` uses) and join the record path.
 * Fail-open → { abs:'', root:'' } (unsynced source / missing entry / pseudo-path /
 * `..`-escape). The `root` is returned so the copy step can REALPATH-CONTAIN the source
 * artifact inside it (symlink-aware traversal defense). Pure read.
 *
 * @param {CatalogRecord} record @param {string} forgeRoot @returns {{abs:string, root:string}}
 */
function resolveSourceArtifact(record, forgeRoot) {
  const empty = { abs: '', root: '' };
  const sourceId = recordSourceId(record);
  if (!sourceId) return empty;
  const relPath = typeof record.path === 'string' ? record.path : '';
  if (!relPath || relPath.includes('#')) return empty; // hooks (pseudo-path) are not activatable here
  const { sources } = readSourcesAndLock(forgeRoot);
  const src = sources.find((s) => s && s.id === sourceId);
  if (!src) return empty;
  const located = locateResourceRoot(src);
  if (!located.resourceRoot) return empty;
  const rootResolved = path.resolve(located.resourceRoot);
  const abs = path.resolve(rootResolved, relPath);
  // Containment: the resolved artifact must stay INSIDE the source resource root (a `..`-
  // escape in an untrusted record path could otherwise point at an arbitrary local file).
  if (!isContained(rootResolved, abs)) return empty;
  return { abs, root: rootResolved };
}

/**
 * Back-compat shim: the absolute artifact path only (callers that don't need the root).
 * @param {CatalogRecord} record @param {string} forgeRoot @returns {string}
 */
function resolveSourceArtifactPath(record, forgeRoot) {
  return resolveSourceArtifact(record, forgeRoot).abs;
}

/** True iff a path exists on disk (file or dir). Fail-open → false. */
function fsExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Repo-relative POSIX path under forgeRoot (for admitted.json + targets). Fail-open → abs. */
function repoRel(forgeRoot, abs) {
  try {
    const r = path.relative(forgeRoot, abs);
    return r ? r.split(path.sep).join('/') : abs;
  } catch {
    return abs;
  }
}

/** A human-friendly relative path for log findings (may escape root → the absolute path). */
function relForLog(forgeRoot, abs) {
  try {
    const r = path.relative(forgeRoot, abs);
    return r && !r.startsWith('..') ? r.split(path.sep).join('/') : abs;
  } catch {
    return abs;
  }
}

/**
 * COPY a single file's BYTES from src to dest, creating parent dirs. Reads then writes the
 * raw Buffer — NEVER executes. Fail-open → false (target left intact on error).
 *
 * @param {string} src @param {string} dest @returns {boolean}
 */
function copyFileBytes(src, dest) {
  try {
    const bytes = fs.readFileSync(src); // Buffer — opaque bytes, never run
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively COPY a directory's BYTES from src to dest (for skills: the whole skill dir).
 * Creates dest, copies every regular file's bytes, recurses into subdirs. Symlinks are
 * SKIPPED (an untrusted source must not plant a link out of the library). Never executes
 * any copied file. Fail-open → false on any error (best-effort partial copy left in place).
 *
 * @param {string} srcDir @param {string} destDir @returns {boolean}
 */
function copyDirBytes(srcDir, destDir) {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const ent of entries) {
      const s = path.join(srcDir, ent.name);
      const d = path.join(destDir, ent.name);
      if (ent.isSymbolicLink()) continue; // defense: never follow/plant a symlink
      if (ent.isDirectory()) {
        if (!copyDirBytes(s, d)) return false;
      } else if (ent.isFile()) {
        if (!copyFileBytes(s, d)) return false;
      }
      // sockets/fifos/etc. are ignored (not resource bytes)
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * BACK UP the bytes a REPLACE is about to overwrite, base64-encoded, so revoke can restore.
 * For a single file: the file's base64. For a skill DIR: a base64 of a deterministic JSON
 * tar-like map { "<relpath>": "<base64>" } of every file under the dir (symlinks skipped).
 * Returns null on any read error (admit then aborts the replace rather than lose the
 * original). Pure read.
 *
 * @param {string} targetAbs @param {boolean} isSkill @returns {string|null}
 */
function backupTargetB64(targetAbs, isSkill) {
  try {
    if (!isSkill) {
      return fs.readFileSync(targetAbs).toString('base64');
    }
    const map = {};
    collectDirFilesB64(targetAbs, targetAbs, map);
    return Buffer.from(JSON.stringify(map), 'utf8').toString('base64');
  } catch {
    return null;
  }
}

/** Walk a dir, filling `map[relPosixPath] = base64(bytes)` for every file (symlinks skipped). */
function collectDirFilesB64(rootDir, dir, map) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      collectDirFilesB64(rootDir, abs, map);
    } else if (ent.isFile()) {
      const rel = path.relative(rootDir, abs).split(path.sep).join('/');
      map[rel] = fs.readFileSync(abs).toString('base64');
    }
  }
}

/**
 * RESTORE a backed-up replaced resource from an admitted record's `replaced.backupB64`
 * (revoke's restore-original step). A file backup is written verbatim; a skill-dir backup
 * (the JSON map) is expanded back into the skill dir. Fail-open → false. Never executes.
 *
 * @param {string} targetAbs @param {boolean} isSkill @param {string} backupB64 @returns {boolean}
 */
function restoreTargetB64(targetAbs, isSkill, backupB64) {
  try {
    if (!isSkill) {
      const bytes = Buffer.from(backupB64, 'base64');
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, bytes);
      return true;
    }
    const map = JSON.parse(Buffer.from(backupB64, 'base64').toString('utf8'));
    if (!map || typeof map !== 'object') return false;
    fs.mkdirSync(targetAbs, { recursive: true });
    for (const rel of Object.keys(map)) {
      // Containment: a backed-up rel path must stay inside the skill dir.
      const dest = path.resolve(targetAbs, rel);
      const check = path.relative(path.resolve(targetAbs), dest);
      if (check.startsWith('..') || path.isAbsolute(check)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(map[rel], 'base64'));
    }
    return true;
  } catch {
    return false;
  }
}

/** Recursively REMOVE a path (the copied target on revoke). Fail-open → false. */
function removePath(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// admitted.json — the authoritative, reversible admitted-artifact manifest
// ---------------------------------------------------------------------------

/** Absolute path to the GLOBAL admitted manifest `<FORGE_HOME>/manifests/admitted.json`
 *  (ADR-0023). The authoritative, reversible list of what admit ACTIVATED into the library,
 *  persisted under the machine-level global config root (NOT the FORGE_ROOT checkout) so it
 *  survives library installs/upgrades. The `forgeRoot` arg is kept for the relative-path helper. */
function admittedPath(_forgeRoot) {
  return path.join(forgeHome(), 'manifests', 'admitted.json');
}

/** admitted.json rendered relative to FORGE_HOME, for findings (fail-open). */
function admittedRel(forgeRoot) {
  try {
    return path.relative(forgeHome(), admittedPath(forgeRoot)) || 'admitted.json';
  } catch {
    return 'manifests/admitted.json';
  }
}

/**
 * Read manifests/admitted.json fail-open into `{ schema, version, admitted:[] }`. A missing/
 * malformed file (or a non-array `admitted`) yields the empty canonical shape.
 *
 * @param {string} forgeRoot @returns {{schema:string, version:number, admitted:any[]}}
 */
function readAdmitted(forgeRoot) {
  const empty = { schema: ADMITTED_SCHEMA_TAG, version: ADMITTED_SCHEMA_VERSION, admitted: [] };
  const raw = readJson(admittedPath(forgeRoot));
  if (!raw || typeof raw !== 'object') return empty;
  const admitted = Array.isArray(raw.admitted) ? raw.admitted : [];
  return { schema: ADMITTED_SCHEMA_TAG, version: ADMITTED_SCHEMA_VERSION, admitted };
}

/** Persist admitted.json atomically (store.mjs), stamping schema+version. Fail-open → false. */
function persistAdmitted(forgeRoot, store) {
  const out = {
    schema: ADMITTED_SCHEMA_TAG,
    version: ADMITTED_SCHEMA_VERSION,
    admitted: store && Array.isArray(store.admitted) ? store.admitted : [],
  };
  return writeJsonAtomic(admittedPath(forgeRoot), out);
}

/**
 * Upsert a provenance record into admitted.json keyed by targetPath (one library path has
 * at most one active admission). A re-admit of the same target REPLACES the prior record.
 * Fail-open → false.
 *
 * @param {string} forgeRoot @param {object} rec @returns {boolean}
 */
function upsertAdmitted(forgeRoot, rec) {
  const store = readAdmitted(forgeRoot);
  store.admitted = store.admitted.filter((a) => !(a && a.targetPath === rec.targetPath));
  store.admitted.push(rec);
  return persistAdmitted(forgeRoot, store);
}

/**
 * Find the admitted record for a uid (optionally a specific targetPath). Returns the
 * matching record + its index, or null. Used by revoke to locate the copied target.
 *
 * @param {{admitted:any[]}} store @param {string} uid @returns {{rec:any, idx:number}|null}
 */
function findAdmitted(store, uid) {
  const list = Array.isArray(store.admitted) ? store.admitted : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].uid === uid) return { rec: list[i], idx: i };
  }
  return null;
}

// ---------------------------------------------------------------------------
// audit / judge — RECORD agent verdicts into the sidecar
// ---------------------------------------------------------------------------

/**
 * `catalog audit <uid> --agent <name> --verdict clean|suspicious|malicious [--evidence <s>] [--apply]`
 *
 * RECORD an auditor AGENT's verdict for a record into the sidecar. The auditor itself
 * runs in the Claude session; this verb only persists the verdict it produced. The
 * append target is keyed by the record's `<sourceId> <uid>`, so the same uid from two
 * sources keeps independent trails. Dry-run by default (shows the planned append);
 * `--apply` writes the sidecar atomically.
 *
 * @param {{positional:string[], values:Map<string,string>, apply:boolean}} n
 */
function doAudit(n) {
  const forgeRoot = selfForgeRoot();
  const uid = n.positional[0] || null;
  const agent = n.values.get('agent') || '';
  const verdict = n.values.get('verdict') || '';
  const evidence = n.values.get('evidence');
  const findings = [];

  if (!uid) findings.push(finding('ERROR', 'catalog', 'audit requires a <uid> argument'));
  if (!agent) findings.push(finding('ERROR', 'catalog', 'audit requires --agent <name>'));
  if (!verdict) findings.push(finding('ERROR', 'catalog', 'audit requires --verdict clean|suspicious|malicious'));
  else if (!AUDITOR_VERDICTS.has(verdict)) findings.push(finding('WARN', 'catalog', `audit verdict "${verdict}" is not one of clean|suspicious|malicious — recorded verbatim`));
  if (findings.some((f) => f.level === 'ERROR')) {
    return result(false, { uid: uid || null, applied: false }, findings);
  }

  // Resolve the record (build view) to key the verdict by its real sourceId.
  const buildRes = doBuild();
  const records = Array.isArray(buildRes.data && buildRes.data.records) ? buildRes.data.records : [];
  const record = findRecordByUid(records, uid);
  if (!record) findings.push(finding('WARN', 'catalog', `uid "${uid}" not found in the current catalog — recording the verdict anyway (keyed sourceId="")`));
  const sourceId = recordSourceId(record);

  const entryPreview = {
    agent,
    verdict,
    evidence: typeof evidence === 'string' && evidence.length > 0 ? [evidence] : [],
    recordedAt: nowIso(n),
  };
  findings.push(finding('INFO', 'catalog', `audit: ${agent} → "${verdict}" for ${uid} [source=${sourceId || 'local'}]${entryPreview.evidence.length ? ` (evidence: ${entryPreview.evidence[0]})` : ''}`));

  let written = false;
  if (n.apply) {
    const store = readVerdicts(forgeRoot);
    const entry = ensureVerdictEntry(store, sourceId, uid);
    entry.auditors.push(entryPreview);
    written = persistVerdicts(forgeRoot, store);
    findings.push(written
      ? finding('INFO', verdictsRel(forgeRoot), 'recorded auditor verdict to the sidecar')
      : finding('ERROR', verdictsRel(forgeRoot), 'failed to write the verdict sidecar (left prior file intact)'));
  } else {
    findings.push(finding('INFO', verdictsRel(forgeRoot), 'dry-run: pass --apply to record the auditor verdict'));
  }

  return result(!(n.apply && !written), {
    uid,
    sourceId,
    key: verdictKey(sourceId, uid),
    auditor: entryPreview,
    applied: !!n.apply,
    written,
  }, findings, { recorded: written ? 1 : 0 });
}

/**
 * `catalog judge <uid> --verdict keep|replace|both|quarantine [--rationale <s>] [--apply]`
 *
 * RECORD the JUDGE agent's conflict decision for a record into the sidecar (set, not
 * append — a record has at most one current judge verdict). Dry-run by default; `--apply`
 * writes atomically.
 *
 * @param {{positional:string[], values:Map<string,string>, apply:boolean}} n
 */
function doJudge(n) {
  const forgeRoot = selfForgeRoot();
  const uid = n.positional[0] || null;
  const verdict = n.values.get('verdict') || '';
  const rationale = n.values.get('rationale');
  const findings = [];

  if (!uid) findings.push(finding('ERROR', 'catalog', 'judge requires a <uid> argument'));
  if (!verdict) findings.push(finding('ERROR', 'catalog', 'judge requires --verdict keep|replace|both|quarantine'));
  else if (!JUDGE_VERDICTS.has(verdict)) findings.push(finding('WARN', 'catalog', `judge verdict "${verdict}" is not one of keep|replace|both|quarantine — recorded verbatim`));
  if (findings.some((f) => f.level === 'ERROR')) {
    return result(false, { uid: uid || null, applied: false }, findings);
  }

  const buildRes = doBuild();
  const records = Array.isArray(buildRes.data && buildRes.data.records) ? buildRes.data.records : [];
  const record = findRecordByUid(records, uid);
  if (!record) findings.push(finding('WARN', 'catalog', `uid "${uid}" not found in the current catalog — recording the verdict anyway (keyed sourceId="")`));
  const sourceId = recordSourceId(record);

  const judge = {
    verdict,
    rationale: typeof rationale === 'string' ? rationale : '',
    recordedAt: nowIso(n),
  };
  findings.push(finding('INFO', 'catalog', `judge: "${verdict}" for ${uid} [source=${sourceId || 'local'}]${judge.rationale ? ` — ${judge.rationale}` : ''}`));

  let written = false;
  if (n.apply) {
    const store = readVerdicts(forgeRoot);
    const entry = ensureVerdictEntry(store, sourceId, uid);
    entry.judge = judge;
    written = persistVerdicts(forgeRoot, store);
    findings.push(written
      ? finding('INFO', verdictsRel(forgeRoot), 'recorded judge verdict to the sidecar')
      : finding('ERROR', verdictsRel(forgeRoot), 'failed to write the verdict sidecar (left prior file intact)'));
  } else {
    findings.push(finding('INFO', verdictsRel(forgeRoot), 'dry-run: pass --apply to record the judge verdict'));
  }

  return result(!(n.apply && !written), {
    uid,
    sourceId,
    key: verdictKey(sourceId, uid),
    judge,
    applied: !!n.apply,
    written,
  }, findings, { recorded: written ? 1 : 0 });
}

// ---------------------------------------------------------------------------
// admit / revoke — CONSULT the security gate (T2), record the outcome
// ---------------------------------------------------------------------------

/**
 * Classify an admit candidate as HIGH-RISK or LOW-RISK (the human-override partition).
 *
 * HIGH-RISK iff ANY of:
 *   - kind ∈ EXECUTABLE_KINDS (hook/command/mcp) — an executable resource;
 *   - security.scan ∈ { 'flagged', 'quarantined' } — a deterministic flag/needs-review,
 *     or an adverse-auditor quarantine merged at build;
 *   - ANY merged auditor verdict is 'suspicious'/'malicious';
 *   - a REPLACE of an EXISTING library resource (plan.replace) — overwriting curated bytes.
 *
 * A HIGH-RISK admit may be applied ONLY behind a GENUINE HUMAN override (see
 * {@link verifyHumanOverride}); a self-recorded auditor verdict NEVER suffices. LOW-RISK
 * (a NEW, non-executable, deterministically-clean candidate from a reviewed source with the
 * required injection-auditor clearance) may auto-apply under `--apply` with no override.
 *
 * @param {CatalogRecord} record @param {ReturnType<typeof planActivation>} plan
 * @returns {{high:boolean, reasons:string[]}}
 */
function classifyAdmitRisk(record, plan) {
  const reasons = [];
  const sec = record.security || defaultSecurity();
  const auditors = Array.isArray(sec.auditors) ? sec.auditors : [];
  if (EXECUTABLE_KIND_SET.has(record.kind)) reasons.push(`executable kind "${record.kind}"`);
  if (BLOCKING_SCAN_STATES.has(sec.scan)) reasons.push(`security.scan="${sec.scan}"`);
  if (auditors.some((a) => a && ADVERSE_AUDITOR_VERDICTS.has(a.verdict))) reasons.push('an adverse auditor verdict (suspicious/malicious)');
  if (plan && plan.replace) reasons.push('a REPLACE of an existing library resource');
  return { high: reasons.length > 0, reasons };
}

/**
 * Verify a GENUINE HUMAN override for a HIGH-RISK admit. Returns whether the override is
 * honored + how. The ONLY accepted human signal is an INTERACTIVE-TTY confirmation:
 *
 *   INTERACTIVE TTY: when BOTH process.stdin.isTTY && process.stdout.isTTY, prompt via
 *   node:readline and require the operator to type the EXACT uid. Anything else aborts.
 *
 * There is DELIBERATELY no env-token path. A bare env token (e.g. FORGE_ADMIT_CONFIRM===uid)
 * is FORGEABLE: an in-session agent with Bash can `export` it itself and the spawned child
 * process inherits the agent's env, so the token is NOT a genuine-human signal — honoring it
 * re-opened HIGH_RISK-admit-without-a-human. A NON-INTERACTIVE caller (no TTY) is REFUSED for
 * ANY high-risk admit regardless of --override; the only way to admit a high-risk candidate
 * is to re-run from a real interactive terminal and type the uid to confirm.
 *
 * A bare `--override` from a NON-INTERACTIVE caller returns `{ honored:false, manualStep }` —
 * the caller REFUSES and prints `manualStep`.
 *
 * @param {string} uid @returns {Promise<{honored:boolean, via:string, manualStep:string}>}
 */
async function verifyHumanOverride(uid) {
  const manualStep =
    `a HIGH-RISK admit requires a genuine human override: run this in a REAL interactive terminal:\n` +
    `  • \`forge catalog admit ${uid} --override --apply\` (you will be asked to type the uid to confirm).\n` +
    `(a non-interactive caller is REFUSED; a self-recorded auditor verdict NEVER suffices — a human must confirm at a TTY.)`;

  // The ONLY accepted signal: an interactive-TTY confirmation requiring the operator to type
  // the exact uid. No env-token fallback — a bare env var is forgeable by an in-session agent
  // (the spawned child inherits the agent's env), so it is not a genuine-human signal.
  const interactive = !!(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY);
  if (interactive) {
    const typed = await promptForUid(uid);
    if (typed === uid) return { honored: true, via: 'interactive TTY confirmation', manualStep };
    return { honored: false, via: 'interactive TTY confirmation (mismatch)', manualStep };
  }

  // No TTY → a high-risk --override cannot be honored from a non-interactive caller (fail-closed).
  return { honored: false, via: 'none (non-interactive — no TTY)', manualStep };
}

/**
 * Prompt the operator (interactive TTY only) to type the exact uid to confirm a HIGH-RISK
 * admit. Uses node:readline (a node: builtin — zerodep). Resolves to the trimmed line, or
 * '' on any error/close (which the caller treats as a non-match → refuse).
 *
 * @param {string} uid @returns {Promise<string>}
 */
function promptForUid(uid) {
  return new Promise((resolve) => {
    let rl;
    try {
      // Dynamic import keeps the readline cost off the non-interactive path; node: builtin.
      import('node:readline').then((readline) => {
        try {
          rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question(
            `HIGH-RISK admit of "${uid}". Type the uid EXACTLY to confirm (anything else aborts): `,
            (answer) => {
              try { rl.close(); } catch { /* ignore */ }
              resolve(typeof answer === 'string' ? answer.trim() : '');
            },
          );
        } catch {
          resolve('');
        }
      }).catch(() => resolve(''));
    } catch {
      resolve('');
    }
  });
}

/**
 * `catalog admit <uid> [--source <id>] [--override] [--apply]`
 *
 * CONSULT the security gate (ADR-0017 §5a / §security, T2) AND, when it clears (or is
 * overridden) under `--apply`, ACTIVATE the cleared candidate into the active library.
 *
 * Pipeline: build the live catalog (deterministic scan + merged sidecar verdicts) →
 * evaluate the T2 SECURITY gate (evaluateAdmitGate — UNCHANGED, never weakened) →
 * plan the ACTIVATION (resolve the canonical library target from kind+id; detect a
 * REPLACE/collision with an existing library file) → under `--apply` COPY the resource
 * bytes from the source resource root to the target and append a provenance record to
 * manifests/admitted.json. Dry-run (no `--apply`) prints the activation PLAN and writes
 * NOTHING.
 *
 * `--source <id>` disambiguates a uid that exists in MORE than one source (a uid-collision);
 * without it the first matching catalog record wins (admitted/local preferred).
 *
 * REPLACE gate (a SECOND T2 condition, ADDITIVE to the security gate): if the resolved
 * target already EXISTS in the library, activation OVERWRITES a curated resource — that
 * is human-gated and requires `--override`. The replaced bytes are BACKED UP (base64)
 * into the admitted record so `revoke` can restore the original. A fresh (non-colliding)
 * target needs no override beyond the security gate.
 *
 * SECURITY: activation COPIES bytes ONLY; the candidate is NEVER executed (ADR-0017
 * §security — fetched code is untrusted DATA). Skills copy the whole skill directory.
 *
 * GATE RULES (ordered) — admit is REFUSED (unless `--override`) when ANY of:
 *   (1) record.security.scan ∈ { 'flagged', 'quarantined' } — a deterministic flag or a
 *       quarantine (an adverse auditor verdict merged at build);
 *   (2) ANY merged auditor verdict is 'malicious' or 'suspicious';
 *   (3) admitting an EXECUTABLE kind (hook/command) from a source whose trust !== 'reviewed'
 *       (executable-from-non-reviewed ALWAYS needs the T2 human gate, even on a clean scan);
 *   (4) [SOURCE candidates only — source !== null] there is NO injection-auditor verdict of
 *       'clean' recorded — a POSITIVE auditor clearance is REQUIRED, not merely the absence
 *       of an adverse one (the deterministic scanner is a cheap pre-filter; the agent auditor
 *       is the required semantic net so a paraphrase the regex misses still cannot be admitted
 *       without an auditor clearing it — ADR-0017 §5a). Emits the explicit finding
 *       "admit requires injection-auditor clean verdict (run the auditor) — ADR-0017";
 *   (5) [SOURCE candidates only, EXECUTABLE kinds] there is no NON-ADVERSE (not risky/
 *       suspicious|malicious, and not absent) repo-safety-auditor verdict recorded.
 * Rules (4)/(5) are EXEMPT for local/admitted (source === null) LIBRARY records — they are
 * the trusted library. When any rule fires the finding is emitted and admit refuses unless
 * `--override` (which IS the human T2 apply). A CLEAN, NON-EXECUTABLE candidate from a
 * reviewed source WITH a recorded injection-auditor 'clean' verdict may admit under `--apply`
 * with no override; a trusted library record (source === null) admits with no auditor.
 *
 * HIGH-RISK PARTITION (genuine-human override; no self-assertable clearance):
 *   HIGH_RISK = kind ∈ EXECUTABLE_KINDS (hook/command/mcp) OR security.scan ∈
 *   {flagged,quarantined} OR any auditor verdict suspicious/malicious OR a REPLACE of an
 *   existing library resource. A HIGH_RISK admit honors `--override` ONLY behind a GENUINE
 *   HUMAN signal — an INTERACTIVE TTY confirmation (process.stdin.isTTY && process.stdout.isTTY,
 *   typing the exact uid). There is DELIBERATELY no env-token path (a bare env token is forgeable
 *   by an in-session agent — the spawned child inherits the agent's env). A bare `--override`
 *   from a NON-INTERACTIVE caller (no TTY) is REFUSED for a HIGH_RISK admit, printing the exact
 *   manual step ('run this in a real interactive terminal'; a self-recorded auditor verdict never
 *   admits a high-risk candidate). LOW_RISK (a NEW, non-executable, deterministically-clean,
 *   reviewed-source, injection-auditor-clean candidate) may auto-apply under `--apply`.
 *
 * Outcome recorded: the verdict sidecar gets { action:'admit', outcome, override,
 * reasons[], recordedAt }; on a successful ACTIVATION a provenance record is also appended
 * to manifests/admitted.json (the reversible library state revoke consumes).
 *
 * @param {{positional:string[], flags:Set<string>, values:Map<string,string>, apply:boolean}} n
 * @returns {Promise<{ok:boolean, data:any, findings:any[], summary:object}>}
 */
async function doAdmit(n) {
  const forgeRoot = selfForgeRoot();
  const uid = n.positional[0] || null;
  const override = n.flags.has('override');
  const wantSource = n.values instanceof Map ? (n.values.get('source') || '') : '';
  const findings = [
    finding('INFO', 'catalog', `admit pipeline: ${PIPELINE.join(' -> ')} (security-scan = safety gate between validate and dedup; judge ONLY on conflict)`),
  ];
  if (!uid) {
    findings.push(finding('ERROR', 'catalog', 'admit requires a <uid> argument'));
    return result(false, { uid: null, applied: false }, findings);
  }

  const buildRes = doBuild();
  const records = Array.isArray(buildRes.data && buildRes.data.records) ? buildRes.data.records : [];
  const record = findRecordForAdmit(records, uid, wantSource);
  if (!record) {
    const hint = wantSource ? ` from source "${wantSource}"` : '';
    findings.push(finding('WARN', 'catalog', `uid "${uid}"${hint} not found in the current catalog — nothing to admit`));
    return result(true, { uid, applied: false, admitted: false, reasons: ['not-found'] }, findings, { admitted: 0, refused: 0 });
  }

  // --- Evaluate the T2 SECURITY gate (UNCHANGED — never weakened) -----------
  const gate = evaluateAdmitGate(record);
  for (const r of gate.reasons) {
    // The require-auditor reasons (rules 4/5) are emitted VERBATIM as the explicit
    // "admit requires …-auditor … — ADR-0017" finding; the adverse-signal reasons
    // (rules 1-3) keep the "T2 human-gate:" prefix.
    findings.push(finding('WARN', 'catalog', r.startsWith('admit requires') || r.includes('requires a non-adverse repo-safety-auditor') ? r : `T2 human-gate: ${r}`));
  }

  // --- Plan the ACTIVATION (target resolution + collision/replace detection) -
  // Computed for EVERY admit (it is the dry-run PLAN); only EXECUTED under --apply once
  // both the security gate AND the replace gate are cleared/overridden.
  const plan = planActivation(record, forgeRoot, findings);
  const securityBlocked = gate.reasons.length > 0;
  const sourceId = recordSourceId(record);

  // --- HIGH-RISK partition + GENUINE-HUMAN override (no self-assertable clearance) ---
  // A self-recorded auditor verdict must NOT suffice to admit a HIGH-RISK candidate.
  // A HIGH-RISK admit honors --override ONLY behind a genuine human signal: an interactive
  // TTY confirmation typing the uid. There is NO env-token path (a bare env var is forgeable
  // by an in-session agent — the spawned child inherits the agent's env); a non-TTY caller is REFUSED.
  const risk = classifyAdmitRisk(record, plan);
  let humanOk = !risk.high;       // LOW-RISK needs no human signal.
  let humanVia = 'low-risk';
  let humanStep = '';
  if (risk.high && override) {
    // The operator asked to override a high-risk admit — verify a genuine human signal.
    const human = await verifyHumanOverride(uid);
    humanOk = human.honored;
    humanVia = human.via;
    humanStep = human.manualStep;
    if (humanOk) {
      findings.push(finding('WARN', 'catalog', `admit: HIGH-RISK override CONFIRMED by a genuine human (${human.via}) for ${uid} [${risk.reasons.join(', ')}]`));
    }
  }
  // An effective override is one that is BOTH requested AND human-confirmed (or low-risk,
  // where override is irrelevant). A high-risk --override with no human signal is NOT effective.
  const effectiveOverride = risk.high ? (override && humanOk) : override;

  // A REPLACE (target already exists) is a SECOND T2 condition, ADDITIVE to the security
  // gate: overwriting a curated library resource requires a deliberate (genuine-human) override.
  const replaceBlocked = plan.replace && !effectiveOverride;
  const blocked = securityBlocked || replaceBlocked || !plan.activatable;

  let outcome = 'refused';
  let admitted = false;
  let activation = null;

  if (!plan.activatable) {
    // No resolvable target (unknown/unsupported kind, or unresolvable source bytes) —
    // the candidate cannot be activated even with an override.
    findings.push(finding('ERROR', 'catalog', `admit cannot activate ${uid}: ${plan.reason}`));
  } else if (risk.high && override && !humanOk) {
    // A bare --override from a NON-INTERACTIVE caller (no TTY) — or a mismatched interactive
    // confirmation — must be REFUSED for a HIGH-RISK admit. Print the EXACT manual step
    // ('run this in a real interactive terminal'; the agent cannot fabricate a TTY).
    findings.push(finding('ERROR', 'catalog', `admit REFUSED for ${uid}: --override is NOT honored for a HIGH-RISK admit [${risk.reasons.join(', ')}] without a genuine human signal (via=${humanVia}). ${humanStep}`));
  } else if (securityBlocked && !effectiveOverride) {
    findings.push(finding('ERROR', 'catalog', `admit REFUSED for ${uid}: ${gate.reasons.length} T2 security gate condition(s) — re-run with --override (the human T2 apply) to admit deliberately`));
  } else if (replaceBlocked) {
    findings.push(finding('ERROR', 'catalog', `admit REFUSED for ${uid}: target "${plan.targetPath}" already exists in the library (a REPLACE of a curated resource) — re-run with --override (T2) to replace it (the original bytes are backed up for revoke)`));
  } else {
    // CLEARED (or genuinely-overridden). Announce the plan; activate only under --apply.
    if (securityBlocked) {
      findings.push(finding('WARN', 'catalog', `admit: T2 security gate OVERRIDDEN by human for ${uid} (--override)`));
    }
    findings.push(finding('INFO', 'catalog',
      `admit PLAN ${uid} -> ${plan.targetPath} (kind=${record.kind}, ${plan.replace ? 'REPLACE [T2 --override]' : 'NEW'}, copy ${plan.skill ? 'skill dir' : 'file'} from ${plan.sourceRel})`));
    if (n.apply) {
      activation = activateResource(record, plan, forgeRoot, findings, { override: effectiveOverride, sourceId, now: nowIso(n) });
      admitted = activation.ok;
      outcome = activation.ok ? 'admitted' : 'refused';
    } else {
      outcome = 'refused';
      findings.push(finding('INFO', 'catalog', `admit: dry-run — pass --apply to ACTIVATE ${uid} into the library`));
    }
  }

  // --- Record the outcome to the verdict sidecar (under --apply) ------------
  const admission = { action: 'admit', outcome, override: !!override, reasons: gate.reasons, recordedAt: nowIso(n) };
  let written = false;
  if (n.apply) {
    const store = readVerdicts(forgeRoot);
    const entry = ensureVerdictEntry(store, sourceId, uid);
    entry.admissions.push(admission);
    written = persistVerdicts(forgeRoot, store);
    findings.push(written
      ? finding('INFO', verdictsRel(forgeRoot), `recorded admit outcome "${outcome}" to the sidecar`)
      : finding('ERROR', verdictsRel(forgeRoot), 'failed to write the verdict sidecar (left prior file intact)'));
  } else {
    findings.push(finding('INFO', verdictsRel(forgeRoot), 'dry-run: pass --apply to ACTIVATE + record the admit outcome'));
  }

  // ok mirrors envelope semantics: false iff an ERROR finding was emitted (a blocked-
  // without-override refusal, an unactivatable candidate, or a failed write). A
  // clean/overridden activation is ok.
  const ok = !findings.some((f) => f.level === 'ERROR');
  return result(ok, {
    uid,
    sourceId,
    kind: record.kind,
    scan: record.security && record.security.scan,
    pipeline: PIPELINE,
    blocked,
    securityBlocked,
    replace: !!plan.replace,
    targetPath: plan.targetPath,
    activatable: plan.activatable,
    override: !!override,
    highRisk: risk.high,
    riskReasons: risk.reasons,
    humanOverride: !!(risk.high && override && humanOk),
    humanOverrideVia: humanVia,
    effectiveOverride,
    admitted,
    outcome,
    reasons: gate.reasons,
    admissionState: admitted ? 'admitted' : record.admissionState,
    activation,
    applied: !!n.apply,
    written,
  }, findings, { admitted: admitted ? 1 : 0, refused: outcome === 'refused' ? 1 : 0, blocked: blocked ? 1 : 0 });
}

/**
 * Evaluate the T2 admit gate for a record. Pure — returns the list of human-readable
 * gate reasons (empty = clear). See doAdmit for the full ordered rule set.
 *
 * The first three rules block on an ADVERSE signal (a flag/quarantine, an adverse auditor
 * verdict, or an executable from a non-reviewed source). Rules (4)+(5) STRENGTHEN the
 * gate for a SOURCE candidate (record.source !== null — the untrusted catalog state):
 * admission now requires a POSITIVE agent-auditor clearance, not merely the ABSENCE of an
 * adverse one. The deterministic scanner is a cheap pre-filter; the agent auditor is the
 * REQUIRED semantic net (ADR-0017 §5a), so a paraphrase the regex misses still cannot be
 * admitted without an auditor clearing it. Local/admitted (source === null) LIBRARY records
 * are EXEMPT — they are the trusted library, never gated on an auditor clearance.
 *
 * @param {CatalogRecord} record
 * @returns {{reasons:string[]}}
 */
function evaluateAdmitGate(record) {
  const reasons = [];
  const sec = record.security || defaultSecurity();
  const auditors = Array.isArray(sec.auditors) ? sec.auditors : [];
  // A SOURCE candidate is untrusted/catalog state (provenance present); a null-source
  // record is the trusted local library and is exempt from the require-auditor rules.
  const isSource = !!record.source;

  // (1) deterministic flag / quarantine.
  if (BLOCKING_SCAN_STATES.has(sec.scan)) {
    reasons.push(`security.scan is "${sec.scan}" — a flagged/quarantined candidate is never auto-admitted (ADR-0017 §5a)`);
  }
  // (2) adverse auditor verdict.
  const adverse = auditors.filter((a) => a && ADVERSE_AUDITOR_VERDICTS.has(a.verdict));
  if (adverse.length > 0) {
    const which = adverse.map((a) => `${a.agent || '?'}=${a.verdict}`).join(', ');
    reasons.push(`adverse auditor verdict(s): ${which}`);
  }
  // (3) executable kind from a non-reviewed source.
  if (EXECUTABLE_KIND_SET.has(record.kind)) {
    const trust = record.source && typeof record.source.trust === 'string' ? record.source.trust : '';
    if (trust !== TRUST_REVIEWED) {
      reasons.push(`executable kind "${record.kind}" from a source whose trust is "${trust || 'untrusted'}" (!= "${TRUST_REVIEWED}") — always human-gated (ADR-0017 §security)`);
    }
  }
  // (4) require-auditor (SOURCE candidates only): a POSITIVE injection-auditor 'clean'
  //     verdict MUST be recorded — the agent is the required semantic net, not optional.
  if (isSource && !hasCleanInjectionAuditor(auditors)) {
    reasons.push('admit requires injection-auditor clean verdict (run the auditor) — ADR-0017');
  }
  // (5) require-auditor for EXECUTABLE kinds (SOURCE candidates only): additionally a
  //     repo-safety-auditor verdict that is NOT adverse (risky/suspicious|malicious) and
  //     not absent — an executable needs a positive repo-safety clearance.
  if (isSource && EXECUTABLE_KIND_SET.has(record.kind) && !hasNonAdverseRepoSafetyAuditor(auditors)) {
    reasons.push(`executable kind "${record.kind}" requires a non-adverse repo-safety-auditor verdict (run the auditor) — ADR-0017 §5a`);
  }
  return { reasons };
}

/**
 * True when the auditor list carries a POSITIVE injection-auditor clearance — an entry
 * whose agent is the injection-auditor and whose verdict is 'clean'. (Mere absence of an
 * adverse verdict is NOT enough; the gate requires this affirmative clearance.) Pure.
 *
 * @param {CatalogAuditorVerdict[]} auditors @returns {boolean}
 */
function hasCleanInjectionAuditor(auditors) {
  for (const a of auditors) {
    if (a && a.agent === INJECTION_AUDITOR && a.verdict === 'clean') return true;
  }
  return false;
}

/**
 * True when the auditor list carries a repo-safety-auditor verdict that is PRESENT and NOT
 * adverse. The repo-safety-auditor maps its raw safe|risky|malicious into the
 * clean|suspicious|malicious slot, so a non-adverse clearance is a recorded 'clean' (and we
 * defensively also reject a verbatim raw 'risky'/'malicious'). An absent repo-safety verdict
 * does NOT clear an executable candidate. Pure.
 *
 * @param {CatalogAuditorVerdict[]} auditors @returns {boolean}
 */
function hasNonAdverseRepoSafetyAuditor(auditors) {
  let found = false;
  for (const a of auditors) {
    if (!a || a.agent !== REPO_SAFETY_AUDITOR) continue;
    found = true;
    if (ADVERSE_AUDITOR_VERDICTS.has(a.verdict) || REPO_SAFETY_RAW_ADVERSE.has(a.verdict)) return false;
  }
  return found; // present AND none adverse
}

/**
 * `catalog revoke <uid> [--apply]` — DE-ACTIVATE an admitted artifact: DELETE the copied
 * library target (RESTORE the replaced original from the admitted record's backup, if any)
 * and DROP the uid from manifests/admitted.json. The revoke outcome is also recorded to the
 * verdict sidecar (the audit trail). Dry-run by default plans; `--apply` executes.
 *
 * The authoritative source is manifests/admitted.json (NOT the live catalog build): once
 * admitted, the resource is a normal library file whose source may be gone. We look the uid
 * up there to find its targetPath + backup. Fail-open + IDEMPOTENT: an unknown uid (never
 * admitted, or already revoked) is a WARN no-op that returns a valid envelope.
 *
 * @param {{positional:string[], apply:boolean}} n
 */
function doRevoke(n) {
  const forgeRoot = selfForgeRoot();
  const uid = n.positional[0] || null;
  const findings = [
    finding('INFO', 'catalog', 'revoke DELETEs the copied library target (restoring a replaced original from backup) and drops the uid from admitted.json — ADR-0017'),
  ];
  if (!uid) {
    findings.push(finding('ERROR', 'catalog', 'revoke requires a <uid> argument'));
    return result(false, { uid: null, applied: false }, findings);
  }

  // Authoritative reversible state: the admitted manifest, not the catalog build.
  const store = readAdmitted(forgeRoot);
  const hit = findAdmitted(store, uid);

  // IDEMPOTENT: unknown uid → WARN no-op (still a valid, ok envelope).
  if (!hit) {
    findings.push(finding('WARN', 'catalog', `uid "${uid}" is not in admitted.json (never admitted, or already revoked) — no-op`));
    return result(true, { uid, applied: !!n.apply, found: false, removed: false, restored: false }, findings, { revoked: 0 });
  }

  const rec = hit.rec;
  const targetPath = typeof rec.targetPath === 'string' ? rec.targetPath : '';
  const targetAbs = targetPath ? path.resolve(forgeRoot, targetPath) : '';
  const isSkill = rec.kind === 'skill';
  const targetPoint = isSkill && targetAbs ? path.dirname(targetAbs) : targetAbs; // skill dir
  const hasBackup = !!(rec.replaced && typeof rec.replaced.backupB64 === 'string');

  findings.push(finding('INFO', 'catalog',
    `revoke PLAN ${uid}: DELETE ${targetPath || '(no path)'}${hasBackup ? ` then RESTORE original from backup` : ''}`));

  const sourceId = typeof rec.sourceId === 'string' ? rec.sourceId : '';
  let removed = false;
  let restored = false;
  let written = false;
  let manifestWritten = false;

  if (n.apply) {
    if (targetPoint) {
      // DELETE the copied target. (When a backup exists we overwrite-restore below; for a
      // file we still remove first so a restore writes a clean original, for a skill dir we
      // remove the whole copied tree then restore the original tree.)
      removed = removePath(targetPoint);
      if (!removed) findings.push(finding('WARN', targetPath, `could not delete the copied target (may already be gone) — continuing`));
      if (hasBackup) {
        restored = restoreTargetB64(targetAbs, isSkill, rec.replaced.backupB64);
        findings.push(restored
          ? finding('INFO', targetPath, 'restored the replaced original from backup')
          : finding('ERROR', targetPath, 'FAILED to restore the replaced original from backup'));
      }
    } else {
      findings.push(finding('WARN', 'catalog', `admitted record for ${uid} has no targetPath — nothing on disk to delete`));
    }

    // Drop the uid from admitted.json (authoritative state).
    store.admitted.splice(hit.idx, 1);
    manifestWritten = persistAdmitted(forgeRoot, store);
    findings.push(manifestWritten
      ? finding('INFO', admittedRel(forgeRoot), `dropped ${uid} from admitted.json`)
      : finding('ERROR', admittedRel(forgeRoot), 'failed to update admitted.json (left prior file intact)'));

    // Record the revoke outcome to the verdict sidecar (audit trail).
    const verdicts = readVerdicts(forgeRoot);
    const entry = ensureVerdictEntry(verdicts, sourceId, uid);
    entry.admissions.push({ action: 'revoke', outcome: 'revoked', override: false, reasons: [], recordedAt: nowIso(n) });
    written = persistVerdicts(forgeRoot, verdicts);
    if (!written) findings.push(finding('WARN', verdictsRel(forgeRoot), 'failed to record the revoke outcome to the sidecar (advisory)'));
  } else {
    findings.push(finding('INFO', 'catalog', 'dry-run: pass --apply to DELETE the target + drop from admitted.json'));
  }

  const ok = !findings.some((f) => f.level === 'ERROR');
  return result(ok, {
    uid,
    sourceId,
    found: true,
    targetPath,
    restored,
    removed,
    hadBackup: hasBackup,
    applied: !!n.apply,
    manifestWritten,
    written,
  }, findings, { revoked: n.apply && manifestWritten ? 1 : 0 });
}

/**
 * Persist the verdict sidecar atomically, stamping schema + version. Returns true on a
 * successful atomic replace, false on any IO error (prior file left intact — fail-open).
 *
 * @param {string} forgeRoot @param {{records:Object}} store @returns {boolean}
 */
function persistVerdicts(forgeRoot, store) {
  const out = {
    schema: VERDICTS_SCHEMA_TAG,
    version: VERDICTS_SCHEMA_VERSION,
    records: store && store.records && typeof store.records === 'object' ? store.records : {},
  };
  return writeJsonAtomic(verdictsPath(forgeRoot), out);
}

/** The sidecar path rendered relative to FORGE_HOME, for findings (e.g. ".forge/catalog-verdicts.json"). */
function verdictsRel(forgeRoot) {
  try {
    return path.relative(forgeHome(), verdictsPath(forgeRoot)) || 'catalog-verdicts.json';
  } catch {
    return '.forge/catalog-verdicts.json';
  }
}

/** The recorded-at timestamp: deterministic placeholder unless `--now <iso>` was given. */
function nowIso(n) {
  const v = n && n.values instanceof Map ? n.values.get('now') : '';
  if (typeof v === 'string' && v.length > 0) return v;
  try {
    return new Date().toISOString();
  } catch {
    return '1970-01-01T00:00:00Z';
  }
}

/**
 * C4 `summarize(state)` — pure; map a run-state to a one-panel summary. Returns a
 * `(no data)` panel when no records array is present (fail-open).
 * @param {any} state @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  const records = state && typeof state === 'object' && Array.isArray(state.records) ? state.records : null;
  if (!records) {
    return makePanel({ panel: 'catalog', ok: false, lines: ['(no data)'], hint: 'forge catalog build' });
  }
  const admitted = records.filter((r) => r && r.admissionState === 'admitted').length;
  return makePanel({
    panel: 'catalog',
    ok: true,
    lines: [`${records.length} record${records.length === 1 ? '' : 's'}`, `${admitted} admitted`],
  });
}

/** Build a Panel with a non-enumerable toString (mirrors mcp.mjs#makePanel). */
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
    'forge catalog build                                                  Assemble the unified catalog (runs the deterministic security scan on source candidates; merges recorded verdicts).',
    'forge catalog ls                                                     List catalog records (the build view).',
    'forge catalog dedup                                                  Deterministic dedup classification across the catalog.',
    'forge catalog audit <uid> --agent <name> --verdict clean|suspicious|malicious [--evidence <s>] [--apply]   Record an auditor agent verdict.',
    'forge catalog judge <uid> --verdict keep|replace|both|quarantine [--rationale <s>] [--apply]               Record the judge verdict.',
    'forge catalog admit <uid> [--source <id>] [--override] [--apply]     Consult the T2 security gate, then ACTIVATE the cleared candidate into the library (copy bytes). Dry-run prints the plan; --apply activates (a REPLACE of an existing resource needs --override).',
    'forge catalog revoke <uid> [--apply]                                 DELETE the copied library target (restore a replaced original) and drop the uid from admitted.json. Dry-run plans; --apply executes; idempotent.',
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
  } else if (subcmd === 'build' || subcmd === 'ls') {
    const records = Array.isArray(data.records) ? data.records : [];
    out.push(`catalog ${subcmd}: ${records.length} record(s)`);
    for (const r of records) {
      const prov = r.source && r.source.sourceId ? r.source.sourceId : 'local';
      out.push(`  ${r.uid || '(no-uid)'}\t${r.admissionState || '?'}\t[${prov}]`);
    }
  } else if (subcmd === 'dedup') {
    const records = Array.isArray(data.records) ? data.records : [];
    const c = data.counts || {};
    out.push(`catalog dedup: ${records.length} record(s) — ${c.unique || 0} unique, ${c['exact-dup'] || 0} exact-dup, ${c['uid-collision'] || 0} uid-collision, ${c['near-dup'] || 0} near-dup`);
    for (const cf of data.conflicts || []) out.push(`  ! ${cf.uid}\t${cf.class}\t-> ${(cf.peers || []).join(', ')}`);
  } else if (subcmd === 'audit') {
    const a = data.auditor || {};
    out.push(`catalog audit ${data.uid || ''}: ${a.agent || '?'} → "${a.verdict || '?'}" [source=${data.sourceId || 'local'}]${data.written ? ' (recorded)' : data.applied ? ' (write FAILED)' : ' (dry-run)'}`);
  } else if (subcmd === 'judge') {
    const j = data.judge || {};
    out.push(`catalog judge ${data.uid || ''}: "${j.verdict || '?'}" [source=${data.sourceId || 'local'}]${data.written ? ' (recorded)' : data.applied ? ' (write FAILED)' : ' (dry-run)'}`);
  } else if (subcmd === 'admit') {
    out.push(`catalog admit ${data.uid || ''}: ${data.outcome || '?'}${data.override ? ' (--override)' : ''} — kind=${data.kind || '?'}, target=${data.targetPath || '?'}, ${data.replace ? 'REPLACE' : 'NEW'}, scan=${data.scan || '?'}, blocked=${!!data.blocked}${data.applied ? (data.admitted ? ' (ACTIVATED)' : ' (not activated)') : ' (dry-run plan)'}`);
    for (const r of data.reasons || []) out.push(`  ! T2 gate: ${r}`);
  } else if (subcmd === 'revoke') {
    if (data.found === false) out.push(`catalog revoke ${data.uid || ''}: not in admitted.json — no-op`);
    else out.push(`catalog revoke ${data.uid || ''}: DELETE ${data.targetPath || '(no path)'}${data.hadBackup ? ' + restore original' : ''}${data.applied ? (data.removed || data.restored ? ' (revoked)' : ' (revoke FAILED)') : ' (dry-run plan)'}`);
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
//   node manager/catalog.mjs <subcmd> [flags] [uid]
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

// The synchronous `--json` emit (writeStdoutSync) is now the SHARED helper in
// lib/json-out.mjs — see its WHY (pipe-flush truncation). We import it above rather
// than keep a local duplicate.

if (isMain()) {
  const argv = process.argv.slice(2);
  const subcmd = argv[0];
  const rest = argv.slice(1);
  const json = rest.includes('--json');
  run(subcmd, rest, {})
    .then((res) => {
      if (json) {
        const env = envelope({
          command: `catalog ${subcmd || ''}`.trim(),
          ok: res.ok,
          data: res.data,
          findings: res.findings,
          summary: res.summary,
          forgeVersion: readRunningVersion(selfForgeRoot()),
        });
        writeStdoutSync(JSON.stringify(env) + '\n');
        process.exit(res.ok ? 0 : (res.findings || []).some((f) => f.level === 'ERROR') ? 1 : 0);
      } else {
        process.exit(renderHuman(subcmd, res));
      }
    })
    .catch(() => process.exit(1)); // fail-open: never an unhandled rejection
}

export default { run, summarize };
