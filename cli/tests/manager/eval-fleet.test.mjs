// @ts-check
/**
 * eval-fleet.test.mjs — executable acceptance specs for Fleet & Provenance
 * (SPEC-04, ADR-0009, ADR-0010, BR-FLEET-001..024). One `test(...)` per EVAL case
 * from docs/manager/evals/EVAL-FLEET.md, asserting that case's Given/When/Then.
 *
 * PHASING (EVAL-FLEET.md / ADR-0010):
 *   - v0.2 provenance ....... EVAL-FLEET-001, -002  (sourceRev write + legacy fallback)
 *   - v0.3 fleet READ ....... EVAL-FLEET-003, -005, -006  (drift · fail-open+contract · opt-in)
 *   - v0.5 fleet WRITE ...... EVAL-FLEET-004, -013, -014  (DEFERRED — RED placeholders, NOT gated)
 * This file's MANDATE is the Phase-v0.3 READ cases (provenance sourceRev computed
 * correctly; drift detection; opt-in default-OFF; fail-open on a corrupt fleet.json).
 * The v0.2 provenance cases are kept (they gate the v0.3 reads) and the v0.5 write
 * cases are present only as RED placeholders so the spec is coherent and growable.
 *
 * HONEST RED — none of the fleet surface exists today:
 *   - manager/fleet.mjs ............... does not exist (the run/summarize module)
 *   - lint/validate-fleet.mjs ......... does not exist (the paired self-validator)
 *   - bin/forge.mjs `fleet <verb>` .... a PLANNED-NOTICE stub: prints "reserved …
 *                                       not yet built" and exits 0 (no drift/enable/add)
 *   - `forge init --apply` ............ writes a marker with NO `provenance` block yet
 * Each test therefore RED-fails on an ASSERTION, never a crash:
 *   - for an unbuilt MODULE we dynamic-`import()` it INSIDE the test body wrapped in
 *     try/catch (a missing module ⇒ `null` ⇒ assertion failure, never a thrown import
 *     that aborts the runner — and never a module that `process.exit()`s at import);
 *   - for unbuilt CLI behaviour we `spawnSync` `node bin/forge.mjs fleet …` and assert
 *     on the REAL v0.3 contract — today's planned-notice stub fails those assertions.
 *
 * Sandboxing: every test copies a frozen fixture into an `os.tmpdir()` sandbox
 * (`fs.mkdtempSync`) and runs there; the real repo and the frozen fixtures are NEVER
 * mutated. Machine-local fleet state (`~/.claude/forge/fleet.json`) is redirected by
 * pointing `HOME` at a fresh sandbox per test, so no test ever touches the real
 * `$HOME`. Each test is deterministic and self-cleaning (cleanup in `t.after`).
 *
 * Run model: node --test tests/manager/   (built-in node:test + node:assert, ZERO deps).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(HERE, 'fixtures');
const FORGE_BIN = path.join(FORGE_ROOT, 'bin', 'forge.mjs');
const FLEET_MODULE = path.join(FORGE_ROOT, 'manager', 'fleet.mjs');
const VALIDATE_FLEET = path.join(FORGE_ROOT, 'lint', 'validate-fleet.mjs');
const LINT_DIR = path.join(FORGE_ROOT, 'lint');

// ---------------------------------------------------------------------------
// Sandbox + fs helpers (zero-dep; mirror eval-reg.test.mjs)
// ---------------------------------------------------------------------------

/** Recursively copy a directory tree (files + dirs only). */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

/** Copy fixture `name` into a fresh tmp sandbox; return its absolute root. */
function sandbox(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-fleet-${name}-`));
  copyTree(path.join(FIXTURES, name), root);
  return root;
}

/** A fresh empty sandbox dir (e.g. a clean $HOME). */
function mkSandbox(tag = 'forge-fleet') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}

/** Remove a sandbox dir best-effort (fail-open in teardown). */
function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** List every POSIX-relative file path under `root`, recursively. */
function listFiles(root) {
  /** @type {string[]} */
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  })(root);
  return out;
}

/** Lowercase hex sha256 of a string/Buffer (mirrors manager/lib/hash.mjs). */
function sha256hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** Read+parse a JSON file, or null (fail-open). */
function readJson(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Run `node bin/forge.mjs <args>`; capture status/stdout/stderr. */
function runForge(args, { cwd = FORGE_ROOT, env } = {}) {
  const res = spawnSync(process.execPath, [FORGE_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...(env || {}) },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
}

/**
 * Dynamic-import the (not-yet-built) fleet module SAFELY: never let a missing
 * module — or a module that `process.exit()`s at import — abort the runner. A
 * failed import resolves to `null`, which the caller turns into an assertion
 * failure (HONEST RED).
 * @returns {Promise<any|null>}
 */
async function importFleet() {
  try {
    return await import(FLEET_MODULE);
  } catch {
    return null;
  }
}

/**
 * INDEPENDENT recompute of `provenance.sourceRev` (ADR-0009 / BR-FLEET-001): fold
 * the Registry `contentHash` of every resolved component into one sha256 over the
 * canonical, **uid-sorted** `{uid: contentHash}` map. This is the test oracle the
 * manager's written value must equal; it is order-independent by construction.
 *
 * @param {Record<string,string>} uidToHash map of resolved-component uid → contentHash
 * @returns {string} `"sha256:" + sha256hex(canonical(sorted))`
 */
function recomputeSourceRev(uidToHash) {
  const sorted = {};
  for (const uid of Object.keys(uidToHash).sort()) sorted[uid] = uidToHash[uid];
  return 'sha256:' + sha256hex(JSON.stringify(sorted));
}

/** Read a project's marker (`<project>/.claude/.forge.json`) or null. */
function readMarker(projectDir) {
  return readJson(path.join(projectDir, '.claude', '.forge.json'));
}

/** Path to the machine-local fleet index for a given fake HOME (ADR-0003/0010). */
function fleetIndexPath(home) {
  return path.join(home, '.claude', 'forge', 'fleet.json');
}

// ===========================================================================
// EVAL-FLEET-001 — `sourceRev` computed correctly + schema widening additive
// Phase v0.2 · Verifies BR-FLEET-001, BR-FLEET-002
// RED: `forge init --apply` writes a marker with NO `provenance` block today.
// ===========================================================================
test('EVAL-FLEET-001 — sourceRev computed correctly + schema widening additive', async (t) => {
  const home = mkSandbox('forge-fleet-home');
  const proj = sandbox('fleet-project');
  t.after(() => {
    cleanup(home);
    cleanup(proj);
  });
  const env = { HOME: home };

  // Init into a MARKER-FREE tree so init WRITES a fresh marker (init preserves an
  // existing `.claude/.forge.json`, which would mask whether it folds provenance).
  fs.rmSync(path.join(proj, '.claude', '.forge.json'), { force: true });

  // When `forge init --apply` runs against the project tree…
  const init = runForge(['init', proj, '--apply'], { env });
  assert.strictEqual(init.status, 0, `forge init --apply must succeed; got ${init.status} ${init.stderr.trim()}`);

  // …then the freshly-written marker carries a provenance block with
  // registrySchema + sourceRev (RED today: a fresh init writes no `provenance`).
  const marker = readMarker(proj);
  assert.ok(marker, 'marker is present after init --apply');
  assert.ok(
    marker.provenance && typeof marker.provenance === 'object',
    'marker.provenance is written by init --apply (RED until init folds sourceRev — ADR-0009)',
  );
  assert.ok(
    typeof marker.provenance.registrySchema === 'string' && marker.provenance.registrySchema.length > 0,
    'provenance.registrySchema is a non-empty string',
  );
  assert.match(
    String(marker.provenance.sourceRev),
    /^sha256:[0-9a-f]+$/,
    'provenance.sourceRev is "sha256:<hex>"',
  );

  // sourceRev equals an INDEPENDENT recompute over the resolved {uid: contentHash},
  // and is ORDER-INDEPENDENT (the fold sorts by uid). The resolved component set is
  // derived from the LIBRARY Registry (FORGE_ROOT/.forge/registry.json — init
  // resolves against the global library, not a project-side registry) by reverse-
  // resolving the marker's modules[] (the same {profile,modules}→components mapping
  // init performs, per ADR-0009).
  const reg = readJson(path.join(FORGE_ROOT, '.forge', 'registry.json'));
  assert.ok(reg && Array.isArray(reg.artifacts), 'the forge library Registry is built (self-hosted .forge/registry.json)');
  const resolvedModules = new Set(Array.isArray(marker.modules) ? marker.modules : []);
  /** @type {Record<string,string>} */
  const uidToHash = {};
  for (const a of reg.artifacts) {
    if (!a || typeof a.uid !== 'string' || typeof a.contentHash !== 'string') continue;
    const inResolved = Array.isArray(a.modules) && a.modules.some((m) => resolvedModules.has(m));
    if (inResolved) uidToHash[a.uid] = a.contentHash;
  }
  assert.ok(Object.keys(uidToHash).length > 0, 'at least one resolved component contributes to the fold');
  const expected = recomputeSourceRev(uidToHash);
  assert.strictEqual(marker.provenance.sourceRev, expected, 'sourceRev equals the independent uid-sorted fold');

  // Order-independence: shuffling the map (reverse-sorted insertion) yields the SAME fold.
  /** @type {Record<string,string>} */
  const reversed = {};
  for (const uid of Object.keys(uidToHash).sort().reverse()) reversed[uid] = uidToHash[uid];
  assert.strictEqual(recomputeSourceRev(reversed), expected, 'reordering the resolved set yields the same sourceRev');

  // Schema arm: the widened marker.schema.json still forbids UNKNOWN top-level keys
  // (additionalProperties:false preserved) — provenance is the ONLY new property.
  const schema = readJson(path.join(FORGE_ROOT, 'schemas', 'marker.schema.json'));
  assert.ok(schema, 'marker.schema.json is present');
  assert.strictEqual(schema.additionalProperties, false, 'additionalProperties:false is preserved after widening');
  assert.ok(
    schema.properties && typeof schema.properties.provenance === 'object',
    'marker.schema.json declares an optional provenance property (RED until widened — BR-FLEET-002)',
  );
  assert.ok(
    !Array.isArray(schema.required) || !schema.required.includes('provenance'),
    'provenance is OPTIONAL — the required set is unchanged (legacy markers stay valid)',
  );
});

// ===========================================================================
// EVAL-FLEET-002 — Legacy marker → version-level drift only
// Phase v0.2 · Verifies BR-FLEET-003
// RED: there is no fleet/drift module to assess a provenance-less marker yet.
// ===========================================================================
test('EVAL-FLEET-002 — legacy marker (no provenance) → version-level drift only, never errors', async (t) => {
  const home = mkSandbox('forge-fleet-home');
  const proj = sandbox('fleet-project');
  t.after(() => {
    cleanup(home);
    cleanup(proj);
  });

  // Given a valid marker with NO provenance (and a forgeVersion one revision behind
  // the running forge so a VERSION drift exists to report)…
  const markerAbs = path.join(proj, '.claude', '.forge.json');
  const marker = readMarker(proj);
  assert.ok(marker, 'precondition: fixture marker exists');
  delete marker.provenance;
  marker.forgeVersion = '0.0.1'; // deliberately behind the running forge
  fs.writeFileSync(markerAbs, JSON.stringify(marker, null, 2) + '\n', 'utf8');

  // When the manager assesses drift for that project…
  const mod = await importFleet();
  assert.ok(mod, 'manager/fleet.mjs must exist and import cleanly (RED until built)');
  assert.strictEqual(typeof mod.run, 'function', 'manager/fleet.mjs must export run(subcmd, args, ctx)');

  let res;
  await assert.doesNotReject(async () => {
    res = await mod.run('drift', [proj], { FORGE_ROOT, cwd: proj, HOME: home });
  }, 'fleet drift on a provenance-less marker NEVER throws (BR-FLEET-003, fail-open)');
  assert.ok(res && typeof res === 'object', 'run(...) returns a result object');

  // …then it reports version-level drift (versionBehind) and componentsBehind = null
  // (unknown — never a number for a legacy marker), and raises no ERROR finding.
  const row = drillRow(res, proj);
  assert.ok(row, 'drift result carries a per-project health row');
  assert.strictEqual(row.versionBehind, true, 'legacy marker behind the running forge → versionBehind:true');
  assert.strictEqual(row.componentsBehind, null, 'legacy marker → componentsBehind:null (unknown, not 0/a number)');
  const errs = (res.findings || []).filter((f) => f && f.level === 'ERROR');
  assert.deepStrictEqual(errs, [], 'assessing a legacy marker produces no ERROR finding');
});

// ===========================================================================
// EVAL-FLEET-003 — Drift detection (version + component, --component R,
//                  advisory WARN, cheap markerChecksum gate)
// Phase v0.3 · Verifies BR-FLEET-004, -012, -022, -023
// RED: `forge fleet drift` is a planned-notice stub (exit 0, no module) today.
// ===========================================================================
test('EVAL-FLEET-003 — drift detection: --component R, component-scoped, advisory WARN, cheap cache gate', async (t) => {
  const home = mkSandbox('forge-fleet-home');
  // Two projects: one resolving to component R, one not. We build the fleet index
  // around the single fixture project (resolving to R) and a second derived project
  // that does NOT resolve to R, so component-scope can be asserted.
  const projR = sandbox('fleet-project'); // resolves to component R (the reviewer)
  const projOther = sandbox('fleet-project'); // mutated below to NOT resolve to R
  t.after(() => {
    cleanup(home);
    cleanup(projR);
    cleanup(projOther);
  });

  // Make projOther resolve to a DIFFERENT module so it does not include R.
  const otherMarkerAbs = path.join(projOther, '.claude', '.forge.json');
  const otherMarker = readMarker(projOther);
  otherMarker.profile = 'memory';
  otherMarker.modules = ['memory'];
  otherMarker.files = []; // does not track the reviewer artifact
  fs.writeFileSync(otherMarkerAbs, JSON.stringify(otherMarker, null, 2) + '\n', 'utf8');

  const mod = await importFleet();
  assert.ok(mod, 'manager/fleet.mjs must exist and import cleanly (RED until built)');
  assert.strictEqual(typeof mod.run, 'function', 'manager/fleet.mjs must export run(subcmd, args, ctx)');

  // Register both projects into the (opt-in) index.
  await mod.run('enable', [], { FORGE_ROOT, cwd: projR, HOME: home });
  await mod.run('add', [projR], { FORGE_ROOT, cwd: projR, HOME: home });
  await mod.run('add', [projOther], { FORGE_ROOT, cwd: projOther, HOME: home });

  // The component R uid the reviewer resolves to.
  const R = 'agent:code-reviewer';

  // When `forge fleet drift --component R` runs after R advanced upstream…
  let res;
  await assert.doesNotReject(async () => {
    res = await mod.run('drift', ['--component', R], { FORGE_ROOT, cwd: projR, HOME: home });
  }, 'fleet drift --component R never throws (fail-open)');
  assert.ok(res && typeof res === 'object', 'drift returns a result object');

  // …then output is SCOPED to projects resolving to R: projR present, projOther absent.
  const ids = driftProjectIds(res);
  assert.ok(
    ids.some((id) => sameProject(id, projR)),
    'fleet drift --component R lists the project resolving to R (BR-FLEET-023)',
  );
  assert.ok(
    !ids.some((id) => sameProject(id, projOther)),
    'a project NOT resolving to R is absent from --component R output (component-scope)',
  );

  // The finding(s) are advisory WARN, never ERROR (BR-FLEET-022 / ADR-0007).
  const findings = res.findings || [];
  assert.deepStrictEqual(
    findings.filter((f) => f && f.level === 'ERROR'),
    [],
    'fleet drift never emits an ERROR finding (advisory-only)',
  );
  assert.ok(
    findings.length === 0 || findings.some((f) => f && f.level === 'WARN'),
    'drift findings are advisory WARN (ADR-0007)',
  );

  // Cheap gate: a project whose markerChecksum is unchanged is served from cache
  // WITHOUT re-hashing its files (BR-FLEET-012). We assert the row exposes a
  // markerChecksum and that a second query reports it from cache (fromCache flag),
  // not re-hashed.
  const rowR = drillRow(res, projR);
  assert.ok(rowR, 'a per-project drift row exists for projR');
  assert.match(String(rowR.markerChecksum || ''), /^sha256:[0-9a-f]+$/, 'row carries a markerChecksum (sha256 of marker bytes)');
  const again = await mod.run('drift', ['--component', R], { FORGE_ROOT, cwd: projR, HOME: home });
  const rowAgain = drillRow(again, projR);
  assert.ok(rowAgain, 'second drift query still returns the row');
  assert.strictEqual(
    rowAgain.fromCache === true || rowAgain.reHashed === false,
    true,
    'an unchanged markerChecksum is served from cache without re-hashing files (BR-FLEET-012)',
  );
});

// ===========================================================================
// EVAL-FLEET-005 — Fail-open on corrupt fleet.json + module contract
// Phase v0.3 · Verifies BR-FLEET-014, -024
// RED: init/doctor/sync do not consult a fleet index; fleet.mjs + validate-fleet.mjs
//      do not exist; bin `fleet` is a stub.
// ===========================================================================
test('EVAL-FLEET-005 — fail-open on a corrupt fleet.json; fleet module + paired validator contract', async (t) => {
  const home = mkSandbox('forge-fleet-home');
  const proj = sandbox('fleet-project');
  t.after(() => {
    cleanup(home);
    cleanup(proj);
  });
  const env = { HOME: home };

  // Given ~/.claude/forge/fleet.json truncated to invalid JSON…
  const idx = fleetIndexPath(home);
  fs.mkdirSync(path.dirname(idx), { recursive: true });
  fs.writeFileSync(idx, '{ "schema": "forge.fleet.v1", "projects": {  <<<TRUNCATED', 'utf8');

  // …when init --apply, doctor, and sync each run, ALL complete successfully and
  // none throws; the corrupt index is treated as "no data" (BR-FLEET-014).
  for (const args of [['init', proj, '--apply'], ['doctor', proj], ['sync', proj]]) {
    const r = runForge(args, { env });
    assert.ok(!r.error, `forge ${args[0]} did not crash on a corrupt fleet.json (got error: ${r.error && r.error.message})`);
    assert.notStrictEqual(r.status, null, `forge ${args[0]} produced an exit code (did not abort)`);
    const text = (r.stdout || '') + (r.stderr || '');
    // The index is reported unavailable, never fatal. (doctor/sync may exit non-zero
    // for OTHER reasons, but must never throw on the fleet read.)
    assert.doesNotMatch(text, /UnhandledPromiseRejection|TypeError|ReferenceError|Cannot read propert/i,
      `forge ${args[0]} surfaced no runtime exception from the corrupt index`);
  }
  // init must still have produced a valid marker (the command was not blocked).
  assert.ok(readMarker(proj), 'init --apply produced a valid marker despite the corrupt fleet.json');

  // Contract arm (BR-FLEET-024 / C4): manager/fleet.mjs exists, exports run+summarize,
  // is dry-run by default, and writes nothing outside the machine-local root.
  const mod = await importFleet();
  assert.ok(mod, 'manager/fleet.mjs must exist and import cleanly (RED until built)');
  assert.strictEqual(typeof mod.run, 'function', 'fleet.mjs exports run(subcmd, args, ctx)');
  assert.strictEqual(typeof mod.summarize, 'function', 'fleet.mjs exports summarize(state)');

  // run() must NEVER write stdout/stderr (print/compute split, C4) and must return
  // the { ok, data, findings, summary } shape.
  const stdoutChunks = [];
  const stderrChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => (stdoutChunks.push(String(c)), true);
  process.stderr.write = (c) => (stderrChunks.push(String(c)), true);
  let res;
  try {
    res = await mod.run('status', [], { FORGE_ROOT, cwd: proj, HOME: home });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  assert.strictEqual(stdoutChunks.join(''), '', 'fleet.run prints NOTHING to stdout');
  assert.strictEqual(stderrChunks.join(''), '', 'fleet.run prints NOTHING to stderr');
  assert.ok(res && typeof res === 'object', 'fleet.run returns a result object');
  for (const k of ['ok', 'data', 'findings', 'summary']) {
    assert.ok(k in res, `fleet.run result has "${k}"`);
  }

  // Dry-run by default: a read verb (status) writes NOTHING to the git-tracked repo
  // and creates no fleet.json in the project tree (only the machine-local root may
  // ever hold one — BR-FLEET-005/017).
  assert.ok(!fs.existsSync(path.join(proj, '.forge', 'fleet.json')), 'no fleet.json under the project .forge/');
  assert.ok(!fs.existsSync(path.join(proj, '.claude', 'fleet.json')), 'no fleet.json under the project .claude/');

  // The paired validator is auto-discovered (lives in lint/, name validate-*.mjs)
  // and asserts the module contract.
  assert.ok(fs.existsSync(VALIDATE_FLEET), 'lint/validate-fleet.mjs exists (auto-discovered self-validator, RED until built)');
  const lintFiles = listFiles(LINT_DIR).filter((p) => /^validate-fleet\.mjs$/.test(p));
  assert.deepStrictEqual(lintFiles, ['validate-fleet.mjs'], 'validate-fleet.mjs is discoverable by the lint runner');
  // It must run against the repo and PASS (advisory; exit 0 in non-strict mode).
  const vres = spawnSync(process.execPath, [VALIDATE_FLEET, FORGE_ROOT], { cwd: FORGE_ROOT, encoding: 'utf8' });
  assert.notStrictEqual(vres.status, null, 'validate-fleet.mjs runs to completion');
  const vtext = (vres.stdout || '') + (vres.stderr || '');
  assert.match(vtext, /validate-fleet/i, 'validate-fleet.mjs prints its own summary line');
});

// ===========================================================================
// EVAL-FLEET-006 — Opt-in, default OFF; registration is offered, not silent
// Phase v0.3 · Verifies BR-FLEET-007, -008
// RED: there are no `fleet enable`/`fleet add` verbs; doctor does not detect-and-offer.
// ===========================================================================
test('EVAL-FLEET-006 — opt-in default-OFF; registration is offered (detect-and-offer), never silent', async (t) => {
  const home = mkSandbox('forge-fleet-home'); // clean machine: fleetEnabled absent/false
  const proj = sandbox('fleet-project');
  t.after(() => {
    cleanup(home);
    cleanup(proj);
  });
  const env = { HOME: home };
  const idx = fleetIndexPath(home);

  // Given a clean machine (no fleet state), init --apply then doctor/sync run…
  for (const args of [['init', proj, '--apply'], ['doctor', proj], ['sync', proj]]) {
    const r = runForge(args, { env });
    assert.notStrictEqual(r.status, null, `forge ${args[0]} ran`);
  }
  // …then NO fleet.json is created (default OFF — privacy-first, BR-FLEET-007).
  assert.ok(!fs.existsSync(idx), 'with the fleet disabled, init/doctor/sync create NO ~/.claude/forge/fleet.json');

  // After `forge fleet enable`…
  const en = runForge(['fleet', 'enable'], { env });
  // RED today: `fleet` is a planned-notice stub (exit 0, no module) — `enable` is not
  // a real sub-verb, so fleetEnabled never flips. Assert the v0.3 contract.
  assert.notStrictEqual(
    (en.stdout || '') + (en.stderr || ''),
    '',
    'fleet enable produces output',
  );
  assert.doesNotMatch(
    (en.stdout || '') + (en.stderr || ''),
    /reserved in the command taxonomy but not yet built/i,
    '`fleet enable` is a real v0.3 sub-verb, not the planned-notice stub (RED until built)',
  );
  const idxAfterEnable = readJson(idx);
  assert.ok(idxAfterEnable, 'fleet enable creates the machine-local index');
  assert.strictEqual(idxAfterEnable.fleetEnabled, true, 'fleet enable sets fleetEnabled:true');
  assert.deepStrictEqual(
    idxAfterEnable.projects || {},
    {},
    'enabling alone registers NO project (enable is not registration)',
  );

  // When doctor runs against an UNREGISTERED project NON-interactively (no confirm)…
  const doc = runForge(['doctor', proj], { env });
  const docText = (doc.stdout || '') + (doc.stderr || '');
  // …it OFFERS registration (detect-and-offer) and still writes NOTHING to fleet.json
  // (BR-FLEET-008, invariant #3 — global mutation requires explicit confirmation).
  assert.match(
    docText,
    /register|fleet add|offer/i,
    'doctor offers registration for an unregistered marker while the fleet is enabled (RED until detect-and-offer)',
  );
  const idxAfterDoctor = readJson(idx);
  assert.ok(idxAfterDoctor, 'index still present after doctor');
  assert.deepStrictEqual(
    idxAfterDoctor.projects || {},
    {},
    'a non-interactive doctor registers nothing — it only OFFERS (no silent global mutation)',
  );

  // Only an explicit `fleet add` registers it.
  const add = runForge(['fleet', 'add', proj], { env });
  assert.doesNotMatch(
    (add.stdout || '') + (add.stderr || ''),
    /reserved in the command taxonomy but not yet built/i,
    '`fleet add` is a real v0.3 sub-verb (RED until built)',
  );
  const idxAfterAdd = readJson(idx);
  assert.ok(idxAfterAdd && idxAfterAdd.projects && typeof idxAfterAdd.projects === 'object', 'index has a projects map');
  assert.strictEqual(
    Object.keys(idxAfterAdd.projects).length,
    1,
    'explicit `fleet add` registers exactly the one project',
  );
});

// ===========================================================================
// EVAL-FLEET-004 — User edits sacred during sync (merge staged) + grade
// Phase v0.5 (DEFERRED, Tier 3) — RED PLACEHOLDER, NOT gated by this batch.
// Verifies BR-FLEET-020, -013. Kept so the spec is coherent and growable; it
// fails on an assertion (the write/merge surface does not exist) but is not part
// of the Phase-v0.3 acceptance gate.
// ===========================================================================
test('EVAL-FLEET-004 — [v0.5 DEFERRED] user edits sacred during fleet sync (merge staged, not clobbered)', async (t) => {
  const mod = await importFleet();
  // The fleet write/merge surface (`fleet sync <id> --apply`) is a v0.5 deliverable.
  assert.ok(mod, '[v0.5] manager/fleet.mjs must exist (RED placeholder; not gated in v0.3)');
  assert.strictEqual(
    typeof mod.run,
    'function',
    '[v0.5] fleet sync staging is deferred to v0.5 — RED placeholder, not part of the v0.3 gate',
  );
  // Intentionally no further assertions: the merge-staging behavior lands in v0.5.
  assert.fail('[v0.5 DEFERRED] fleet sync 3-way merge staging (BR-FLEET-020) is not built — see SPEC-04 §Bulk remediation');
});

// ===========================================================================
// EVAL-FLEET-013 — fleet sync orchestrates per-project sync; auto-upgrade unedited
// Phase v0.5 (DEFERRED) — RED PLACEHOLDER, NOT gated. Verifies BR-FLEET-018, -019.
// ===========================================================================
test('EVAL-FLEET-013 — [v0.5 DEFERRED] fleet sync orchestrates per-project sync; auto-upgrade unedited', async () => {
  const mod = await importFleet();
  assert.ok(mod, '[v0.5] manager/fleet.mjs must exist (RED placeholder; not gated in v0.3)');
  assert.fail('[v0.5 DEFERRED] fleet sync orchestration over cmdSync (BR-FLEET-018/019) is not built — SPEC-04 §Bulk remediation');
});

// ===========================================================================
// EVAL-FLEET-014 — Added module additive; removed module report-only
// Phase v0.5 (DEFERRED) — RED PLACEHOLDER, NOT gated. Verifies BR-FLEET-021.
// ===========================================================================
test('EVAL-FLEET-014 — [v0.5 DEFERRED] added module additive; removed module report-only', async () => {
  const mod = await importFleet();
  assert.ok(mod, '[v0.5] manager/fleet.mjs must exist (RED placeholder; not gated in v0.3)');
  assert.fail('[v0.5 DEFERRED] added-additive / removed-report-only on fleet sync (BR-FLEET-021) is not built — SPEC-04');
});

// ---------------------------------------------------------------------------
// Result-shape drills — tolerant accessors over the (not-yet-fixed) fleet result
// shape, so the tests pin BEHAVIOR (a per-project health row, the scoped id set)
// without over-constraining the eventual data layout. Each returns null/[] when
// the shape is absent, turning a missing feature into a clean assertion failure.
// ---------------------------------------------------------------------------

/**
 * Drill a per-project health row for `projectDir` out of a fleet run() result.
 * Tolerant of `data.projects` being a map keyed by id, an array of rows, or a
 * single `data.row`/`data.health`. Matches a row to the project by `path`
 * (realpath-equal) or by an `id`/`uid` that encodes the path.
 * @param {any} res @param {string} projectDir
 * @returns {any|null}
 */
function drillRow(res, projectDir) {
  if (!res || typeof res !== 'object') return null;
  const data = res.data;
  const rows = [];
  if (data && typeof data === 'object') {
    if (data.projects && typeof data.projects === 'object') {
      const vals = Array.isArray(data.projects) ? data.projects : Object.values(data.projects);
      for (const v of vals) if (v && typeof v === 'object') rows.push(v);
    }
    if (Array.isArray(data.rows)) for (const v of data.rows) if (v && typeof v === 'object') rows.push(v);
    if (data.row && typeof data.row === 'object') rows.push(data.row);
    // A single-project drift may flatten health onto data directly.
    if (data.health && typeof data.health === 'object') rows.push({ ...data, ...data.health });
    if ('versionBehind' in data || 'componentsBehind' in data) rows.push(data);
  }
  for (const row of rows) {
    if (rowMatchesProject(row, projectDir)) return normalizeRow(row);
  }
  // Single unambiguous row → accept it (single-project query).
  if (rows.length === 1) return normalizeRow(rows[0]);
  return null;
}

/** Flatten a row's nested `health{}` up to the top level for uniform access. */
function normalizeRow(row) {
  if (row && row.health && typeof row.health === 'object') return { ...row, ...row.health };
  return row;
}

/** True when a row's path/id identifies `projectDir`. */
function rowMatchesProject(row, projectDir) {
  if (!row || typeof row !== 'object') return false;
  const want = realpath(projectDir);
  if (typeof row.path === 'string' && realpath(row.path) === want) return true;
  if (typeof row.projectDir === 'string' && realpath(row.projectDir) === want) return true;
  return false;
}

/** Collect the project ids/paths a drift result scoped its output to. */
function driftProjectIds(res) {
  if (!res || typeof res !== 'object' || !res.data || typeof res.data !== 'object') return [];
  const out = [];
  const data = res.data;
  const collect = (v) => {
    if (!v) return;
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'object') {
      if (typeof v.path === 'string') out.push(v.path);
      else if (typeof v.id === 'string') out.push(v.id);
      else if (typeof v.projectDir === 'string') out.push(v.projectDir);
    }
  };
  if (data.projects && typeof data.projects === 'object') {
    if (Array.isArray(data.projects)) data.projects.forEach(collect);
    else for (const [k, v] of Object.entries(data.projects)) { out.push(k); collect(v); }
  }
  if (Array.isArray(data.rows)) data.rows.forEach(collect);
  if (Array.isArray(data.matched)) data.matched.forEach(collect);
  return out;
}

/** True when `id` (a path or an id encoding a path) identifies `projectDir`. */
function sameProject(id, projectDir) {
  if (typeof id !== 'string') return false;
  const want = realpath(projectDir);
  if (realpath(id) === want) return true;
  // id may be sha256(realpath)[:16] (BR-FLEET-008): match by that derivation.
  const wantId = sha256hex(want).slice(0, 16);
  return id === wantId;
}

/** fs.realpathSync that fails open to the input (so a tmp path still compares). */
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
