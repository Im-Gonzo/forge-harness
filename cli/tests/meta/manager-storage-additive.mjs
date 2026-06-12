#!/usr/bin/env node
/**
 * manager-storage-additive — the storage-additive invariant (EVAL-INT-003, BR-INT-004).
 *
 * The manager owns exactly TWO physical state roots (ADR-0003, SPEC-09):
 *   - the git-tracked `<FORGE_ROOT>/.forge/`   (registry.json, registry.log.jsonl, …)
 *   - the machine-local `<STATE_HOME>` (`~/.claude/forge/`)  (fleet, telemetry, …)
 * A representative writing run MUST touch nothing outside those two roots, and every
 * state file it writes MUST carry a top-level `schemaVersion`. This meta-test proves
 * both mechanically: it runs a real `registry build --write` against a SANDBOXED
 * FORGE_ROOT plus a `store.appendJsonl` into a SANDBOXED STATE_HOME, having first
 * snapshotted (mtime+size) every path OUTSIDE the two sandboxes that the run could
 * plausibly reach (the real forge library tree + the importing modules' dir). It then
 * asserts: (a) no out-of-sandbox path changed, (b) every created/modified file lives
 * under one of the two sandbox roots, and (c) each written state JSON has schemaVersion.
 *
 * Auto-discovered by `tests/run-meta.mjs`. Zero deps (node: builtins + the manager's
 * own modules). node:assert. Prints "N passed, M failed". Self-cleaning. Exit 1 on fail.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const REGISTRY_MJS = path.join(FORGE_ROOT, 'manager', 'registry.mjs');
const STORE_MJS = path.join(FORGE_ROOT, 'manager', 'lib', 'store.mjs');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error && error.message ? error.message : String(error)}`);
    failed++;
  }
}

/**
 * Recursively snapshot mtimeMs+size of every file under `root`, keyed by abs path.
 * Fail-open: unreadable entries are skipped. Returns {} for a missing root.
 */
function snapshotTree(root) {
  /** @type {Record<string, string>} */
  const snap = {};
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        snap[full] = `${st.mtimeMs}:${st.size}`;
      }
    }
  }
  walk(root);
  return snap;
}

/** Paths present in `after` that are absent-or-different in `before`. */
function changedPaths(before, after) {
  const out = [];
  for (const p of Object.keys(after)) {
    if (before[p] !== after[p]) out.push(p);
  }
  return out;
}

/** Is `child` inside (or equal to) `parent`? Both must be absolute. */
function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Sandbox setup: two temp roots, plus a minimal fixture library to build from.
// ---------------------------------------------------------------------------

const SANDBOX_FORGE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-add-root-'));
const SANDBOX_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-add-state-'));

// A small, valid fixture LIBRARY the registry can actually build from: one agent.
const fixtureAgentsDir = path.join(SANDBOX_FORGE, 'agents');
fs.mkdirSync(fixtureAgentsDir, { recursive: true });
fs.writeFileSync(
  path.join(fixtureAgentsDir, 'fixture-agent.md'),
  [
    '---',
    'name: fixture-agent',
    'description: A throwaway fixture agent used only to give the registry build something to catalog.',
    'tools: [Read, Grep, Glob]',
    'model: sonnet',
    '---',
    '',
    '# fixture-agent',
    '',
    'A minimal agent fixture for the storage-additive meta-test.',
    '',
  ].join('\n'),
  'utf8',
);

// Snapshot every path OUTSIDE the two sandbox roots that the run might touch:
// the real forge library tree (which contains the modules being exercised) and,
// defensively, the importing modules' own directory. If any of these change, the
// write escaped its sandbox.
const beforeForge = snapshotTree(FORGE_ROOT);

let createdRegistryPath = null;
let createdStatePath = null;

async function runRepresentativeWrite() {
  // (1) registry build --write against the SANDBOX_FORGE → writes <root>/.forge/*.
  const registry = await import(pathToFileURL(REGISTRY_MJS).href);
  const res = await registry.run('build', ['--write'], { FORGE_ROOT: SANDBOX_FORGE });
  assert.ok(res && typeof res === 'object', 'registry.run did not return a result object');
  assert.strictEqual(res.ok, true, `registry build --write did not succeed (ok=${res && res.ok})`);

  createdRegistryPath = path.join(SANDBOX_FORGE, '.forge', 'registry.json');

  // (2) a store append into the SANDBOX_STATE root (a fleet/telemetry-style write).
  const store = await import(pathToFileURL(STORE_MJS).href);
  createdStatePath = path.join(SANDBOX_STATE, 'telemetry', 'events.jsonl');
  const stamped = store.stampSchemaVersion(
    { ts: new Date(0).toISOString(), event: 'meta-test-probe' },
    'forge.telemetry.v1',
  );
  const appended = store.appendJsonl(createdStatePath, stamped);
  assert.strictEqual(appended, true, 'store.appendJsonl into STATE_HOME returned false');
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== manager-storage-additive: writes stay under the two state roots (EVAL-INT-003) ===\n');

  let runError = null;
  try {
    await runRepresentativeWrite();
  } catch (e) {
    runError = e;
  }

  const afterForge = snapshotTree(FORGE_ROOT);

  test('representative write run completed without throwing', () => {
    assert.strictEqual(runError, null, `run threw: ${runError && runError.stack ? runError.stack : runError}`);
  });

  test('no path OUTSIDE the two state roots was created or modified', () => {
    // The sandbox FORGE root is a tmpdir, so it is NOT under the real FORGE_ROOT —
    // any change under the real library tree is an out-of-root escape.
    const escaped = changedPaths(beforeForge, afterForge).filter(
      (p) => !isUnder(p, SANDBOX_FORGE) && !isUnder(p, SANDBOX_STATE),
    );
    assert.deepStrictEqual(
      escaped,
      [],
      `writes escaped the two state roots:\n      ${escaped.join('\n      ')}`,
    );
  });

  test('the registry snapshot was created under <FORGE_ROOT>/.forge/', () => {
    assert.ok(createdRegistryPath, 'registry path was never set (run failed earlier)');
    assert.ok(fs.existsSync(createdRegistryPath), `expected ${createdRegistryPath} to exist`);
    assert.ok(
      isUnder(createdRegistryPath, path.join(SANDBOX_FORGE, '.forge')),
      `registry.json landed outside the sandbox .forge dir: ${createdRegistryPath}`,
    );
  });

  test('the telemetry append landed under STATE_HOME', () => {
    assert.ok(createdStatePath, 'state path was never set (run failed earlier)');
    assert.ok(fs.existsSync(createdStatePath), `expected ${createdStatePath} to exist`);
    assert.ok(
      isUnder(createdStatePath, SANDBOX_STATE),
      `telemetry log landed outside STATE_HOME: ${createdStatePath}`,
    );
  });

  test('every CHANGED file lies under <FORGE_ROOT>/.forge/ or STATE_HOME', () => {
    // Combine the two sandbox trees' new/changed files and confirm containment.
    const beforeState = {}; // STATE_HOME started empty (fresh mkdtemp)
    const afterState = snapshotTree(SANDBOX_STATE);
    const afterDotForge = snapshotTree(path.join(SANDBOX_FORGE, '.forge'));

    const allWritten = [
      ...changedPaths(beforeState, afterState),
      ...Object.keys(afterDotForge),
    ];
    assert.ok(allWritten.length > 0, 'the run wrote no state files at all — fixture/build is broken');
    const stray = allWritten.filter(
      (p) => !isUnder(p, path.join(SANDBOX_FORGE, '.forge')) && !isUnder(p, SANDBOX_STATE),
    );
    assert.deepStrictEqual(stray, [], `state files outside the two roots:\n      ${stray.join('\n      ')}`);
  });

  test('every written state JSON carries a top-level schemaVersion', () => {
    // registry.json (a snapshot JSON) must be schema-stamped.
    const raw = fs.readFileSync(createdRegistryPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`registry.json is not valid JSON: ${e.message}`);
    }
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, 'schemaVersion'),
      'registry.json is missing a top-level schemaVersion',
    );
    assert.ok(
      parsed.schemaVersion !== undefined && parsed.schemaVersion !== null,
      'registry.json schemaVersion is null/undefined',
    );

    // The JSONL telemetry record we appended must also carry schemaVersion per line.
    const lines = fs.readFileSync(createdStatePath, 'utf8').split('\n').filter((l) => l.trim());
    assert.ok(lines.length > 0, 'telemetry log has no records');
    for (const line of lines) {
      const rec = JSON.parse(line);
      assert.ok(
        Object.prototype.hasOwnProperty.call(rec, 'schemaVersion'),
        `telemetry record is missing schemaVersion: ${line}`,
      );
    }
  });
}

function cleanup() {
  for (const dir of [SANDBOX_FORGE, SANDBOX_STATE]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort, never fail the test on cleanup */
    }
  }
}

main()
  .catch((e) => {
    console.log('  FAIL manager-storage-additive: unexpected harness error');
    console.log(`    ${e && e.stack ? e.stack : e}`);
    failed++;
  })
  .finally(() => {
    cleanup();
    console.log(`\n  ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log('manager-storage-additive: FAIL');
      process.exit(1);
    }
    console.log('manager-storage-additive: PASS');
    process.exit(0);
  });
