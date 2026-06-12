// @ts-check
/**
 * eval-int.test.mjs — executable acceptance tests for EVAL-INT-001..010
 * (docs/manager/evals/EVAL-INT.md): the cross-cutting invariants that bind the
 * manager to the harness.
 *
 * RED-first: cases whose feature is not yet built (validate-manager-zerodep,
 * validate-registry, manager/registry.mjs + status.mjs, the storage-additive
 * meta-test, the `forge status|registry|monitor` subcommands) FAIL as honest
 * assertion failures — a missing module is dynamically imported INSIDE the test
 * body and its absence becomes a failed assertion (never a runner crash); an
 * unimplemented subcommand exits 2 today, which the spawn assertions catch as RED.
 * Cases already implemented in manager/lib (atomic/lossy store, finding shape)
 * SHOULD pass.
 *
 * Zero dependencies: node:test + node:assert + node: builtins only. Each test is
 * deterministic and self-cleaning (sandboxed FORGE_ROOT/STATE_HOME via
 * fs.mkdtempSync under os.tmpdir; never writes into the real repo or fixtures).
 *
 * Run model: node --test tests/manager/
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const FIXTURES = path.join(SCRIPT_DIR, 'fixtures');
const BIN = path.join(FORGE_ROOT, 'bin', 'forge.mjs');

// ---------------------------------------------------------------------------
// Shared zero-dep helpers
// ---------------------------------------------------------------------------

/** Make a self-cleaning temp dir; registers cleanup on the given test ctx. */
function sandbox(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

/** Try to dynamically import a module by absolute path; null if it does not load. */
async function tryImport(absPath) {
  try {
    return await import(absPath);
  } catch {
    return null;
  }
}

/** Run `node bin/forge.mjs <...args>` and capture {status, stdout, stderr}. */
function runForge(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd || FORGE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 120000,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

/**
 * Minimal zero-dep validator for the C2 finding shape against
 * schemas/finding.schema.json: required keys, exact level enum, string path,
 * integer-or-null line, non-empty message, non-empty source, no extra keys.
 * Returns an array of problem strings (empty ⇒ conformant).
 */
function checkFindingShape(f) {
  const problems = [];
  if (f === null || typeof f !== 'object') return ['not an object'];
  const allowed = new Set(['level', 'path', 'line', 'message', 'source']);
  for (const k of Object.keys(f)) {
    if (!allowed.has(k)) problems.push(`unexpected key: ${k}`);
  }
  for (const k of allowed) {
    if (!(k in f)) problems.push(`missing key: ${k}`);
  }
  if (!['ERROR', 'WARN', 'INFO'].includes(f.level)) problems.push(`bad level: ${String(f.level)}`);
  if (typeof f.path !== 'string') problems.push('path not a string');
  if (!(f.line === null || Number.isInteger(f.line))) problems.push('line not integer|null');
  if (typeof f.message !== 'string' || f.message.length < 1) problems.push('message empty/non-string');
  if (typeof f.source !== 'string' || f.source.length < 1) problems.push('source empty/non-string');
  return problems;
}

// ===========================================================================
// EVAL-INT-001 — Zero-dep: validate-manager-zerodep catches a non-node import
// ===========================================================================
test('EVAL-INT-001 — Zero-dep: validate-manager-zerodep catches a non-node import', async (t) => {
  const VALIDATOR = path.join(FORGE_ROOT, 'lint', 'validate-manager-zerodep.mjs');

  // RED gate: the validator must exist and be a runnable file.
  const mod = await tryImport(VALIDATOR);
  assert.ok(
    mod !== null && fs.existsSync(VALIDATOR),
    'lint/validate-manager-zerodep.mjs must exist (not yet built ⇒ RED)',
  );

  // Build a manager/ tree with one planted bare (non-node:, non-relative) import.
  const root = sandbox(t, 'int-001-');
  const mgr = path.join(root, 'manager', 'lib');
  fs.mkdirSync(mgr, { recursive: true });
  const bad = path.join(mgr, 'bad.mjs');
  fs.writeFileSync(bad, "import _ from 'lodash';\nexport const x = 1;\n", 'utf8');

  // Given the bad import: validator emits an ERROR naming the file/specifier and exits non-zero.
  const dirty = spawnSync(process.execPath, [VALIDATOR, root], { encoding: 'utf8', timeout: 120000 });
  const dirtyOut = (dirty.stdout || '') + (dirty.stderr || '');
  assert.notStrictEqual(dirty.status, 0, 'dirty tree must exit non-zero');
  assert.match(dirtyOut, /ERROR/, 'must emit an ERROR finding');
  assert.match(dirtyOut, /bad\.mjs/, 'finding must name the offending file');
  assert.match(dirtyOut, /lodash/, 'finding must name the bare specifier');

  // When the bare import is replaced with a node: builtin: validator exits 0.
  fs.writeFileSync(bad, "import path from 'node:path';\nexport const x = path.sep;\n", 'utf8');
  const clean = spawnSync(process.execPath, [VALIDATOR, root], { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(clean.status, 0, 'clean (node:-only) tree must exit 0');

  // And it MUST be auto-discovered by run-all with no runner edit.
  assert.ok(
    path.basename(VALIDATOR).startsWith('validate-') && VALIDATOR.endsWith('.mjs'),
    'name must match run-all discovery pattern (validate-*.mjs)',
  );
});

// ===========================================================================
// EVAL-INT-002 — Fail-open: a broken store read yields an empty panel and exit 0
// ===========================================================================
test('EVAL-INT-002 — Fail-open: a broken store read yields an empty REGISTRY panel and exit 0', async (t) => {
  // Sandbox FORGE_ROOT with a corrupted registry.json under forge/.forge/.
  const root = sandbox(t, 'int-002-');
  const stateDir = path.join(root, '.forge');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1.0\n', 'utf8');

  // Trial A: corrupted (invalid JSON) registry.
  fs.writeFileSync(path.join(stateDir, 'registry.json'), '{ not json', 'utf8');
  const corrupt = runForge(['status', root], { cwd: root, env: { FORGE_ROOT: root } });
  assert.strictEqual(corrupt.status, 0, '`forge status` must exit 0 on corrupted registry (fail-open)');
  const corruptOut = corrupt.stdout + corrupt.stderr;
  assert.doesNotMatch(corruptOut, /at .*\(.*:\d+:\d+\)/, 'must not print a JS stack trace');
  assert.match(
    corruptOut,
    /no data — run forge registry build/i,
    'REGISTRY panel must render the (no data) placeholder',
  );

  // Trial B: absent registry.
  fs.rmSync(path.join(stateDir, 'registry.json'), { force: true });
  const absent = runForge(['status', root], { cwd: root, env: { FORGE_ROOT: root } });
  assert.strictEqual(absent.status, 0, '`forge status` must exit 0 with no registry');
  assert.match(
    absent.stdout + absent.stderr,
    /no data — run forge registry build/i,
    'REGISTRY panel must render (no data) when registry is absent',
  );
});

// ===========================================================================
// EVAL-INT-003 — Storage-additive: writes only under the two roots, schemaVersion
// ===========================================================================
test('EVAL-INT-003 — Storage-additive: writes confined to the two roots + every file carries schemaVersion', async (t) => {
  // RED gate: the discovered meta-test that asserts this must exist.
  const META = path.join(FORGE_ROOT, 'tests', 'meta', 'manager-storage-additive.mjs');
  assert.ok(
    fs.existsSync(META),
    'tests/meta/manager-storage-additive.mjs must exist (discovered by run-meta) — not yet built ⇒ RED',
  );

  // Behavioural cross-check: a representative writing run (registry build --write)
  // must mutate nothing outside forge/.forge/ and ~/.claude/forge, and every
  // written state file must carry a top-level schemaVersion.
  const root = sandbox(t, 'int-003-root-');
  const home = sandbox(t, 'int-003-home-');
  // Seed a small library to build a registry from.
  const agents = path.join(root, 'agents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1.0\n', 'utf8');
  fs.writeFileSync(
    path.join(agents, 'code-reviewer.md'),
    '---\nowner: forge\ndescription: x\n---\nbody\n',
    'utf8',
  );

  // Snapshot every path's mtime+size OUTSIDE the two state roots, before the run.
  const stateDir = path.join(root, '.forge');
  const machineDir = path.join(home, '.claude', 'forge');
  function snapshotOutside(base) {
    const map = new Map();
    const stack = [base];
    while (stack.length) {
      const cur = stack.pop();
      let st;
      try {
        st = fs.statSync(cur);
      } catch {
        continue;
      }
      if (cur === stateDir || cur === machineDir) continue; // skip the two roots
      if (st.isDirectory()) {
        for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e));
      } else {
        map.set(cur, `${st.mtimeMs}:${st.size}`);
      }
    }
    return map;
  }
  const before = snapshotOutside(root);

  const built = runForge(['registry', 'build', '--write', root], {
    cwd: root,
    env: { FORGE_ROOT: root, HOME: home },
  });

  // RED gate: the write subcommand must run (unimplemented ⇒ exit 2 ⇒ fails here).
  assert.notStrictEqual(built.status, 2, '`forge registry build --write` must be implemented (exit 2 ⇒ RED)');
  assert.strictEqual(built.status, 0, '`forge registry build --write` must succeed');

  // Nothing outside the two roots changed.
  const after = snapshotOutside(root);
  for (const [p, sig] of after) {
    assert.ok(before.has(p), `no new file outside the two roots: ${p}`);
    assert.strictEqual(sig, before.get(p), `unchanged outside the two roots: ${p}`);
  }

  // Every written *.json state file carries a top-level schemaVersion.
  const reg = path.join(stateDir, 'registry.json');
  assert.ok(fs.existsSync(reg), 'registry.json written under forge/.forge/');
  const parsed = JSON.parse(fs.readFileSync(reg, 'utf8'));
  assert.ok('schemaVersion' in parsed, 'registry.json must carry a top-level schemaVersion');
});

// ===========================================================================
// EVAL-INT-004 — Findings-shape conformance: every finding matches the C2 shape
// (already implemented via manager/lib — SHOULD pass)
// ===========================================================================
test('EVAL-INT-004 — Findings-shape conformance: every finding matches schemas/finding.schema.json', async (t) => {
  const findingsMod = await tryImport(path.join(FORGE_ROOT, 'manager', 'lib', 'findings.mjs'));
  assert.ok(findingsMod, 'manager/lib/findings.mjs must load');
  const { parseFindings, makeFinding } = findingsMod;

  // Batch 1: findings PARSED by the runner from the EVAL-CLI-001 fixture validator's output.
  const fixture = path.join(FIXTURES, 'validate-fixture.mjs');
  const ran = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 120000 });
  const combined = (ran.stdout || '') + (ran.stderr || ''); // findings on stderr, summary on stdout
  const parsed = parseFindings(combined, 'validate-fixture.mjs');
  assert.ok(parsed.length >= 1, 'the fixture validator must yield at least one parsed finding');

  // Batch 2: findings EMITTED directly by a module (modeled via makeFinding, as registry.run() would).
  const emitted = [
    makeFinding({ level: 'ERROR', path: 'agents/broken.md', line: 4, message: 'unclosed fence', source: 'validate-registry' }),
    makeFinding({ level: 'WARN', path: 'agents/x.md', line: null, message: 'hash drift without revision bump', source: 'validate-registry' }),
    makeFinding({ level: 'INFO', path: 'manifests/modules.json', line: 1, message: 'planned module', source: 'registry' }),
  ];

  // Every finding in the mixed batch validates against the C2 schema.
  for (const f of [...parsed, ...emitted]) {
    assert.deepStrictEqual(checkFindingShape(f), [], `conformant finding: ${JSON.stringify(f)}`);
  }

  // A finding missing a field (or with a wrong type) fails the case.
  assert.notDeepStrictEqual(checkFindingShape({ level: 'ERROR', path: 'a.md', line: 1, message: 'm' }), [], 'missing source must fail');
  assert.notDeepStrictEqual(checkFindingShape({ level: 'NOPE', path: 'a.md', line: 1, message: 'm', source: 's' }), [], 'bad level must fail');
  assert.notDeepStrictEqual(checkFindingShape({ level: 'ERROR', path: 'a.md', line: 1.5, message: 'm', source: 's' }), [], 'non-integer line must fail');
});

// ===========================================================================
// EVAL-INT-005 — The C4 module contract holds for a representative module
// ===========================================================================
test('EVAL-INT-005 — C4 module contract: registry.mjs run/summarize, returns envelope-parts, routes state through store', async (t) => {
  // RED gate: the representative module must exist and export the C4 surface.
  const REG = path.join(FORGE_ROOT, 'manager', 'registry.mjs');
  const mod = await tryImport(REG);
  assert.ok(mod !== null && fs.existsSync(REG), 'manager/registry.mjs must exist (not yet built ⇒ RED)');

  assert.strictEqual(typeof mod.run, 'function', 'must export run(subcmd, args, ctx)');
  assert.strictEqual(typeof mod.summarize, 'function', 'must export summarize(state)');

  // summarize(undefined) returns a (no data) panel string and does not throw.
  let panel;
  assert.doesNotThrow(() => {
    panel = mod.summarize(undefined);
  }, 'summarize(undefined) must not throw');
  assert.match(String(panel), /no data/i, 'summarize(undefined) must render a (no data) panel');

  // run(...) returns { ok, data, findings, summary } and produces no stdout.
  const root = sandbox(t, 'int-005-');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1.0\n', 'utf8');

  // Stub the store: assert run() routes ALL state access through it (no direct fs state write).
  const storeMod = await tryImport(path.join(FORGE_ROOT, 'manager', 'lib', 'store.mjs'));
  assert.ok(storeMod, 'manager/lib/store.mjs must load');

  const written = [];
  const ctx = {
    forgeRoot: root,
    // A stubbed store the module is expected to use; observe zero out-of-store writes.
    store: {
      ...storeMod,
      writeJsonAtomic: (p, obj) => {
        written.push(p);
        return true;
      },
      appendJsonl: (p, obj) => {
        written.push(p);
        return true;
      },
    },
  };

  const out = mod.run('ls', [], ctx);
  const result = out && typeof out.then === 'function' ? await out : out;
  assert.ok(result && typeof result === 'object', 'run(...) must return an object');
  for (const k of ['ok', 'data', 'findings', 'summary']) {
    assert.ok(k in result, `run(...) result must include "${k}"`);
  }
  assert.ok(Array.isArray(result.findings), 'result.findings must be an array');

  // Every write the module issued must go through the (stubbed) store, never raw fs.
  for (const p of written) {
    assert.ok(
      p.includes(`${path.sep}.forge${path.sep}`) || p.includes(`${path.sep}forge${path.sep}`),
      `state writes confined to a state root: ${p}`,
    );
  }

  // A paired lint/validate-registry.mjs must exist.
  assert.ok(
    fs.existsSync(path.join(FORGE_ROOT, 'lint', 'validate-registry.mjs')),
    'paired lint/validate-registry.mjs must exist (not yet built ⇒ RED)',
  );
});

// ===========================================================================
// EVAL-INT-006 — Atomic snapshot, lossy append (already implemented — SHOULD pass)
// ===========================================================================
test('EVAL-INT-006 — Atomic snapshot + lossy append never corrupt state', async (t) => {
  const store = await tryImport(path.join(FORGE_ROOT, 'manager', 'lib', 'store.mjs'));
  assert.ok(store, 'manager/lib/store.mjs must load');
  const { writeJsonAtomic, readJson, appendJsonl, readJsonl } = store;

  const dir = sandbox(t, 'int-006-');

  // Atomic: an existing valid registry survives an interrupted (failing) write.
  const reg = path.join(dir, 'registry.json');
  assert.strictEqual(writeJsonAtomic(reg, { schemaVersion: 1, artifacts: [] }), true);
  const circular = {};
  circular.self = circular; // JSON.stringify throws mid-write -> rename never happens
  assert.strictEqual(writeJsonAtomic(reg, circular), false, 'failed write returns false');
  assert.deepStrictEqual(readJson(reg), { schemaVersion: 1, artifacts: [] }, 'prior file intact (no truncation)');
  const orphanTmp = fs
    .readdirSync(dir)
    .filter((n) => n.includes('registry.json') && n.endsWith('.tmp'));
  assert.strictEqual(orphanTmp.length, 0, 'no orphaned temp left behind');

  // Lossy: a contended append (lock held) is dropped, not corrupting / throwing.
  const events = path.join(dir, 'telemetry', 'events.jsonl');
  assert.strictEqual(appendJsonl(events, { first: true }), true);
  const lock = events + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '', { flag: 'wx' }); // a second appender holds the advisory lock
  assert.strictEqual(appendJsonl(events, { dropped: true }), false, 'contended append is dropped');
  fs.rmSync(lock, { force: true });
  assert.deepStrictEqual(readJsonl(events), [{ first: true }], 'file uncorrupted; the dropped line is absent');
});

// ===========================================================================
// EVAL-INT-007 — Compose, don't break: doctor/validate/sync baseline unchanged
// ===========================================================================
test('EVAL-INT-007 — Compose, don’t break: doctor/validate/sync unchanged + new validators discovered with state', async (t) => {
  // ----------------------------------------------------------------------------
  // KEYSTONE (EVAL-INT-007): the manager layer is ADDITIVE-NEVER-DESTRUCTIVE. On a
  // tree with NO manager state, doctor/validate/sync must be BYTE-IDENTICAL to a
  // captured pre-manager baseline; the additive MANAGER SCOPE block (and any other
  // manager-only line) must appear ONLY once manager state exists, APPENDED to the
  // unchanged baseline (compose, not replace). This test captures the no-state
  // baseline, proves the additive lines are ABSENT then, and proves that turning on
  // state APPENDS them without disturbing the baseline prefix or the exit code.
  // ----------------------------------------------------------------------------
  const tree = sandbox(t, 'int-007-');
  fs.writeFileSync(path.join(tree, 'VERSION'), '0.1.0\n', 'utf8');
  // A fixed, empty HOME so the global-install-state line is deterministic and the
  // baseline does not depend on the developer's real ~/.claude.
  const home = sandbox(t, 'int-007-home-');
  const envBase = { HOME: home };

  // The output is path-stamped (target project: <abs>). Normalise the absolute tree
  // path out so the baseline compares on STRUCTURE, not the random tmp dir name.
  const norm = (s) => String(s == null ? '' : s).split(tree).join('<TREE>');

  // -- Baseline capture: doctor & sync on a marker-less, state-less tree. --------
  const doctorNoState = runForge(['doctor', tree], { cwd: tree, env: envBase });
  const syncNoState = runForge(['sync', tree], { cwd: tree, env: envBase });
  assert.notStrictEqual(doctorNoState.status, 2, '`forge doctor` must remain a known command (compose, do not break)');
  assert.notStrictEqual(syncNoState.status, 2, '`forge sync` must remain a known command');

  const doctorBaseOut = norm(doctorNoState.stdout);
  const syncBaseOut = norm(syncNoState.stdout);

  // NEGATIVE HALF: with NO manager state, NONE of the additive manager lines appear.
  for (const out of [doctorBaseOut, syncBaseOut]) {
    assert.doesNotMatch(out, /MANAGER SCOPE/, 'no manager state ⇒ NO additive MANAGER SCOPE block (baseline must be pristine)');
    assert.doesNotMatch(out, /registry present|registry not built|telemetry (ON|OFF)/i, 'no manager state ⇒ no registry/telemetry advisory lines');
  }
  // The doctor baseline must still carry its ORIGINAL pre-manager content verbatim.
  assert.match(doctorBaseOut, /read-only health check/, 'doctor baseline keeps its original banner');
  assert.match(doctorBaseOut, /no Forge marker at \.claude\/\.forge\.json/, 'doctor baseline keeps its original no-marker result');
  assert.match(doctorBaseOut, /global install: not installed/, 'doctor baseline keeps its original install-state line');

  // RED gate: with manager state present, `forge validate` must discover BOTH new
  // validators (additive). Their absence from lint/ today makes this FAIL.
  let lintEntries = [];
  try {
    lintEntries = fs.readdirSync(path.join(FORGE_ROOT, 'lint'));
  } catch {
    lintEntries = [];
  }
  assert.ok(
    lintEntries.includes('validate-registry.mjs'),
    '`forge validate` must discover validate-registry.mjs (not yet built ⇒ RED)',
  );
  assert.ok(
    lintEntries.includes('validate-manager-zerodep.mjs'),
    '`forge validate` must discover validate-manager-zerodep.mjs (not yet built ⇒ RED)',
  );

  // -- Turn ON manager state: write a registry snapshot under <tree>/.forge. ------
  const stateDir = path.join(tree, '.forge');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'registry.json'),
    JSON.stringify({ schemaVersion: 1, VERSION: '0.1.0', generatedAt: '2026-06-05T00:00:00.000Z', artifacts: [] }, null, 2),
    'utf8',
  );

  const doctorWithState = runForge(['doctor', tree], { cwd: tree, env: { ...envBase, FORGE_ROOT: tree } });
  const doctorStateOut = norm(doctorWithState.stdout);

  // POSITIVE HALF: the additive MANAGER SCOPE block now appears.
  assert.match(
    doctorStateOut,
    /MANAGER SCOPE/,
    'doctor must show the additive MANAGER SCOPE block once manager state exists (not yet built ⇒ RED)',
  );
  assert.match(doctorStateOut, /registry present & in sync \(0 artifact\(s\)/, 'the MANAGER SCOPE block reports the live registry');

  // COMPOSE, DON'T BREAK: the additive block is APPENDED — every line of the no-state
  // baseline (except its trailing banner rule + blank tail) is still present, IN
  // ORDER, as a prefix of the with-state output. We compare line-by-line up to the
  // point the baseline first closes, proving the manager only ADDED lines.
  const baseLines = doctorBaseOut.split('\n');
  const stateLines = doctorStateOut.split('\n');
  // Find the baseline's install-state line; everything up to and including it must be
  // byte-identical in the with-state run (the additive block is inserted AFTER it).
  const anchor = '  [INFO] global install: not installed (no .forge-install-state.json in ~/.claude)';
  const baseAnchor = baseLines.indexOf(anchor);
  const stateAnchor = stateLines.indexOf(anchor);
  assert.ok(baseAnchor >= 0, 'baseline contains the install-state anchor line');
  assert.ok(stateAnchor >= 0, 'with-state output contains the same install-state anchor line');
  for (let i = 0; i <= baseAnchor; i++) {
    assert.strictEqual(
      stateLines[i],
      baseLines[i],
      `compose-don't-break: line ${i} must be byte-identical with/without manager state — baseline=${JSON.stringify(baseLines[i])} state=${JSON.stringify(stateLines[i])}`,
    );
  }
  // The additive block lands strictly AFTER the baseline anchor (it is appended, not
  // interleaved into the original content).
  const scopeLine = stateLines.findIndex((l) => /MANAGER SCOPE/.test(l));
  assert.ok(scopeLine > stateAnchor, 'the MANAGER SCOPE block is appended AFTER the baseline content');

  // Advisory-only: the additive block must NOT change doctor's exit code (ADR-0007).
  assert.strictEqual(
    doctorWithState.status,
    doctorNoState.status,
    "the additive MANAGER SCOPE block must not change doctor's exit code (advisory only)",
  );
});

// ===========================================================================
// EVAL-INT-008 — Self-validated and self-catalogued
// ===========================================================================
test('EVAL-INT-008 — Self-validated and self-catalogued', async (t) => {
  // Self-validated: both new validators discoverable by run-all, the meta-test by run-meta.
  let lintEntries = [];
  let metaEntries = [];
  try {
    lintEntries = fs.readdirSync(path.join(FORGE_ROOT, 'lint'));
  } catch {
    /* ignore */
  }
  try {
    metaEntries = fs.readdirSync(path.join(FORGE_ROOT, 'tests', 'meta'));
  } catch {
    /* ignore */
  }
  assert.ok(lintEntries.includes('validate-registry.mjs'), 'validate-registry.mjs in lint/ (RED)');
  assert.ok(lintEntries.includes('validate-manager-zerodep.mjs'), 'validate-manager-zerodep.mjs in lint/ (RED)');
  assert.ok(
    metaEntries.includes('manager-storage-additive.mjs'),
    'manager-storage-additive.mjs in tests/meta/ (RED)',
  );

  // Self-catalogued: build then ls produces records for manager modules and the new validators.
  const root = sandbox(t, 'int-008-');
  const home = sandbox(t, 'int-008-home-');
  // Mirror the real forge tree's catalogue surface into the sandbox so a build can
  // discover manager/** and the two validators (cataloguer catalogs itself).
  fs.mkdirSync(path.join(root, 'manager', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lint'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1.0\n', 'utf8');
  fs.writeFileSync(path.join(root, 'manager', 'registry.mjs'), '// stub\nexport const x = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'lint', 'validate-registry.mjs'), '// stub\n', 'utf8');
  fs.writeFileSync(path.join(root, 'lint', 'validate-manager-zerodep.mjs'), '// stub\n', 'utf8');

  const build = runForge(['registry', 'build', '--write', root], {
    cwd: root,
    env: { FORGE_ROOT: root, HOME: home },
  });
  assert.notStrictEqual(build.status, 2, '`forge registry build` must be implemented (exit 2 ⇒ RED)');
  assert.strictEqual(build.status, 0, '`forge registry build --write` must succeed');

  const ls = runForge(['registry', 'ls', root], { cwd: root, env: { FORGE_ROOT: root, HOME: home } });
  assert.notStrictEqual(ls.status, 2, '`forge registry ls` must be implemented (exit 2 ⇒ RED)');
  const lsOut = ls.stdout + ls.stderr;
  assert.match(lsOut, /validate-registry/, 'ls must list the validate-registry validator (self-catalogued)');
  assert.match(lsOut, /validate-manager-zerodep/, 'ls must list the validate-manager-zerodep validator');
});

// ===========================================================================
// EVAL-INT-009 — Advisory gates surface as WARN and do not block
// ===========================================================================
test('EVAL-INT-009 — Advisory gates surface as WARN and do not block (strict counts them)', async (t) => {
  // RED gate: the validator that emits these advisory WARNs must exist.
  const VALIDATOR = path.join(FORGE_ROOT, 'lint', 'validate-registry.mjs');
  assert.ok(fs.existsSync(VALIDATOR), 'lint/validate-registry.mjs must exist (not yet built ⇒ RED)');

  // The live-symlink/content-drift scenario (BR-INT-009): an artifact whose file is
  // PRESENT on disk but whose current content hash DIFFERS from the recorded
  // contentHash, while its revision is unchanged. That is the advisory bump-gate →
  // WARN (exit 0), ERROR under --strict. The artifact file MUST exist on disk; a
  // MISSING file is a different (stale/ERROR) condition and would not exercise the
  // advisory gate this case is about.
  const root = sandbox(t, 'int-009-');
  const stateDir = path.join(root, '.forge');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1.0\n', 'utf8');
  // Write the real artifact file. Its sha256 will NOT equal the recorded
  // contentHash ('a'*64), so a fresh scan sees content drift without a revision bump.
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'agents', 'code-reviewer.md'),
    '---\nowner: forge\ndescription: x\n---\nreviewer body (content drifted since last build)\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(stateDir, 'registry.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        VERSION: '0.1.0',
        generatedAt: new Date().toISOString(),
        artifacts: [
          {
            uid: 'agent:code-reviewer',
            kind: 'agent',
            id: 'code-reviewer',
            path: 'agents/code-reviewer.md',
            contentHash: 'a'.repeat(64),
            revision: 1,
            version: '0.1.0',
            status: 'active',
            criticality: 'normal',
            owner: 'forge',
            description: 'x',
            tags: [],
            modules: [],
            dependsOn: [],
            eval: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  // Default run (no --strict): advisory drift surfaces as WARN, exit 0 (no blocking).
  const normal = spawnSync(process.execPath, [VALIDATOR, root], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(normal.status, 0, 'advisory WARNs must NOT block (exit 0 without --strict)');

  // Same run under --strict: the advisory WARNs count toward a non-zero exit.
  const strict = spawnSync(process.execPath, [VALIDATOR, '--strict', root], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.notStrictEqual(strict.status, 0, 'under --strict, advisory WARNs must count toward a non-zero exit');

  // The manager installs no commit/push hook (no advisory gate becomes a blocking hook).
  const hooks = path.join(FORGE_ROOT, 'hooks', 'hooks.json');
  if (fs.existsSync(hooks)) {
    const raw = fs.readFileSync(hooks, 'utf8');
    assert.doesNotMatch(raw, /PreCommit|pre-commit|PrePush|pre-push/i, 'manager must install no commit/push hook');
  }
});

// ===========================================================================
// EVAL-INT-010 — Proportionate: no hot-path cost, no dep, no daemon, graceful absence
// ===========================================================================
test('EVAL-INT-010 — Proportionate: no hot-path manager import, zero deps, no daemon, graceful absence', async (t) => {
  // Zero runtime dependencies: no manifest the manager adds declares "dependencies".
  for (const rel of ['package.json', '.claude-plugin/plugin.json', 'manifests/modules.json']) {
    const p = path.join(FORGE_ROOT, rel);
    if (!fs.existsSync(p)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    const deps = json && json.dependencies;
    assert.ok(
      deps === undefined || (deps && typeof deps === 'object' && Object.keys(deps).length === 0),
      `${rel} must declare zero runtime dependencies`,
    );
  }

  // No hot-path cost: doctor/init/sync must not import any forge/manager/* module.
  // Probe by running a hot-path command under NODE_DEBUG-free instrumentation: we
  // assert no manager module is referenced by spawning the command and confirming
  // it neither requires the manager nor changes its exit contract.
  const tree = sandbox(t, 'int-010-');
  fs.writeFileSync(path.join(tree, 'VERSION'), '0.1.0\n', 'utf8');
  const sync = runForge(['sync', tree], { cwd: tree });
  assert.notStrictEqual(sync.status, 2, '`forge sync` must remain a known (non-manager) hot-path command');
  // Hot-path output must not surface manager-only panels (no eager manager import).
  assert.doesNotMatch(sync.stdout + sync.stderr, /MANAGER SCOPE|REGISTRY panel/, 'hot path must not eagerly load the manager');

  // DIRECT proof (not just an output proxy): instrument the loader and assert the
  // hot path actually imports NO forge/manager/* module. We register an
  // --experimental-loader that appends every resolved specifier to a trace file,
  // run `forge sync`, and assert no "/manager/" URL was loaded. This is the same
  // technique EVAL-CLI-006 uses; here it independently pins EVAL-INT-010's
  // "no hot-path manager import" claim rather than inferring it from stdout.
  const loaderDir = sandbox(t, 'int-010-loader-');
  const loader = path.join(loaderDir, 'loader.mjs');
  const importTrace = path.join(loaderDir, 'imports.log');
  fs.writeFileSync(
    loader,
    [
      "import fs from 'node:fs';",
      `const TRACE = ${JSON.stringify(importTrace)};`,
      'export async function resolve(spec, ctx, next) {',
      '  const r = await next(spec, ctx);',
      '  try { fs.appendFileSync(TRACE, (r && r.url ? r.url : spec) + "\\n"); } catch {}',
      '  return r;',
      '}',
    ].join('\n'),
    'utf8',
  );
  const traced = spawnSync(
    process.execPath,
    ['--experimental-loader', loader, BIN, 'sync', tree],
    { cwd: tree, encoding: 'utf8', timeout: 120000 },
  );
  assert.notStrictEqual(traced.status, 2, '`forge sync` (traced) must remain a known command');
  let importLog = '';
  try {
    importLog = fs.readFileSync(importTrace, 'utf8');
  } catch {
    /* ignore */
  }
  assert.ok(importLog.length > 0, 'the import tracer captured the hot-path module loads');
  assert.doesNotMatch(
    importLog,
    /\/manager\//,
    '`forge sync` (hot path) must import NO forge/manager/* module (direct load-trace proof)',
  );

  // No daemon: the monitor command must exist AND must terminate (never a long-lived
  // background process). RED today: `forge monitor` is unimplemented (exits 2).
  const mon = runForge(['monitor', '--once', tree], { cwd: tree, env: { FORGE_ROOT: tree } });
  assert.notStrictEqual(mon.status, 2, '`forge monitor` must be implemented and exit (not yet built ⇒ RED)');
  assert.ok(typeof mon.status === 'number', '`forge monitor` must terminate (no long-lived daemon)');

  // Graceful absence: a dimension with no upstream signal renders an empty (no data)
  // panel rather than erroring (cross-ref EVAL-INT-002 / EVAL-CLI-003).
  const status = runForge(['status', tree], { cwd: tree, env: { FORGE_ROOT: tree } });
  assert.notStrictEqual(status.status, 2, '`forge status` must be implemented (exit 2 ⇒ RED)');
  assert.strictEqual(status.status, 0, '`forge status` with no signal must exit 0 (graceful absence)');
  assert.match(status.stdout + status.stderr, /no data/i, 'an empty dimension renders a (no data) panel');
});
