// @ts-check
/**
 * store — the manager's storage SEAM (SPEC-00 §"Shared foundation", SPEC-09).
 *
 * The single module the whole manager routes state reads/writes through. No
 * manager module ever touches `fs` for state directly; it asks the store, and
 * the store guarantees the two HARD invariants this seam exists to enforce:
 *
 *   - Atomicity   — snapshots land via temp-write + `fs.renameSync`, so a crash
 *                   mid-write leaves the PRIOR file intact (BR-INT-005,
 *                   EVAL-INT-006). Never a half-written JSON.
 *   - Fail-open   — every public entry degrades to a safe value (null / [] /
 *                   false) on any IO or parse error; nothing throws past this
 *                   module's surface (BR-INT-003, EVAL-INT-002).
 *
 * Two physical roots, never mixed (SPEC-09 §"Canonical on-disk layout",
 * ADR-0003): `forgeStateDir()` is the git-tracked truth under FORGE_ROOT;
 * `machineStateHome()` is the machine-local cache under ~/.claude/forge.
 * Every write a caller issues MUST resolve under one of these two roots — the
 * store does not police that here, but the root resolvers are the only blessed
 * way to get a base path.
 *
 * Zero runtime dependencies: only `node:` builtins. Mirrors the style of
 * `bin/forge.mjs` (`readJson`, `writeJsonFile`, `resolveClaudeHome`).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Snapshot reads/writes (atomic temp-rename)
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file. Fail-open: any IO or parse error yields `null`,
 * never a throw. Mirrors `bin/forge.mjs#readJson`.
 *
 * @param {string} absPath Absolute path to the JSON file.
 * @returns {any} The parsed object/value, or `null` if missing/unreadable/malformed.
 */
export function readJson(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write `obj` as 2-space-indented JSON (trailing newline) ATOMICALLY: serialize
 * to a unique temp sibling, then `fs.renameSync` it into place (an atomic op on
 * the same filesystem). Parent dirs are created as needed. On ANY error the
 * prior file (if any) is left intact, the temp file is cleaned up best-effort,
 * and `false` is returned; on success returns `true`. Never throws (fail-open).
 *
 * The temp file is a sibling (same dir ⇒ same filesystem) so the rename is a
 * true atomic replace rather than a cross-device copy.
 *
 * @param {string} absPath Absolute destination path.
 * @param {any} obj JSON-serializable value to persist.
 * @returns {boolean} `true` if the file was atomically replaced, else `false`.
 */
export function writeJsonAtomic(absPath, obj) {
  const dir = path.dirname(absPath);
  const tmp = path.join(
    dir,
    `.${path.basename(absPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, absPath);
    return true;
  } catch {
    // Leave any prior file intact; clean up the orphaned temp best-effort.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Append-only logs (advisory-lock, lossy-by-design JSONL)
// ---------------------------------------------------------------------------

/**
 * Append one JSON line for `obj` to a JSONL file, guarded by an advisory lock.
 *
 * The lock is a sibling file (`absPath + '.lock'`) created with the exclusive
 * `wx` flag: if it ALREADY exists, another writer holds it, so this append is
 * DROPPED and `false` is returned — lossy-by-design (BR-INT-005, EVAL-INT-006).
 * It never blocks, never spins, never throws. On acquisition the line is
 * appended and the lock is ALWAYS released in `finally`. Parent dirs are
 * created as needed. Any unexpected IO error fails-open to `false`.
 *
 * Lossy is intentional: telemetry/log lines are observation, not authoritative
 * state (SPEC-09) — dropping a contended line is preferable to blocking a hook
 * or corrupting the log.
 *
 * @param {string} absPath Absolute path to the JSONL file.
 * @param {any} obj JSON-serializable record to append as one line.
 * @returns {boolean} `true` if the line was appended, `false` if dropped/failed.
 */
export function appendJsonl(absPath, obj) {
  const lockPath = absPath + '.lock';
  let fd;
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    // Acquire: exclusive-create the lock. EEXIST ⇒ contended ⇒ drop.
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch {
      return false; // lock held (or unwritable) — drop, never block.
    }
    fs.appendFileSync(absPath, JSON.stringify(obj) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    // Release the lock regardless of outcome; best-effort, never throws.
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read a JSONL file into an array of parsed records. Fail-open at every level:
 * a missing/unreadable file yields `[]`; an individual malformed (or blank)
 * line is SKIPPED rather than aborting the read. Never throws.
 *
 * @param {string} absPath Absolute path to the JSONL file.
 * @returns {any[]} Parsed records in file order (malformed lines omitted).
 */
export function readJsonl(absPath) {
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed line — fail-open, never abort the whole read.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Root resolution (the two physical roots — ADR-0003, SPEC-09)
// ---------------------------------------------------------------------------

/**
 * The GIT-TRACKED state root: `<forgeRoot>/.forge`. Holds the harness's
 * reviewable identity — `registry.json`, `registry.log.jsonl`, eval baselines
 * and cases (SPEC-09). Pure path join; does not create the directory.
 *
 * @param {string} forgeRoot Absolute FORGE_ROOT (the forge library root).
 * @returns {string} Absolute path to the git-tracked `.forge` state dir.
 */
export function forgeStateDir(forgeRoot) {
  return path.join(forgeRoot, '.forge');
}

/**
 * The MACHINE-LOCAL state root: `<claudeDir>/forge` (e.g. `~/.claude/forge`).
 * Holds private, never-committed cache/observation — `fleet.json`,
 * `telemetry/`, `eval-runs/`, `analyze/` (SPEC-09). Resolved the same way as
 * `bin/forge.mjs#resolveClaudeHome` (`$HOME`/`$USERPROFILE`, sandbox-friendly,
 * falling back to `os.homedir()`), then suffixed with `forge`. Kept physically
 * outside any git work tree so machine-local data cannot be committed (C6).
 * Pure path join; does not create the directory.
 *
 * @returns {string} Absolute path to the machine-local forge state dir.
 */
export function machineStateHome() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
  return path.join(home, '.claude', 'forge');
}

/**
 * The GLOBAL CONFIG root for the manager's machine-level FEDERATION state
 * (ADR-0023): `$FORGE_HOME` if set, else `<home>/.forge`. Holds the GLOBAL
 * federation state that must persist INDEPENDENTLY of any `cli/` library
 * checkout — the sources manifest (`manifests/sources.json`), the sync lockfile
 * (`.forge/sources.lock`), the admitted manifest (`manifests/admitted.json`),
 * and the catalog verdict sidecar (`.forge/catalog-verdicts.json`).
 *
 * DISTINCT from the two on-disk roots in this module: it is NOT the FORGE_ROOT
 * library install (`forgeStateDir()`, which holds the reviewable CORE resources
 * + registry) and NOT the `~/.claude/forge` machine cache (`machineStateHome()`,
 * which holds fleet/telemetry/eval-runs). It is also distinct from the source
 * byte CACHE at `~/.claude/forge-sources/<id>` (machine-local synced bytes).
 *
 * Resolved the same sandbox-friendly way as `machineStateHome()`
 * (`$HOME`/`$USERPROFILE`, falling back to `os.homedir()`), but env-overridable
 * via `$FORGE_HOME` (resolved to an absolute path). Pure path join; does not
 * create the directory.
 *
 * @returns {string} Absolute path to the global config root.
 */
export function forgeHome() {
  const envVar = process.env.FORGE_HOME;
  if (envVar) return path.resolve(envVar);
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
  return path.join(home, '.forge');
}

// ---------------------------------------------------------------------------
// Schema stamping
// ---------------------------------------------------------------------------

/**
 * Return a SHALLOW clone of `obj` with its top-level `schemaVersion` set to
 * `version` (SPEC-09 §"Rules": every persisted file carries `schemaVersion`).
 * Non-destructive: the input object is never mutated. A non-object input is
 * returned unchanged (fail-open).
 *
 * @template T
 * @param {T} obj The record to stamp.
 * @param {string} version The schema version tag (e.g. `"forge.registry.v1"`).
 * @returns {T} A shallow clone carrying `schemaVersion`, or `obj` if not an object.
 */
export function stampSchemaVersion(obj, version) {
  if (obj === null || typeof obj !== 'object') return obj;
  return { ...obj, schemaVersion: version };
}
