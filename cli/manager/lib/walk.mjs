// @ts-check
/**
 * walk — deterministic library traversal: the registry's scan surface (SPEC-00 §lib,
 * SPEC-01 "Scan surface", BR-REG-003, BR-REG-006).
 *
 * `walkLibrary(rootDir)` enumerates every file under the harness's known asset and
 * tooling directories and returns a stable, sorted list of `{ absPath, relPath }`.
 * The scan surface (relative to `rootDir`) is:
 *
 *   agents/      skills/      commands/     rules/      bundles/   — content artifacts
 *   mcp/         — MCP server config snippets (mcp/<name>.json; JSON, NOT markdown)
 *   lint/        — validators (validate-*.mjs / check-*.mjs and siblings)
 *   tests/meta/  — behavioral meta-tests
 *   bootstrap/   — engine scripts (templates/ included; resolve-kind filters by kind)
 *
 * `agents/`, `skills/`, `commands/`, `rules/`, `bundles/`, `lint/`, `tests/meta/` and
 * `bootstrap/` are each walked recursively. Hooks are intentionally NOT walked here —
 * they are declared in `hooks/hooks.json`, resolved by `resolve-kind.mjs` (SPEC-01).
 *
 * This is a PURE traversal. It does no classification: mapping a path to a
 * `{ kind, id }` is `resolve-kind.mjs`'s job. `walk` only answers "which files exist
 * under the scan surface", deterministically.
 *
 * Invariants:
 *   - Deterministic: results sorted by `relPath` with forward slashes, so two walks of
 *     an unchanged tree are byte-identical (BR-REG-006).
 *   - Noise-free: `node_modules`, `.git`, `.claude`, `.forge` directories are skipped
 *     at any depth.
 *   - Fail-open: an unreadable directory or stat is silently skipped; the walk never
 *     throws past `walkLibrary` (BR-INT-003, BR-REG-010).
 *
 * Conventions: Node ESM, ZERO dependencies (node: builtins only).
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Top-level scan-surface directories, relative to `rootDir`, each walked recursively.
 * `tests/meta` is a nested entry; the rest are top-level dirs. Order here is
 * irrelevant — the final result is sorted by `relPath`.
 * @type {string[]}
 */
const SCAN_DIRS = [
  'agents',
  'skills',
  'commands',
  'rules',
  'bundles',
  'workflows',
  'mcp',
  'lint',
  path.join('tests', 'meta'),
  'bootstrap',
];

/**
 * Directory basenames pruned wherever they appear in the tree.
 * @type {Set<string>}
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.forge']);

/**
 * Normalise a path to POSIX-style forward slashes for stable, OS-independent
 * `relPath` values and deterministic sorting.
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Recursively collect file absolute paths under `dir`, pruning {@link SKIP_DIRS}.
 * Fail-open: an unreadable directory or a failing stat is skipped, never thrown.
 * @param {string} dir Absolute directory path.
 * @param {string[]} out Accumulator of absolute file paths (mutated).
 * @returns {void}
 */
function collect(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable / missing dir — fail-open
  }
  for (const ent of entries) {
    const name = ent.name;
    const full = path.join(dir, name);
    let isDir = false;
    let isFile = false;
    try {
      // Resolve symlinks via stat so linked files/dirs are classified correctly.
      if (ent.isSymbolicLink()) {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } else {
        isDir = ent.isDirectory();
        isFile = ent.isFile();
      }
    } catch {
      continue; // broken symlink / stat failure — skip this entry, fail-open
    }
    if (isDir) {
      if (SKIP_DIRS.has(name)) continue;
      collect(full, out);
    } else if (isFile) {
      out.push(full);
    }
  }
}

/**
 * Walk the harness library's scan surface and return a deterministic, sorted list of
 * its files. Pure traversal — performs no `kind` classification.
 *
 * @param {string} rootDir Absolute path to the forge library root (`FORGE_ROOT`).
 * @returns {Array<{ absPath: string, relPath: string }>} Files under the scan
 *   surface, sorted ascending by POSIX `relPath`. Empty array on any failure.
 */
export function walkLibrary(rootDir) {
  try {
    const root = path.resolve(rootDir);
    /** @type {string[]} */
    const absFiles = [];
    for (const rel of SCAN_DIRS) {
      collect(path.join(root, rel), absFiles);
    }
    /** @type {Array<{ absPath: string, relPath: string }>} */
    const records = [];
    const seen = new Set();
    for (const absPath of absFiles) {
      const relPath = toPosix(path.relative(root, absPath));
      if (seen.has(relPath)) continue; // dedupe overlapping surfaces
      seen.add(relPath);
      records.push({ absPath, relPath });
    }
    records.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return records;
  } catch {
    return []; // fail-open: never throw past the public entry
  }
}
