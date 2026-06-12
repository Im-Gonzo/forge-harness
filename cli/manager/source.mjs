// @ts-check
/**
 * source — the manager's federated-source registry operator (ADR-0017).
 *
 * The federated catalog lets Forge register EXTERNAL Git/local repos as "sources",
 * sync their resources into a discoverable CATALOG, and (later) admit curated ones
 * into the active library. This module owns the SOURCE REGISTRY half: the small,
 * git-tracked manifest `manifests/sources.json` (`forge.sources.v1`) listing every
 * registered source. The CATALOG/admission half lives in manager/catalog.mjs.
 *
 * The two roots, kept STRICTLY separate (mirrors mcp.mjs/memory.mjs):
 *   - FORGE_ROOT  — this library's install location (two levels up from this
 *                   module). The source MANIFEST is read/written here:
 *                   `<FORGE_ROOT>/manifests/sources.json`. The sync LOCKFILE is
 *                   written here too: `<FORGE_ROOT>/.forge/sources.lock`.
 *   - CACHE       — the MACHINE-LOCAL managed cache (LOCKED fork #1; ADR-0010/C6),
 *                   the only place `sync` ever writes fetched bytes — NEVER a git
 *                   work tree. `sync` SHALLOW-CLONES each git source into its <id>
 *                   subdir under `~/.claude/forge-sources` (clone + read ONLY).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CACHE LAYOUT + LOCKFILE CONTRACT (LOCKED — implemented by a later `sync` Build)
 * ─────────────────────────────────────────────────────────────────────────────
 *   - Managed cache dir:  ~/.claude/forge-sources/<id>
 *       `forge source sync` SHALLOW-CLONES each registered git source into its own
 *       <id> subdir (a local source is copied/linked). The cache is machine-local,
 *       lives OUTSIDE any git work tree, and its bytes are NEVER committed (C6).
 *   - Lockfile:           <FORGE_ROOT>/.forge/sources.lock
 *       Pins the exact synced commit per source for reproducibility. Shape:
 *         { "schema": "forge.sources.lock.v1", "version": 1,
 *           "sources": [ { "id", "url", "ref", "commit", "syncedAt" } ] }
 *       `commit` is the resolved sha the cache currently holds; admitted artifacts
 *       copy it into their registry `source.commit` provenance (ADR-0017 §4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY STANCE (external repos are UNTRUSTED — baked into the contract now)
 * ─────────────────────────────────────────────────────────────────────────────
 *   - Every new source is registered as trust="untrusted".
 *   - `sync` ONLY clones + reads. It NEVER executes fetched code (no build, no
 *     postinstall, no npm, no hook registration as a side-effect of syncing) and
 *     NEVER recurses submodules. The clone is EXACTLY
 *     `git clone --depth 1 --no-recurse-submodules --branch <ref> <url> <dir>`;
 *     the commit is then resolved read-only with `git -C <dir> rev-parse HEAD`.
 *   - Foreign hooks/commands never auto-enable; synced resources stay INERT in the
 *     catalog until `forge catalog admit` (catalog-until-admitted, ADR-0017 §1).
 *   - `trust <id>` (untrusted → reviewed) is a deliberate human action — a
 *     SECURITY-GATED flip that TRUST GATES ADMISSION: only trusted/reviewed
 *     sources may be admitted into the active library; untrusted stay catalog-only.
 *
 * DECISIONS (locked, mirrors mcp.mjs):
 *   - Preview by default — `add`/`remove` write NOTHING unless `--apply`. The
 *     default run returns a plan; `--apply` persists it (atomic).
 *   - Additive-never-destructive — `add` NEVER clobbers an existing source id; a
 *     duplicate id is skipped with a WARN. `remove` of an absent id is a WARN.
 *
 * HARD INVARIANTS (the plugin payload contract): zero runtime deps (node: builtins
 * + relative imports only — lint/validate-manager-zerodep.mjs enforces this);
 * additive-never-destructive; writers PREVIEW by default (write only under
 * `--apply`); fail-open (no public entry throws past its surface — it degrades to a
 * safe `{ok,data,findings,summary}` envelope). Dual-mode with an `isMain()` guard —
 * NEVER process.exit() at import time.
 *
 * Subcommands (C4 `run(subcmd, args, ctx)`):
 *   - `list`                          — enumerate registered sources → data.sources[].
 *   - `add <id> <url> [--ref <r>] [--apply]` — register a new git source (default
 *                                       ref "main", trust "untrusted"). Preview by
 *                                       default; --apply writes the manifest. Skip+WARN
 *                                       a duplicate id (never clobber).
 *   - `remove <id> [--apply]`         — drop a source by id. Preview by default;
 *                                       --apply writes. Absent id ⇒ WARN.
 *   - `sync [id] [--apply]`           — shallow-clone git source(s) into
 *                                       ~/.claude/forge-sources/<id> (clone+read
 *                                       ONLY) + pin the resolved commit in .forge/
 *                                       sources.lock. local sources are verified
 *                                       (no clone) and pinned commit:null. Dry-run
 *                                       by default (plan only, writes nothing);
 *                                       --apply executes. Fail-open per source.
 *   - `trust <id> [--apply]`          — flip a source untrusted → reviewed in
 *                                       manifests/sources.json (TRUST GATES
 *                                       ADMISSION). Dry-run shows the diff; --apply
 *                                       writes via the atomic store.
 *
 * @module manager/source
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeFinding } from './lib/findings.mjs';
import { envelope, writeStdoutSync } from './lib/json-out.mjs';
import { readJson, writeJsonAtomic, forgeHome } from './lib/store.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The emitter stamped on findings this module raises (C2 `source`). */
const SOURCE = 'source';

/** The on-disk manifest schema tag (matches schemas/sources.schema.json). */
const SCHEMA_TAG = 'forge.sources.v1';

/** The manifest's current version integer. */
const SCHEMA_VERSION = 1;

/** Default ref tracked by a newly-added source (LOCKED default). */
const DEFAULT_REF = 'main';

/** Default trust level for every new source (LOCKED: untrusted). */
const DEFAULT_TRUST = 'untrusted';

/** Default source kind for `add` (git remote). */
const DEFAULT_KIND = 'git';

/** Deterministic timestamp placeholder when no `--now` is given (mirrors memory.mjs). */
const DEFAULT_NOW = '1970-01-01T00:00:00Z';

/** The on-disk lockfile schema tag (LOCKED Foundation contract). */
const LOCK_SCHEMA_TAG = 'forge.sources.lock.v1';

/** The lockfile's current version integer. */
const LOCK_SCHEMA_VERSION = 1;

/** Trust level a `reviewed` source carries after a deliberate `trust` flip. */
const TRUST_REVIEWED = 'reviewed';

/**
 * Per-invocation `-c` hardening flags applied to EVERY networked git call (clone
 * AND re-sync fetch). Defence in depth behind the url allowlist (Critical #1):
 *   - protocol.ext.allow=never  — the ext:: transport helper (arbitrary shell
 *     command on clone) is unconditionally refused;
 *   - protocol.allow=user       — restrict transports to the user-allowed class,
 *     blocking exotic helpers; combined with GIT_PROTOCOL_FROM_USER=0 this also
 *     demotes `file`, so we re-permit it explicitly:
 *   - protocol.file.allow=always — keep `file://` working for LOCAL sources and
 *     the file:// test fixtures (file is safe — no shell-out), while ext:: et al
 *     stay blocked by the rules above.
 * Paired with GIT_PROTOCOL_FROM_USER=0 in runGit's env.
 */
const GIT_PROTOCOL_HARDENING = [
  '-c', 'protocol.ext.allow=never',
  '-c', 'protocol.allow=user',
  '-c', 'protocol.file.allow=always',
];

// ---------------------------------------------------------------------------
// URL / ref validation (Critical #1 — sync RCE: git transport-helper injection)
// ---------------------------------------------------------------------------
//
// git's pluggable transports turn a "url" into command execution at CLONE time:
//   ext::sh -c "<arbitrary shell>"   (transport_helper "ext" runs a shell command)
//   fd::<n>, and any `<helper>::<rest>` transport-helper form
// core.hooksPath=/dev/null does NOT stop this — the command runs as part of the
// transport, before any hook. The ONLY safe defence is to (a) ALLOWLIST the url
// scheme so transport-helper forms never reach git, and (b) belt-and-braces, tell
// git itself to refuse them (protocol.ext.allow=never / protocol.allow=user /
// GIT_PROTOCOL_FROM_USER=0). We also reject any url/ref that begins with '-' so a
// crafted value can never be parsed as a git option (argv injection).

/**
 * Allowlisted url SCHEMES for a git source. Anything else (especially the
 * transport-helper forms ext::/fd::/<helper>::) is REJECTED — not registered.
 *   - https:// http://   — the common remote transports
 *   - git://             — the native git protocol
 *   - ssh://             — explicit-scheme ssh
 *   - file://            — local repos (kept allowed for local sources + tests)
 * scp-like `git@host:path` (no scheme) is handled separately by SCP_LIKE_RE.
 */
const ALLOWED_URL_SCHEMES = new Set(['https', 'http', 'git', 'ssh', 'file']);

/** scp-like ssh shorthand: `user@host:path` (no `://`, exactly one `:` group). */
const SCP_LIKE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:(?!\/\/).+$/;

/**
 * Validate a source URL against the transport allowlist. Returns `null` when the
 * url is acceptable, else a human reason string describing the rejection.
 *
 * REJECTS (in order): a non-string/empty url; a '-'-leading url (argv injection);
 * a `<helper>::<rest>` transport-helper form (ext::/fd::/etc — the RCE vector);
 * any scheme not in ALLOWED_URL_SCHEMES. A scp-like `git@host:path` is accepted.
 * @param {unknown} url
 * @returns {string|null} rejection reason, or null when allowed
 */
function urlRejectReason(url) {
  if (typeof url !== 'string' || url.length === 0) return 'url is empty';
  // argv-injection guard: a leading '-' could be parsed by git as an option.
  if (url.startsWith('-')) return `url may not begin with '-' (argv injection): ${url}`;
  // Transport-helper form `<helper>::<rest>` (ext::, fd::, …) is the RCE vector.
  // Match a helper token followed by '::' anywhere a scheme would sit. git treats
  // ANY `name::rest` as "run remote-helper name" — never allow it.
  if (/^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(url) || url.includes('::')) {
    return `url uses a git transport-helper form (e.g. ext::/fd::) which can execute a shell command — rejected: ${url}`;
  }
  // Explicit `scheme://…` form — the scheme must be on the allowlist.
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (!ALLOWED_URL_SCHEMES.has(scheme)) {
      return `url scheme "${scheme}://" is not allowed (allowed: https/http/git/ssh/file, or scp-like git@host:path): ${url}`;
    }
    return null;
  }
  // No `scheme://` — accept ONLY the scp-like ssh shorthand `git@host:path`.
  if (SCP_LIKE_RE.test(url)) return null;
  // A bare `scheme:rest` (single colon, no `//`) is a non-allowlisted transport
  // shorthand — reject it (covers e.g. `git:foo`, `helper:rest`).
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) {
    return `url is not an allowed transport (allowed: https/http/git/ssh/file://, or scp-like git@host:path): ${url}`;
  }
  return `url is not an allowed transport (allowed: https/http/git/ssh/file://, or scp-like git@host:path): ${url}`;
}

/**
 * Validate a git ref. Returns `null` when acceptable, else a reason. The only
 * security-relevant rule here is the argv-injection guard: a '-'-leading ref
 * could be parsed by git as an option (e.g. `--upload-pack=…`).
 * @param {unknown} ref
 * @returns {string|null}
 */
function refRejectReason(ref) {
  if (ref === null || ref === undefined) return null; // defaulted downstream
  if (typeof ref !== 'string') return 'ref must be a string';
  if (ref.startsWith('-')) return `ref may not begin with '-' (argv injection): ${ref}`;
  return null;
}

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

/**
 * The GLOBAL sources manifest path under FORGE_HOME (ADR-0023): the ONLY
 * persistent state file this module writes. It lives under the machine-level
 * global config root (`$FORGE_HOME`, default `~/.forge`), NOT inside the
 * FORGE_ROOT library checkout — so the registered-source set persists across
 * library installs/upgrades and is shared by every project on the machine. The
 * `forgeRoot` arg is retained for the (now-degenerate, fail-open) relative-path
 * display helpers; the manifest location no longer depends on it.
 */
function manifestPath(_forgeRoot) {
  return path.join(forgeHome(), 'manifests', 'sources.json');
}

/** FORGE_HOME-relative manifest path for finding paths (fail-open). */
function relManifest(forgeRoot) {
  try {
    return path.relative(forgeHome(), manifestPath(forgeRoot)) || manifestPath(forgeRoot);
  } catch {
    return 'manifests/sources.json';
  }
}

/**
 * The MACHINE-LOCAL managed-cache root (LOCKED fork #1; ADR-0010/C6):
 * `~/.claude/forge-sources`. This is the ONLY place `sync` writes fetched bytes.
 * It lives OUTSIDE any git work tree and is NEVER committed. Resolved the same
 * way store.mjs#machineStateHome resolves home ($HOME/$USERPROFILE, sandbox-
 * friendly, falling back to os.homedir()). Pure join; does not create the dir.
 */
function cacheRoot() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
  return path.join(home, '.claude', 'forge-sources');
}

/** The absolute per-source cache dir `~/.claude/forge-sources/<id>`. */
function cacheDirFor(id) {
  return path.join(cacheRoot(), id);
}

/** The display form of a source's cache dir (tilde-rooted, for the dry-run plan). */
function cacheDirDisplay(id) {
  return `~/.claude/forge-sources/${id}`;
}

/** The sync lockfile path `<FORGE_HOME>/.forge/sources.lock` (ADR-0023). Machine-level GLOBAL
 *  federation state, persisted under the global config root (NOT the FORGE_ROOT checkout). */
function lockPath(_forgeRoot) {
  return path.join(forgeHome(), '.forge', 'sources.lock');
}

/** FORGE_HOME-relative lockfile path for finding paths (fail-open). */
function relLock(forgeRoot) {
  try {
    return path.relative(forgeHome(), lockPath(forgeRoot)) || lockPath(forgeRoot);
  } catch {
    return path.join('.forge', 'sources.lock');
  }
}

// ---------------------------------------------------------------------------
// Manifest reads
// ---------------------------------------------------------------------------

/**
 * Read + normalize the sources manifest. An ABSENT file degrades to a fresh empty
 * manifest (the additive contract: we may create it). A present-but-malformed file
 * degrades to `{ malformed:true }` so a writer can refuse to edit. Fail-open.
 * @param {string} forgeRoot
 * @returns {{ manifest: {schema:string,version:number,sources:object[]}, existed:boolean, malformed:boolean }}
 */
function readManifest(forgeRoot) {
  const abs = manifestPath(forgeRoot);
  let existed = false;
  try {
    existed = fs.statSync(abs).isFile();
  } catch {
    existed = false;
  }
  if (!existed) {
    return { manifest: emptyManifest(), existed: false, malformed: false };
  }
  const parsed = readJson(abs);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { manifest: emptyManifest(), existed: true, malformed: true };
  }
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  return {
    manifest: {
      schema: typeof parsed.schema === 'string' ? parsed.schema : SCHEMA_TAG,
      version: typeof parsed.version === 'number' ? parsed.version : SCHEMA_VERSION,
      sources,
    },
    existed: true,
    malformed: false,
  };
}

/** A fresh, empty manifest object (the initial shape). */
function emptyManifest() {
  return { schema: SCHEMA_TAG, version: SCHEMA_VERSION, sources: [] };
}

// ---------------------------------------------------------------------------
// Lockfile reads (the sync-pin contract, forge.sources.lock.v1)
// ---------------------------------------------------------------------------

/** A fresh, empty lockfile object (the initial shape). */
function emptyLock() {
  return { schema: LOCK_SCHEMA_TAG, version: LOCK_SCHEMA_VERSION, sources: [] };
}

/**
 * Read + normalize the sources lockfile (<FORGE_ROOT>/.forge/sources.lock). An
 * ABSENT or malformed file degrades to a fresh empty lock (sync may create it).
 * Fail-open: never throws. The `sources` array is taken verbatim from disk when
 * it is an array, so re-sync preserves untouched entries.
 * @param {string} forgeRoot
 * @returns {{ schema:string, version:number, sources:object[] }}
 */
function readLock(forgeRoot) {
  const parsed = readJson(lockPath(forgeRoot));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyLock();
  }
  return {
    schema: typeof parsed.schema === 'string' ? parsed.schema : LOCK_SCHEMA_TAG,
    version: typeof parsed.version === 'number' ? parsed.version : LOCK_SCHEMA_VERSION,
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
  };
}

/**
 * Return a NEW lock object with `entry` upserted by id (re-sync replaces the
 * prior pin for that id; every other id is preserved verbatim, in order, with
 * the new/updated entry appended when previously absent). Non-destructive.
 * @param {{schema:string,version:number,sources:object[]}} lock
 * @param {{id:string,url:string,ref:string,commit:string|null,syncedAt:string}} entry
 */
function upsertLockEntry(lock, entry) {
  let replaced = false;
  const sources = lock.sources.map((s) => {
    if (s && s.id === entry.id) {
      replaced = true;
      return entry;
    }
    return s;
  });
  if (!replaced) sources.push(entry);
  return { schema: LOCK_SCHEMA_TAG, version: LOCK_SCHEMA_VERSION, sources };
}

// ---------------------------------------------------------------------------
// normalize — mirrors mcp.mjs#normalize (with a --ref value-opt)
// ---------------------------------------------------------------------------

/**
 * Normalise `ctx`/`args` to { apply, ref, now, positional, flags }. The FORGE_ROOT
 * is resolved separately (this module always operates on its OWN library manifest,
 * NOT a target project — unlike mcp/memory which target a project cwd).
 */
function normalize(args, ctx) {
  const flags = new Set();
  const positional = [];
  /** @type {Record<string,string>} */
  const opts = {};
  const argList = Array.isArray(args) ? args : args && Array.isArray(args.positional) ? args.positional : [];
  const VALUE_OPTS = new Set(['ref', 'now', 'kind']);
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
  const ref = opts.ref || (ctx && ctx.opts && ctx.opts.ref) || null;
  const now = opts.now || (ctx && ctx.opts && ctx.opts.now) || DEFAULT_NOW;
  const kind = opts.kind || (ctx && ctx.opts && ctx.opts.kind) || null;
  return { apply: !!apply, ref, now, kind, positional, flags };
}

// ---------------------------------------------------------------------------
// C4 module contract: run / summarize
// ---------------------------------------------------------------------------

/**
 * C4 entry. NEVER writes stdout/stderr. Returns `{ ok, data, findings, summary }`.
 * Fail-open: any internal failure degrades to an ok-ish empty result, never a throw.
 *
 * `list` writes NOTHING. `add`/`remove`/`trust` write ONLY `manifests/sources.json`
 * and ONLY under `--apply`; the default is always a preview. `sync` writes fetched
 * bytes ONLY into the machine-local cache (~/.claude/forge-sources/<id>) and pins
 * `<FORGE_ROOT>/.forge/sources.lock`, ONLY under `--apply` (dry-run plans, writes
 * nothing). sync clones + reads ONLY — it NEVER executes fetched code.
 *
 * @param {string} subcmd list | add | remove | sync | trust
 * @param {any} args string[] | { positional, flags, opts }
 * @param {any} ctx { flags?, opts?, apply?, write? }
 * @returns {Promise<{ok:boolean, data:any, findings:import('./lib/findings.mjs').Finding[], summary:object}>}
 */
export async function run(subcmd, args, ctx) {
  try {
    const n = normalize(args, ctx);
    const forgeRoot = selfForgeRoot();
    switch (subcmd) {
      case 'list':
        return doList(forgeRoot);
      case 'add':
        return doAdd(forgeRoot, n.positional[0] || null, n.positional[1] || null, n.ref || DEFAULT_REF, n.apply, n.now, n.kind);
      case 'remove':
        return doRemove(forgeRoot, n.positional[0] || null, n.apply);
      case 'sync':
        return doSync(forgeRoot, n.positional[0] || null, n.apply, n.now, n.flags.has('now'));
      case 'trust':
        return doTrust(forgeRoot, n.positional[0] || null, n.apply);
      default:
        return result(false, { usage: usageText() }, [
          finding('ERROR', 'source', `unknown source subcommand: ${subcmd || '(none)'}`),
        ]);
    }
  } catch (e) {
    return result(false, null, [
      finding('ERROR', 'source', `source error: ${e && e.message ? e.message : String(e)}`),
    ]);
  }
}

/**
 * `list` — enumerate registered sources → data.sources[] each the full record
 * `{ id, url, ref, kind, addedAt, trust }`. Read-only, fail-open.
 */
function doList(forgeRoot) {
  const { manifest, existed, malformed } = readManifest(forgeRoot);
  const findings = [];
  if (malformed) {
    findings.push(finding('WARN', relManifest(forgeRoot), 'sources.json is not a JSON object — treating as empty'));
  } else if (!existed) {
    findings.push(finding('INFO', relManifest(forgeRoot), 'no sources manifest yet — empty source registry'));
  }
  const sources = manifest.sources.map((s) => ({
    id: s && typeof s.id === 'string' ? s.id : '',
    url: s && typeof s.url === 'string' ? s.url : '',
    ref: s && typeof s.ref === 'string' ? s.ref : '',
    kind: s && typeof s.kind === 'string' ? s.kind : '',
    addedAt: s && typeof s.addedAt === 'string' ? s.addedAt : '',
    trust: s && typeof s.trust === 'string' ? s.trust : '',
  }));
  return result(true, { manifestPath: manifestPath(forgeRoot), sources }, findings, {
    sources: sources.length,
    untrusted: sources.filter((s) => s.trust === 'untrusted').length,
  });
}

/**
 * `add <id> <url> [--ref <r>] [--apply]` — register a NEW source. Defaults: ref
 * "main", kind "git", trust "untrusted" (LOCKED). Additive: a DUPLICATE id is
 * skipped + WARN (never clobber). Default returns the plan in `data.plan { add,
 * skipped }`; --apply writes the manifest atomically (creating it when absent,
 * preserving all existing sources verbatim).
 */
function doAdd(forgeRoot, id, url, ref, apply, now, kind) {
  const findings = [];
  if (!id || !url) {
    return result(false, { usage: usageText() }, [
      finding('ERROR', 'source', 'add requires <id> and <url> arguments'),
    ]);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    return result(false, { id, plan: { add: [], skipped: [] } }, [
      finding('ERROR', 'source', `invalid source id '${id}' (must match ^[a-z0-9][a-z0-9._-]*$)`),
    ]);
  }
  // SECURITY (Critical #1): a '-'-leading ref is an argv-injection vector for the
  // sync clone/fetch — reject it here so it can never be persisted. (The url is
  // validated below, but ONLY for git kind — a local source is a filesystem path,
  // not a git transport.)
  const refReason = refRejectReason(ref);
  if (refReason) {
    return result(false, { id, plan: { add: [], skipped: [] } }, [
      finding('ERROR', 'source', `invalid ref: ${refReason}`),
    ]);
  }
  const { manifest, malformed } = readManifest(forgeRoot);
  if (malformed) {
    return result(false, { id, plan: { add: [], skipped: [] } }, [
      finding('ERROR', relManifest(forgeRoot), 'sources.json is not a JSON object — refusing to edit'),
    ]);
  }
  const exists = manifest.sources.some((s) => s && s.id === id);
  if (exists) {
    findings.push(finding('WARN', relManifest(forgeRoot), `source id "${id}" already present — skipped (never clobber)`));
    return result(true, {
      id,
      manifestPath: manifestPath(forgeRoot),
      applied: !!apply,
      written: false,
      plan: { add: [], skipped: [{ id, reason: 'already present in sources (additive: never clobber)' }] },
    }, findings, { add: 0, skipped: 1, written: 0 });
  }

  // Resolve kind: explicit --kind wins; else auto-detect — an existing local
  // directory => 'local' (read directly), anything else => 'git' (clone to cache).
  let resolvedKind = kind ? String(kind).toLowerCase() : '';
  if (resolvedKind && resolvedKind !== 'git' && resolvedKind !== 'local') {
    return result(false, { id, plan: { add: [], skipped: [] } }, [
      finding('ERROR', 'source', `invalid --kind '${kind}' (must be 'git' or 'local')`),
    ]);
  }
  if (!resolvedKind) {
    let isLocalDir = false;
    try { isLocalDir = fs.statSync(path.resolve(url)).isDirectory(); } catch { isLocalDir = false; }
    resolvedKind = isLocalDir ? 'local' : 'git';
  }

  // SECURITY (Critical #1): for a GIT source the url is handed to `git clone` as a
  // transport. ALLOWLIST the scheme (https/http/git/ssh/file:// + scp-like
  // git@host:path) and REJECT every transport-helper form (ext::/fd::/<helper>::)
  // and any '-'-leading value. A LOCAL source is a filesystem path read directly,
  // never a git transport, so it is exempt from the transport allowlist.
  if (resolvedKind === 'git') {
    const urlReason = urlRejectReason(url);
    if (urlReason) {
      return result(false, { id, plan: { add: [], skipped: [] } }, [
        finding('ERROR', 'source', `refusing to register source "${id}": ${urlReason}`),
      ]);
    }
  }

  const record = { id, url, ref: ref || DEFAULT_REF, kind: resolvedKind, addedAt: now, trust: DEFAULT_TRUST };
  findings.push(finding('INFO', 'source', `source "${id}" registered (kind=${resolvedKind}, trust="${DEFAULT_TRUST}") — ${resolvedKind === 'local' ? 'read directly from its path' : 'sync clones+reads only'}; resources stay inert until \`forge catalog admit\``));

  let written = false;
  if (apply) {
    const next = { ...manifest, sources: [...manifest.sources, record] };
    written = writeJsonAtomic(manifestPath(forgeRoot), next);
    if (!written) findings.push(finding('WARN', relManifest(forgeRoot), 'could not write sources.json'));
  }

  return result(true, {
    id,
    manifestPath: manifestPath(forgeRoot),
    applied: !!apply,
    written,
    record,
    plan: { add: [record], skipped: [] },
  }, findings, { add: 1, skipped: 0, written: written ? 1 : 0 });
}

/**
 * `remove <id> [--apply]` — drop a source by id. Absent id ⇒ WARN (nothing to do).
 * Default returns the plan in `data.plan { remove, missing }`; --apply writes the
 * manifest atomically, preserving every other source verbatim.
 */
function doRemove(forgeRoot, id, apply) {
  const findings = [];
  if (!id) {
    return result(false, { usage: usageText() }, [finding('ERROR', 'source', 'remove requires an <id> argument')]);
  }
  const { manifest, existed, malformed } = readManifest(forgeRoot);
  if (malformed) {
    return result(false, { id, plan: { remove: [], missing: [] } }, [
      finding('ERROR', relManifest(forgeRoot), 'sources.json is not a JSON object — refusing to edit'),
    ]);
  }
  const exists = manifest.sources.some((s) => s && s.id === id);
  if (!exists) {
    findings.push(finding('WARN', relManifest(forgeRoot), `source id "${id}" not present — nothing to remove`));
    if (!existed) findings.push(finding('INFO', relManifest(forgeRoot), 'no sources manifest yet — nothing to remove'));
    return result(true, {
      id,
      manifestPath: manifestPath(forgeRoot),
      applied: !!apply,
      written: false,
      plan: { remove: [], missing: [id] },
    }, findings, { remove: 0, missing: 1, written: 0 });
  }

  let written = false;
  if (apply) {
    const next = { ...manifest, sources: manifest.sources.filter((s) => !(s && s.id === id)) };
    written = writeJsonAtomic(manifestPath(forgeRoot), next);
    if (!written) findings.push(finding('WARN', relManifest(forgeRoot), 'could not write sources.json'));
  }

  return result(true, {
    id,
    manifestPath: manifestPath(forgeRoot),
    applied: !!apply,
    written,
    plan: { remove: [id], missing: [] },
  }, findings, { remove: 1, missing: 0, written: written ? 1 : 0 });
}

// ---------------------------------------------------------------------------
// sync — the acquisition verb (shallow-clone + pin; clone+read ONLY)
// ---------------------------------------------------------------------------

/**
 * Run a git subcommand via spawnSync. This SPAWNS the trusted system `git`
 * binary (acquisition only — NOT a module import; the zero-dep invariant covers
 * imports). It NEVER runs the fetched repo's own hooks/scripts. shell:false so
 * args are never interpreted; we pass the URL/ref as discrete argv tokens.
 *
 * Fail-open: a missing git binary or any spawn error degrades to a non-zero
 * synthetic result rather than throwing.
 * @param {string[]} gitArgs argv passed to `git` (no shell).
 * @returns {{ status:number|null, stdout:string, stderr:string, error?:Error }}
 */
function runGit(gitArgs) {
  const env = {
    ...process.env,
    // Harden the spawned git: NEVER prompt (no interactive auth that could hang),
    // and disable any global/system hook path injection. We additionally disable
    // local hook execution at clone time via core.hooksPath=/dev/null below.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'true',
    // SECURITY (Critical #1 — sync RCE defence in depth): refuse to treat a
    // user-supplied value as enabling a "from user" protocol. With this set, git
    // applies protocol.allow=user as the policy for transports that arrived from
    // the user/config, so non-`user`-class transports (notably the ext:: / fd::
    // transport-helpers that can execute a shell command) are blocked at the
    // transport layer regardless of the per-`-c` flags below.
    GIT_PROTOCOL_FROM_USER: '0',
  };
  try {
    const r = spawnSync('git', gitArgs, {
      encoding: 'utf8',
      shell: false,
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    if (r.error) {
      return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
    }
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { status: 1, stdout: '', stderr: '', error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** First non-empty trimmed line of `s` (the resolved sha from rev-parse). */
function firstLine(s) {
  return String(s || '').split(/\r?\n/).map((x) => x.trim()).find((x) => x.length > 0) || '';
}

/**
 * Build the per-target plan rows for `sync` (the dry-run plan AND the apply
 * input). A git source plans a shallow clone; a local source plans a path
 * verification (NO clone). Each row carries the exact cache target.
 */
function planSyncTargets(manifest, id) {
  const chosen = id ? manifest.sources.filter((s) => s && s.id === id) : manifest.sources;
  return chosen.map((s) => {
    const sid = s && typeof s.id === 'string' ? s.id : '';
    const kind = s && typeof s.kind === 'string' ? s.kind : DEFAULT_KIND;
    const isLocal = kind === 'local';
    return {
      id: sid,
      url: s && typeof s.url === 'string' ? s.url : '',
      ref: s && typeof s.ref === 'string' ? s.ref : DEFAULT_REF,
      kind,
      // git: clone into the machine-local cache; local: verify the recorded path.
      action: isLocal ? 'verify' : 'clone',
      cacheDir: isLocal ? null : cacheDirDisplay(sid),
      localPath: isLocal ? (s && typeof s.url === 'string' ? s.url : '') : null,
    };
  });
}

/**
 * `sync [id] [--apply]` — acquire registered source(s) into the machine-local
 * cache and PIN the resolved commit in <FORGE_ROOT>/.forge/sources.lock.
 *
 * SECURITY (non-negotiable, ADR-0017 §security): sync CLONES + READS ONLY. It
 * NEVER runs the fetched repo's hooks/scripts/postinstall, never `npm`/builds,
 * and never recurses submodules. The clone is EXACTLY:
 *   git clone --depth 1 --no-recurse-submodules --branch <ref> <url> <cacheDir>
 * then the commit is resolved with `git -C <cacheDir> rev-parse HEAD`. Synced
 * bytes stay INERT in the catalog until `forge catalog admit`.
 *
 * Dry-run (default) prints the plan (what would clone/verify/lock) and writes
 * NOTHING. `--apply` performs the clones, refreshes existing clones to the ref
 * tip on re-sync, and writes the lockfile atomically. For kind 'local' there is
 * NO clone: the recorded path is verified to exist and pinned with commit:null.
 *
 * Fail-open per source: one source's failure becomes a finding; the rest
 * continue. The verb itself never throws past its surface.
 *
 * @param {string} forgeRoot
 * @param {string|null} id Optional single source to sync (else all).
 * @param {boolean} apply When true, perform side effects; else dry-run.
 * @param {string} now Timestamp for `syncedAt` (from --now, else DEFAULT_NOW).
 * @param {boolean} nowExplicit True when --now was passed; else use the wall clock on apply.
 */
function doSync(forgeRoot, id, apply, now, nowExplicit) {
  const { manifest, existed, malformed } = readManifest(forgeRoot);
  const findings = [];

  // Always-present security banner so the contract is visible on every run.
  findings.push(finding('INFO', 'source', 'sync clones + reads ONLY — NEVER runs fetched hooks/scripts/postinstall/npm/build, NEVER recurses submodules (ADR-0017 §security); synced resources stay inert until `forge catalog admit`'));

  if (malformed) {
    findings.push(finding('ERROR', relManifest(forgeRoot), 'sources.json is not a JSON object — cannot sync'));
    return result(false, {
      planned: !apply,
      applied: !!apply,
      id: id || null,
      cacheRoot: cacheRoot(),
      lockfile: lockPath(forgeRoot),
      lockfileSchema: LOCK_SCHEMA_TAG,
      targets: [],
      results: [],
    }, findings, { targets: 0, synced: 0, failed: 0, locked: 0 });
  }

  if (!existed) {
    findings.push(finding('INFO', relManifest(forgeRoot), 'no sources manifest yet — empty source registry, nothing to sync'));
  }

  const targets = planSyncTargets(manifest, id);
  if (id && targets.length === 0) {
    findings.push(finding('WARN', 'source', `no registered source with id "${id}"`));
  }

  // The resolved real-time stamp for THIS sync run (apply only). We honour an
  // explicit --now (deterministic tests); otherwise use the wall clock so the
  // pin is meaningful. Dry-run never stamps anything.
  const syncedAt = nowExplicit ? now : new Date().toISOString();

  // -------------------------- DRY-RUN: plan only ---------------------------
  if (!apply) {
    findings.push(finding('INFO', 'source', `dry-run: would sync ${targets.length} source(s) into ${cacheRoot()} and pin ${relLock(forgeRoot)} — pass --apply to execute`));
    return result(true, {
      planned: true,
      applied: false,
      id: id || null,
      cacheRoot: cacheRoot(),
      lockfile: lockPath(forgeRoot),
      lockfileSchema: LOCK_SCHEMA_TAG,
      targets,
      results: [],
    }, findings, { targets: targets.length, synced: 0, failed: 0, locked: 0 });
  }

  // ----------------------------- APPLY: execute ----------------------------
  let lock = readLock(forgeRoot);
  const results = [];
  let synced = 0;
  let failed = 0;
  let locked = 0;

  for (const t of targets) {
    if (!t.id) {
      failed++;
      findings.push(finding('WARN', 'source', 'skipping a source with no id'));
      results.push({ id: t.id, ok: false, reason: 'missing id' });
      continue;
    }
    const r = syncOne(forgeRoot, t, syncedAt, findings);
    results.push(r);
    if (r.ok) {
      synced++;
      lock = upsertLockEntry(lock, r.entry);
    } else {
      failed++;
    }
  }

  // Write the lockfile ONCE, atomically, only if at least one pin changed.
  let lockWritten = false;
  if (synced > 0) {
    lockWritten = writeJsonAtomic(lockPath(forgeRoot), lock);
    if (lockWritten) {
      locked = synced;
      findings.push(finding('INFO', relLock(forgeRoot), `pinned ${synced} source(s) in the lockfile (${LOCK_SCHEMA_TAG})`));
    } else {
      findings.push(finding('ERROR', relLock(forgeRoot), 'could not write .forge/sources.lock — pins NOT persisted'));
    }
  }

  // ok is true only when every chosen target synced AND (if any synced) the
  // lockfile was actually written.
  const ok = failed === 0 && (synced === 0 || lockWritten);
  return result(ok, {
    planned: false,
    applied: true,
    id: id || null,
    cacheRoot: cacheRoot(),
    lockfile: lockPath(forgeRoot),
    lockfileSchema: LOCK_SCHEMA_TAG,
    lockWritten,
    targets,
    results,
  }, findings, { targets: targets.length, synced, failed, locked });
}

/**
 * Acquire ONE source into its cache dir + return its lock entry. git sources are
 * shallow-cloned with the EXACT locked flags; a re-sync refreshes the existing
 * clone to the ref tip (fetch + hard reset) rather than re-cloning. local
 * sources are NOT cloned — the recorded path is verified and pinned commit:null.
 * Fail-open: any failure returns `{ ok:false }` + a finding; never throws.
 *
 * @param {string} forgeRoot
 * @param {{id:string,url:string,ref:string,kind:string,action:string,localPath:string|null}} t
 * @param {string} syncedAt
 * @param {import('./lib/findings.mjs').Finding[]} findings
 * @returns {{ id:string, ok:boolean, reason?:string, entry?:object, commit?:string|null, cacheDir?:string }}
 */
function syncOne(forgeRoot, t, syncedAt, findings) {
  // ---- kind 'local': verify path, NO clone -------------------------------
  if (t.kind === 'local') {
    const p = t.localPath || t.url || '';
    let exists = false;
    try {
      exists = !!p && fs.existsSync(p);
    } catch {
      exists = false;
    }
    if (!exists) {
      findings.push(finding('WARN', 'source', `local source "${t.id}": recorded path does not exist: ${p || '(empty)'}`));
      return { id: t.id, ok: false, reason: 'local path missing' };
    }
    findings.push(finding('INFO', 'source', `local source "${t.id}": verified path ${p} (no clone) — pinned commit:null`));
    return {
      id: t.id,
      ok: true,
      commit: null,
      cacheDir: p,
      entry: { id: t.id, url: t.url, ref: t.ref, commit: null, syncedAt },
    };
  }

  // ---- kind 'git': shallow clone (clone + read ONLY) ---------------------
  if (!t.url) {
    findings.push(finding('WARN', 'source', `git source "${t.id}": no url — cannot clone`));
    return { id: t.id, ok: false, reason: 'missing url' };
  }
  const dir = cacheDirFor(t.id);

  // Re-sync: if the cache dir already holds a clone, refresh it to the ref tip
  // (fetch the single ref shallowly, then hard-reset) instead of re-cloning.
  let isExistingRepo = false;
  try {
    isExistingRepo = fs.statSync(path.join(dir, '.git')).isDirectory();
  } catch {
    isExistingRepo = false;
  }

  if (isExistingRepo) {
    // Refresh in place. -c core.hooksPath=/dev/null neutralises any fetched
    // repo hooks; we run NO checkout hooks and NO submodule recursion. The
    // protocol-hardening `-c` flags block ext:: et al on the network fetch, and
    // a `--` separator ends option parsing before the positional <remote> <ref>.
    const fetched = runGit([
      '-C', dir,
      '-c', 'core.hooksPath=/dev/null',
      ...GIT_PROTOCOL_HARDENING,
      'fetch', '--depth', '1', '--no-recurse-submodules', '--', 'origin', t.ref,
    ]);
    if (fetched.status !== 0) {
      findings.push(finding('WARN', 'source', `git source "${t.id}": re-sync fetch failed (${firstLine(fetched.stderr) || fetched.error && fetched.error.message || 'git fetch error'})`));
      return { id: t.id, ok: false, reason: 'fetch failed' };
    }
    const reset = runGit(['-C', dir, '-c', 'core.hooksPath=/dev/null', 'reset', '--hard', 'FETCH_HEAD']);
    if (reset.status !== 0) {
      findings.push(finding('WARN', 'source', `git source "${t.id}": re-sync reset failed (${firstLine(reset.stderr) || 'git reset error'})`));
      return { id: t.id, ok: false, reason: 'reset failed' };
    }
  } else {
    // Fresh clone. Remove any stale (non-repo) dir first, best-effort.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore — clone will surface a real error if the dir is unusable */
    }
    try {
      fs.mkdirSync(cacheRoot(), { recursive: true });
    } catch {
      /* ignore — clone will surface the real error */
    }
    // EXACT locked clone command + a hooks-path neutraliser (defence in depth) +
    // the protocol-hardening `-c` flags (block ext:: et al). A `--` separator
    // ends option parsing so a hostile <url>/<dir> can never be read as a flag.
    const cloned = runGit([
      '-c', 'core.hooksPath=/dev/null',
      ...GIT_PROTOCOL_HARDENING,
      'clone', '--depth', '1', '--no-recurse-submodules', '--branch', t.ref,
      '--', t.url, dir,
    ]);
    if (cloned.status !== 0) {
      findings.push(finding('WARN', 'source', `git source "${t.id}": clone failed (${firstLine(cloned.stderr) || cloned.error && cloned.error.message || 'git clone error'})`));
      return { id: t.id, ok: false, reason: 'clone failed' };
    }
  }

  // Resolve the exact synced commit (read-only).
  const rev = runGit(['-C', dir, 'rev-parse', 'HEAD']);
  const commit = firstLine(rev.stdout);
  if (rev.status !== 0 || !commit) {
    findings.push(finding('WARN', 'source', `git source "${t.id}": cloned but could not resolve HEAD (${firstLine(rev.stderr) || 'rev-parse error'})`));
    return { id: t.id, ok: false, reason: 'rev-parse failed' };
  }

  findings.push(finding('INFO', 'source', `git source "${t.id}": ${isExistingRepo ? 'refreshed' : 'cloned'} ${t.ref}@${commit.slice(0, 12)} into ${cacheDirDisplay(t.id)} (clone+read only)`));
  return {
    id: t.id,
    ok: true,
    commit,
    cacheDir: dir,
    entry: { id: t.id, url: t.url, ref: t.ref, commit, syncedAt },
  };
}

// ---------------------------------------------------------------------------
// trust — the security-gated trust flip (untrusted → reviewed)
// ---------------------------------------------------------------------------

/**
 * `trust <id> [--apply]` — flip a source's trust to "reviewed" in
 * manifests/sources.json. A deliberate HUMAN action: it relaxes the admission
 * gate for that source (TRUST GATES ADMISSION — only trusted/reviewed sources
 * may have their resources admitted into the active library; untrusted stay
 * catalog-only). Dry-run (default) shows the diff and writes NOTHING; --apply
 * writes the manifest atomically via the same store used by add/remove.
 * Additive-safe: an absent id is a WARN; an already-reviewed id is a no-op.
 * Fail-open.
 *
 * @param {string} forgeRoot
 * @param {string|null} id
 * @param {boolean} apply
 */
function doTrust(forgeRoot, id, apply) {
  const findings = [];
  if (!id) {
    return result(false, { usage: usageText() }, [finding('ERROR', 'source', 'trust requires an <id> argument')]);
  }

  const { manifest, existed, malformed } = readManifest(forgeRoot);
  if (malformed) {
    return result(false, {
      id, applied: !!apply, written: false,
      diff: { from: null, to: TRUST_REVIEWED }, plan: { trust: [], missing: [] },
    }, [finding('ERROR', relManifest(forgeRoot), 'sources.json is not a JSON object — refusing to edit')]);
  }

  const idx = manifest.sources.findIndex((s) => s && s.id === id);
  if (idx === -1) {
    findings.push(finding('WARN', relManifest(forgeRoot), `source id "${id}" not present — nothing to trust`));
    if (!existed) findings.push(finding('INFO', relManifest(forgeRoot), 'no sources manifest yet — nothing to trust'));
    return result(true, {
      id,
      manifestPath: manifestPath(forgeRoot),
      applied: !!apply,
      written: false,
      diff: { from: null, to: TRUST_REVIEWED },
      plan: { trust: [], missing: [id] },
    }, findings, { trust: 0, missing: 1, written: 0 });
  }

  const current = manifest.sources[idx];
  const from = current && typeof current.trust === 'string' ? current.trust : DEFAULT_TRUST;

  // TRUST GATES ADMISSION — surfaced on every trust run.
  findings.push(finding('INFO', 'source', `trust gates admission: flipping "${id}" to "${TRUST_REVIEWED}" relaxes the admission gate (only trusted/reviewed sources may be admitted into the active library; untrusted stay catalog-only) — a deliberate human review (ADR-0017 §security)`));

  if (from === TRUST_REVIEWED) {
    findings.push(finding('INFO', relManifest(forgeRoot), `source "${id}" is already trust="${TRUST_REVIEWED}" — no change`));
    return result(true, {
      id,
      manifestPath: manifestPath(forgeRoot),
      applied: !!apply,
      written: false,
      diff: { from, to: TRUST_REVIEWED },
      plan: { trust: [], missing: [] },
    }, findings, { trust: 0, missing: 0, written: 0 });
  }

  findings.push(finding('INFO', 'source', `diff: ${id} trust "${from}" -> "${TRUST_REVIEWED}"`));

  let written = false;
  if (apply) {
    const nextSources = manifest.sources.map((s, i) => (i === idx ? { ...s, trust: TRUST_REVIEWED } : s));
    const next = { ...manifest, sources: nextSources };
    written = writeJsonAtomic(manifestPath(forgeRoot), next);
    if (!written) findings.push(finding('WARN', relManifest(forgeRoot), 'could not write sources.json'));
  } else {
    findings.push(finding('INFO', relManifest(forgeRoot), 'dry-run: pass --apply to write the trust flip'));
  }

  return result(true, {
    id,
    manifestPath: manifestPath(forgeRoot),
    applied: !!apply,
    written,
    diff: { from, to: TRUST_REVIEWED },
    plan: { trust: [id], missing: [] },
  }, findings, { trust: 1, missing: 0, written: written ? 1 : 0 });
}

/**
 * C4 `summarize(state)` — pure; map a run-state to a one-panel summary. Returns a
 * `(no data)` panel when no sources array is present (fail-open).
 * @param {any} state @returns {{panel:string, ok:boolean, lines:string[], hint?:string}}
 */
export function summarize(state) {
  const sources = state && typeof state === 'object' && Array.isArray(state.sources) ? state.sources : null;
  if (!sources) {
    return makePanel({ panel: 'source', ok: false, lines: ['(no data)'], hint: 'forge source list' });
  }
  const untrusted = sources.filter((s) => s && s.trust === 'untrusted').length;
  return makePanel({
    panel: 'source',
    ok: true,
    lines: [`${sources.length} source${sources.length === 1 ? '' : 's'}`, `${untrusted} untrusted`],
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
    'forge source list',
    'forge source add <id> <url> [--ref <r>] [--apply]',
    'forge source remove <id> [--apply]',
    'forge source sync [id] [--apply]   (clone+read only; pins .forge/sources.lock)',
    'forge source trust <id> [--apply]  (untrusted -> reviewed; trust gates admission)',
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
    if (sources.length === 0) out.push('source: no registered sources');
    for (const s of sources) {
      out.push(`${s.id}\t${s.kind}\t${s.ref}\t[${s.trust}]\t${s.url}`);
    }
  } else if (subcmd === 'add') {
    const plan = data.plan || { add: [], skipped: [] };
    out.push(`source add ${data.id}: ${plan.add.length} to add, ${plan.skipped.length} skipped${data.applied ? `, ${data.written ? 'written' : 'not written'}` : ' (preview — pass --apply)'}`);
    for (const a of plan.add) out.push(`  + ${a.id}\t${a.url}\t(ref ${a.ref}, ${a.trust})`);
    for (const s of plan.skipped) out.push(`  - ${s.id}\t(skip: ${s.reason})`);
  } else if (subcmd === 'remove') {
    const plan = data.plan || { remove: [], missing: [] };
    out.push(`source remove ${data.id}: ${plan.remove.length} to remove, ${plan.missing.length} missing${data.applied ? `, ${data.written ? 'written' : 'not written'}` : ' (preview — pass --apply)'}`);
    for (const r of plan.remove) out.push(`  - ${r}`);
    for (const m of plan.missing) out.push(`  ? ${m}\t(not present)`);
  } else if (subcmd === 'sync') {
    const targets = data.targets || [];
    const results = data.results || [];
    if (data.applied) {
      const sum = res.summary || {};
      out.push(`source sync: ${sum.synced || 0}/${targets.length} synced, ${sum.failed || 0} failed, ${sum.locked || 0} pinned${data.lockWritten ? ` -> ${data.lockfile}` : ''} (clone+read only)`);
      for (const r of results) {
        if (r.ok) out.push(`  ~ ${r.id}\t${r.commit ? r.commit.slice(0, 12) : '(local)'}\t-> ${r.cacheDir}`);
        else out.push(`  x ${r.id}\t(${r.reason || 'failed'})`);
      }
    } else {
      out.push(`source sync: ${targets.length} target(s) (dry-run — pass --apply) — clones+reads only, never executes fetched code`);
      for (const t of targets) {
        out.push(t.action === 'verify'
          ? `  ? ${t.id}\t(verify local path ${t.localPath || ''})`
          : `  ~ ${t.id}\t-> ${t.cacheDir}\t(clone ${t.ref})`);
      }
    }
  } else if (subcmd === 'trust') {
    const d = data.diff || { from: null, to: 'reviewed' };
    const plan = data.plan || { trust: [], missing: [] };
    if (plan.missing && plan.missing.length) {
      out.push(`source trust ${data.id || ''}: not present (nothing to trust)`);
    } else {
      out.push(`source trust ${data.id || ''}: ${d.from || '(unknown)'} -> ${d.to}${data.applied ? `, ${data.written ? 'written' : 'not written'}` : ' (preview — pass --apply)'} — trust gates admission`);
    }
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
//   node manager/source.mjs <subcmd> [flags] [id] [url]
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
          command: `source ${subcmd || ''}`.trim(),
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
