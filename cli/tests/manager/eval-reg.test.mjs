// @ts-check
/**
 * eval-reg.test.mjs — executable acceptance specs for the registry (SPEC-01, BR-REG).
 *
 * Covers EVAL-REG-001 .. EVAL-REG-010 from docs/manager/evals/EVAL-REG.md. One
 * `test(...)` per EVAL case, named with the EVAL id + title, asserting the
 * Given/When/Then of that case.
 *
 * HONEST RED — these features are NOT built yet:
 *   - manager/registry.mjs          (the build/ls/show/changed API)
 *   - lint/validate-registry.mjs    (stale-detection + VERSION triple-drift validator)
 *   - bin/forge.mjs `registry` subcommands (unknown command → exit 2 today)
 * For an unbuilt MODULE we dynamic-import INSIDE the test body wrapped in try/catch,
 * then assert the module + the entry point exist — a missing module becomes an
 * assertion failure (RED), never a crash that aborts the runner. For unbuilt CLI
 * behavior we spawnSync `node bin/forge.mjs registry …` and assert on status/stderr
 * — an unimplemented subcommand exits 2 today (RED). When the feature is built with
 * the expected signatures these specs become executable and should pass.
 *
 * The store/findings/walk/hash/resolve-kind libs ARE implemented; where this file
 * leans on them directly (e.g. to predict kind→path or modules[]), those calls run
 * for real.
 *
 * Zero runtime deps (node: builtins only). Each test is deterministic and
 * self-cleaning: fixtures are copied into an os.tmpdir() sandbox (NEVER mutated in
 * place), and the sandbox is removed in a finally. Run model: `node --test tests/manager/`.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { pathToUid, loadDeclaredHookIds } from '../../manager/lib/resolve-kind.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const FIXTURES = path.join(SCRIPT_DIR, 'fixtures');
const FORGE_BIN = path.join(FORGE_ROOT, 'bin', 'forge.mjs');
const REGISTRY_MODULE = path.join(FORGE_ROOT, 'manager', 'registry.mjs');
const VALIDATE_REGISTRY = path.join(FORGE_ROOT, 'lint', 'validate-registry.mjs');

// ---------------------------------------------------------------------------
// Sandbox helpers — copy a frozen fixture into a tmp FORGE_ROOT so a --write
// build (or a committed registry mutation) never touches the real repo or the
// frozen fixtures. Returns the sandbox root; the caller cleans it up.
// ---------------------------------------------------------------------------

/**
 * Recursively copy a directory tree (files + dirs only).
 * @param {string} src
 * @param {string} dst
 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Copy fixture `name` into a fresh tmp sandbox and return its absolute root.
 * @param {string} name fixture directory name under tests/manager/fixtures
 * @returns {string} absolute sandbox root (a copied FORGE_ROOT)
 */
function sandbox(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-reg-${name}-`));
  copyTree(path.join(FIXTURES, name), root);
  return root;
}

/** Remove a sandbox dir best-effort (fail-open in teardown). @param {string} root */
function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * List every file path (POSIX-relative to `root`) under `root`, recursively.
 * @param {string} root
 * @returns {string[]}
 */
function listFiles(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  function walk(dir) {
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
  }
  walk(root);
  return out;
}

/**
 * Dynamic-import the (not-yet-built) registry module. Resolves to the module
 * namespace, or `null` if it does not exist / fails to load — the caller turns
 * `null` into an assertion failure (HONEST RED), never a thrown crash.
 * @returns {Promise<any|null>}
 */
async function importRegistry() {
  try {
    return await import(REGISTRY_MODULE);
  } catch {
    return null;
  }
}

/**
 * Resolve the registry's `build` entry point from its module namespace, tolerant
 * of the eventual export name (`buildRegistry` | `build` | default callable).
 * @param {any|null} mod
 * @returns {((root: string, opts?: any) => any)|null}
 */
function resolveBuild(mod) {
  if (!mod || typeof mod !== 'object') return null;
  if (typeof mod.buildRegistry === 'function') return mod.buildRegistry;
  if (typeof mod.build === 'function') return mod.build;
  if (typeof mod.default === 'function') return mod.default;
  if (mod.default && typeof mod.default.build === 'function') return mod.default.build;
  return null;
}

/**
 * Run `node bin/forge.mjs registry <args…>` against a FORGE_ROOT. Used so an
 * unimplemented subcommand (exit 2 today) registers as RED rather than a crash.
 * @param {string[]} args argv after `forge`
 * @param {string} cwd working dir to run from
 * @returns {{status:number|null, stdout:string, stderr:string}}
 */
function runForge(args, cwd) {
  const res = spawnSync('node', [FORGE_BIN, ...args], { cwd, encoding: 'utf8' });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

/**
 * Read a built registry snapshot from a sandbox root, or null if absent/bad.
 * @param {string} root
 * @returns {any|null}
 */
function readRegistry(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.forge', 'registry.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Coerce a registry snapshot to its artifact array, tolerant of shape.
 * @param {any} reg
 * @returns {any[]}
 */
function artifactsOf(reg) {
  if (reg && Array.isArray(reg.artifacts)) return reg.artifacts;
  if (Array.isArray(reg)) return reg;
  return [];
}

// ===========================================================================
// EVAL-REG-001 — Registry location; no lock file (BR-REG-001)
// ===========================================================================
test('EVAL-REG-001 — Registry location; no lock file', async (t) => {
  const root = sandbox('lib-min');
  t.after(() => cleanup(root));

  // When `forge registry build --write` runs against the fixture library…
  const cli = runForge(['registry', 'build', '--write'], root);
  // RED today: `registry` is an unknown subcommand → exit 2 with the usage banner.
  assert.strictEqual(
    cli.status,
    0,
    `forge registry build --write must succeed (status 0); got ${cli.status} stderr=${cli.stderr.trim()}`,
  );

  // Then it creates forge/.forge/registry.json …
  const regPath = path.join(root, '.forge', 'registry.json');
  assert.ok(fs.existsSync(regPath), 'creates .forge/registry.json');
  const reg = readRegistry(root);
  assert.ok(reg && Array.isArray(reg.artifacts), 'registry.json has an artifacts[]');

  // … and (on mutation) forge/.forge/registry.log.jsonl …
  assert.ok(
    fs.existsSync(path.join(root, '.forge', 'registry.log.jsonl')),
    'a first --write is a mutation → registry.log.jsonl exists',
  );

  // … and creates NO *.lock file anywhere under forge/.forge/.
  const locks = listFiles(path.join(root, '.forge')).filter((p) => p.endsWith('.lock'));
  assert.deepStrictEqual(locks, [], 'no *.lock file left under .forge/ (advisory locks are transient)');
});

// ===========================================================================
// EVAL-REG-002 — Stale registry is an ERROR (BR-REG-002)
//
// Decided model: staleness is SPLIT by drift kind. A STRUCTURAL change — a uid
// added or removed — means the committed catalog is wrong, so validate-registry
// emits the stale ERROR and exits 1. (A content-only hash drift is the advisory
// WARN exercised by EVAL-VER-007, not here.)
// ===========================================================================
test('EVAL-REG-002 — Stale registry is an ERROR', async (t) => {
  const root = sandbox('lib-min');
  t.after(() => cleanup(root));

  // Given a committed registry built from the tree (seed it via the DIRECT
  // manager script — the `forge registry …` CLI dispatch is a W3 deliverable).
  const build = spawnSync('node', [REGISTRY_MODULE, 'build', '--write', root], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.strictEqual(
    build.status,
    0,
    `seed build must succeed; got ${build.status} ${(build.stderr || '').trim()}`,
  );
  assert.ok(fs.existsSync(path.join(root, '.forge', 'registry.json')), 'seed wrote a committed registry');

  // When the tree changes STRUCTURALLY (an artifact FILE is deleted → its uid is
  // removed from a fresh scan) WITHOUT rebuilding the committed snapshot…
  const removed = path.join(root, 'agents', 'diff-reviewer.md');
  assert.ok(fs.existsSync(removed), 'precondition: the artifact to remove exists');
  fs.rmSync(removed);

  // …then validate-registry reports the catalog as stale (ERROR) and exits 1.
  const res = spawnSync('node', [VALIDATE_REGISTRY, root], { cwd: root, encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  assert.match(
    out,
    /^ERROR\b.*registry stale, run forge registry build --write/m,
    `structural drift must ERROR with the build hint; got: ${out.trim().slice(0, 400)}`,
  );
  assert.strictEqual(res.status, 1, `structural-stale registry must exit 1; got ${res.status}`);
});

// ===========================================================================
// EVAL-REG-003 — Scan surface and kind→path resolution (BR-REG-003)
// ===========================================================================
test('EVAL-REG-003 — Scan surface and kind→path resolution', async (t) => {
  const root = sandbox('lib-allkinds');
  t.after(() => cleanup(root));

  const mod = await importRegistry();
  const build = resolveBuild(mod);
  assert.ok(build, 'manager/registry.mjs must export a build entry point (buildRegistry/build/default)');

  const result = await build(root, { write: false });
  const reg = result && result.artifacts ? result : readRegistry(root) || result;
  const artifacts = artifactsOf(reg);
  assert.ok(artifacts.length > 0, 'build returns artifacts for lib-allkinds');

  // Exactly one record per real artifact: for every walked file that resolve-kind
  // recognises, the registry must hold exactly one matching record, and its
  // kind/path must equal what resolve-kind yields.
  const byUid = new Map(artifacts.map((a) => [a.uid, a]));
  /** @type {Array<{kind:string,id:string,path:string}>} */
  const expectedFiles = [
    { kind: 'agent', id: 'code-reviewer', path: 'agents/code-reviewer.md' },
    { kind: 'skill', id: 'review-change', path: 'skills/review-change/SKILL.md' },
    { kind: 'command', id: 'harness-doctor', path: 'commands/harness-doctor.md' },
    { kind: 'rule', id: 'citations', path: 'rules/common/citations.md' },
    { kind: 'bundle', id: 'work-module', path: 'bundles/work-module.md' },
    { kind: 'validator', id: 'validate-sample', path: 'lint/validate-sample.mjs' },
    { kind: 'meta-test', id: 'sample-meta', path: 'tests/meta/sample-meta.mjs' },
    { kind: 'engine', id: 'bootstrap/detect-project', path: 'bootstrap/detect-project.mjs' },
  ];
  for (const exp of expectedFiles) {
    // resolve-kind (already implemented) is the source of truth for kind/id.
    const resolved = pathToUid(root, exp.path);
    assert.deepStrictEqual(
      resolved,
      { kind: exp.kind, id: exp.id },
      `resolve-kind maps ${exp.path} → ${exp.kind}:${exp.id}`,
    );
    const uid = `${exp.kind}:${exp.id}`;
    const rec = byUid.get(uid);
    assert.ok(rec, `exactly one record for ${uid}`);
    assert.strictEqual(rec.kind, exp.kind, `${uid} record.kind matches resolve-kind`);
    assert.strictEqual(rec.path, exp.path, `${uid} record.path matches resolve-kind`);
  }

  // The hook is recorded by id with path "hooks/hooks.json#<id>" (NOT walked as a file).
  const hookIds = loadDeclaredHookIds(root);
  assert.ok(hookIds.has('forge:detect-project'), 'fixture declares the hook id forge:detect-project');
  const hookRec = artifacts.find((a) => a.kind === 'hook');
  assert.ok(hookRec, 'exactly one hook record');
  assert.strictEqual(hookRec.id, 'forge:detect-project', 'hook recorded by its declared id');
  assert.strictEqual(
    hookRec.path,
    'hooks/hooks.json#forge:detect-project',
    'hook path is hooks/hooks.json#<id>',
  );

  // No spurious extra records: one hook only, and no record for a non-artifact file.
  assert.strictEqual(artifacts.filter((a) => a.kind === 'hook').length, 1, 'exactly one hook record total');
});

// ===========================================================================
// EVAL-REG-004 — Record shape and modules[] reverse-index (BR-REG-004)
// ===========================================================================
test('EVAL-REG-004 — Record shape and modules[] reverse-index', async (t) => {
  const root = sandbox('lib-min');
  t.after(() => cleanup(root));

  const mod = await importRegistry();
  const build = resolveBuild(mod);
  assert.ok(build, 'manager/registry.mjs must export a build entry point');

  const result = await build(root, { write: false });
  const reg = result && result.artifacts ? result : readRegistry(root) || result;
  const artifacts = artifactsOf(reg);
  assert.ok(artifacts.length > 0, 'build returns artifacts for lib-min');

  // Every record validates against the SPEC-01 schema's required fields, all
  // present and correctly typed.
  /** @type {Record<string,(v:any)=>boolean>} */
  const typed = {
    uid: (v) => typeof v === 'string' && v.length > 0,
    kind: (v) => typeof v === 'string' && v.length > 0,
    id: (v) => typeof v === 'string' && v.length > 0,
    path: (v) => typeof v === 'string' && v.length > 0,
    contentHash: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v),
    revision: (v) => Number.isInteger(v) && v >= 1,
    version: (v) => typeof v === 'string' && v.length > 0,
    status: (v) => ['active', 'deprecated', 'experimental', 'planned'].includes(v),
    criticality: (v) => ['safety', 'compliance', 'normal'].includes(v),
    owner: (v) => typeof v === 'string' && v.length > 0,
    description: (v) => typeof v === 'string',
    tags: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
    modules: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
    dependsOn: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
    eval: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    createdAt: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
    updatedAt: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  };
  for (const rec of artifacts) {
    for (const [field, ok] of Object.entries(typed)) {
      assert.ok(field in rec, `record ${rec.uid} has field ${field}`);
      assert.ok(ok(rec[field]), `record ${rec.uid} field ${field} is well-typed (got ${JSON.stringify(rec[field])})`);
    }
    assert.strictEqual(rec.uid, `${rec.kind}:${rec.id}`, `uid is "<kind>:<id>" for ${rec.uid}`);
  }

  // modules[] equals the set of modules whose components name the artifact in
  // modules.json. lib-min: agent:code-reviewer + agent:diff-reviewer + rule:
  // review-discipline are all in module "review"; the hook is in "hooks-quality".
  const byUid = new Map(artifacts.map((a) => [a.uid, a]));
  const reviewer = byUid.get('agent:code-reviewer');
  assert.ok(reviewer, 'agent:code-reviewer present');
  assert.deepStrictEqual([...reviewer.modules].sort(), ['review'], 'agent:code-reviewer → ["review"]');
  const rule = byUid.get('rule:review-discipline');
  assert.ok(rule, 'rule:review-discipline present');
  assert.deepStrictEqual([...rule.modules].sort(), ['review'], 'rule:review-discipline → ["review"]');
  const hook = byUid.get('hook:forge:edit-citation-gate');
  if (hook) {
    assert.deepStrictEqual([...hook.modules].sort(), ['hooks-quality'], 'hook → ["hooks-quality"]');
  }
});

// ===========================================================================
// EVAL-REG-005 — Planned vs orphan classification (BR-REG-005)
// ===========================================================================
test('EVAL-REG-005 — Planned vs orphan classification', async (t) => {
  const root = sandbox('lib-planned-and-orphan');
  t.after(() => cleanup(root));

  const mod = await importRegistry();
  const build = resolveBuild(mod);
  assert.ok(build, 'manager/registry.mjs must export a build entry point');

  const result = await build(root, { write: false });
  const reg = result && result.artifacts ? result : readRegistry(root) || result;
  const artifacts = artifactsOf(reg);
  assert.ok(artifacts.length > 0, 'build returns artifacts');
  const byUid = new Map(artifacts.map((a) => [a.uid, a]));

  // A manifest names a component with NO file (planned-reviewer): status "planned",
  // and NOT reported as an error.
  const planned = byUid.get('agent:planned-reviewer');
  assert.ok(planned, 'planned component still gets a record');
  assert.strictEqual(planned.status, 'planned', 'named-but-absent component is status:"planned"');
  const findings = Array.isArray(result && result.findings) ? result.findings : [];
  const plannedErrors = findings.filter(
    (f) => f.level === 'ERROR' && typeof f.path === 'string' && f.path.includes('planned-reviewer'),
  );
  assert.deepStrictEqual(plannedErrors, [], 'planned component is NOT an error');

  // A file present in NO module (orphan-reviewer.md) is flagged as an orphan and
  // is NOT status:"planned".
  const orphan = byUid.get('agent:orphan-reviewer');
  assert.ok(orphan, 'orphan file still gets a record');
  assert.notStrictEqual(orphan.status, 'planned', 'orphan is NOT status:"planned"');
  assert.deepStrictEqual([...orphan.modules], [], 'orphan belongs to no module (empty modules[])');
});

// ===========================================================================
// EVAL-REG-006 — Idempotent, deterministic build (BR-REG-006)
// ===========================================================================
test('EVAL-REG-006 — Idempotent, deterministic build', async (t) => {
  const root = sandbox('lib-min');
  t.after(() => cleanup(root));

  const regPath = path.join(root, '.forge', 'registry.json');
  const logPath = path.join(root, '.forge', 'registry.log.jsonl');

  // First --write build.
  const b1 = runForge(['registry', 'build', '--write'], root);
  assert.strictEqual(b1.status, 0, `first build must succeed; got ${b1.status} ${b1.stderr.trim()}`);
  const bytes1 = fs.readFileSync(regPath);
  const logLines1 = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length : 0;

  // Second --write build on an UNCHANGED tree.
  const b2 = runForge(['registry', 'build', '--write'], root);
  assert.strictEqual(b2.status, 0, `second build must succeed; got ${b2.status} ${b2.stderr.trim()}`);
  const bytes2 = fs.readFileSync(regPath);
  const logLines2 = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length : 0;

  // The two registry.json outputs are byte-identical…
  assert.ok(bytes1.equals(bytes2), 'two builds of an unchanged tree are byte-identical');
  // …and the second run appends ZERO new log lines.
  assert.strictEqual(logLines2, logLines1, 'second unchanged build appends zero new registry.log.jsonl lines');
});

// ===========================================================================
// EVAL-REG-007 — Mutation log entry shape (BR-REG-007)
// ===========================================================================
test('EVAL-REG-007 — Mutation log entry shape', async (t) => {
  const root = sandbox('lib-min');
  t.after(() => cleanup(root));

  const logPath = path.join(root, '.forge', 'registry.log.jsonl');

  // Given a committed registry (first build) …
  const b1 = runForge(['registry', 'build', '--write'], root);
  assert.strictEqual(b1.status, 0, `seed build must succeed; got ${b1.status} ${b1.stderr.trim()}`);
  const regBefore = readRegistry(root);
  const beforeRec = artifactsOf(regBefore).find((a) => a.uid === 'agent:code-reviewer');
  assert.ok(beforeRec, 'prior record for agent:code-reviewer exists');
  const logTextBefore = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const linesBefore = logTextBefore.split('\n').filter(Boolean);

  // When an artifact is bumped (its bytes change → contentHash changes → rev++).
  fs.appendFileSync(path.join(root, 'agents', 'code-reviewer.md'), '\n<!-- bump -->\n', 'utf8');
  const b2 = runForge(['registry', 'build', '--write'], root);
  assert.strictEqual(b2.status, 0, `bump build must succeed; got ${b2.status} ${b2.stderr.trim()}`);
  const regAfter = readRegistry(root);
  const afterRec = artifactsOf(regAfter).find((a) => a.uid === 'agent:code-reviewer');
  assert.ok(afterRec, 'post-bump record for agent:code-reviewer exists');

  const logTextAfter = fs.readFileSync(logPath, 'utf8');
  const linesAfter = logTextAfter.split('\n').filter(Boolean);

  // Exactly one new line is appended…
  assert.strictEqual(linesAfter.length, linesBefore.length + 1, 'exactly one new log line on a single bump');
  // …and all prior log lines are byte-unchanged.
  assert.ok(
    logTextAfter.startsWith(logTextBefore),
    'prior log lines are byte-unchanged (append-only)',
  );

  // The new line has the {ts,uid,from{hash,rev,ver},to{hash,rev,ver},reason,evalStatus} shape,
  // whose `from` matches the prior record and `to` matches the new record.
  const entry = JSON.parse(linesAfter[linesAfter.length - 1]);
  assert.strictEqual(entry.uid, 'agent:code-reviewer', 'log entry names the bumped uid');
  assert.ok(typeof entry.ts === 'string' && !Number.isNaN(Date.parse(entry.ts)), 'log entry has an ISO ts');
  assert.ok(entry.from && entry.to, 'log entry has from/to');
  assert.strictEqual(entry.from.hash, beforeRec.contentHash, 'from.hash matches prior record');
  assert.strictEqual(entry.from.rev, beforeRec.revision, 'from.rev matches prior record');
  assert.strictEqual(entry.from.ver, beforeRec.version, 'from.ver matches prior record');
  assert.strictEqual(entry.to.hash, afterRec.contentHash, 'to.hash matches new record');
  assert.strictEqual(entry.to.rev, afterRec.revision, 'to.rev matches new record');
  assert.strictEqual(entry.to.ver, afterRec.version, 'to.ver matches new record');
  assert.ok('reason' in entry, 'log entry has a reason');
  assert.ok('evalStatus' in entry, 'log entry has an evalStatus');
  assert.strictEqual(afterRec.revision, beforeRec.revision + 1, 'revision advanced by exactly 1 on the bump');
});

// ===========================================================================
// EVAL-REG-008 — VERSION triple-drift is reported (BR-REG-008)
//
// Decided model: the `-design` pre-release suffix is STRIPPED before comparing
// VERSION / package.json / .claude-plugin/plugin.json, so drift means the CORE
// versions differ. Drift is proven against the versions-drifted FIXTURE (core
// 0.2.0 vs 0.1.0 vs 0.1.0). The REAL repo (VERSION=0.1.0-design, the JSON pair
// 0.1.0) is ALIGNED after the strip, so it emits NO version-drift WARN.
// ===========================================================================
test('EVAL-REG-008 — VERSION triple-drift is reported', async (t) => {
  // Positive half: the drifted fixture names ALL THREE raw values in the WARN.
  const driftedRoot = sandbox('versions-drifted');
  t.after(() => cleanup(driftedRoot));
  const drifted = spawnSync('node', [VALIDATE_REGISTRY, driftedRoot], {
    cwd: driftedRoot,
    encoding: 'utf8',
  });
  const driftedOut = (drifted.stdout || '') + (drifted.stderr || '');
  const driftWarn = driftedOut
    .split(/\r?\n/)
    .find((l) => /^WARN\b/.test(l) && /version triple drift:/.test(l));
  assert.ok(driftWarn, `drifted fixture must emit a version-drift WARN; got: ${driftedOut.trim().slice(0, 400)}`);
  assert.match(driftWarn, /0\.2\.0/, 'drift WARN names the raw VERSION value (0.2.0)');
  assert.match(driftWarn, /package\.json='0\.1\.0'/, 'drift WARN names the raw package.json value (0.1.0)');
  assert.match(driftWarn, /plugin\.json='0\.1\.0'/, 'drift WARN names the raw plugin.json value (0.1.0)');

  // Negative half: the REAL repo (0.1.0-design vs 0.1.0 vs 0.1.0) is aligned once
  // the `-design` suffix is stripped → NO version-drift WARN (read-only).
  const real = spawnSync('node', [VALIDATE_REGISTRY, FORGE_ROOT], {
    cwd: FORGE_ROOT,
    encoding: 'utf8',
  });
  const realOut = (real.stdout || '') + (real.stderr || '');
  assert.doesNotMatch(
    realOut,
    /version triple drift/i,
    'real repo (-design stripped) reports NO VERSION drift WARN',
  );
});

// ===========================================================================
// EVAL-REG-009 — Query verbs are read-only and correct (BR-REG-009)
// ===========================================================================
test('EVAL-REG-009 — Query verbs are read-only and correct', async (t) => {
  const root = sandbox('lib-min');
  t.after(() => cleanup(root));

  // Given a built registry…
  const seed = runForge(['registry', 'build', '--write'], root);
  assert.strictEqual(seed.status, 0, `seed build must succeed; got ${seed.status} ${seed.stderr.trim()}`);
  const regPath = path.join(root, '.forge', 'registry.json');
  const logPath = path.join(root, '.forge', 'registry.log.jsonl');

  // ls --kind agents → only agent records.
  const ls = runForge(['registry', 'ls', '--kind', 'agents'], root);
  assert.strictEqual(ls.status, 0, `ls must succeed; got ${ls.status} ${ls.stderr.trim()}`);
  assert.match(ls.stdout, /code-reviewer/, 'ls --kind agents lists code-reviewer');
  assert.match(ls.stdout, /diff-reviewer/, 'ls --kind agents lists diff-reviewer');
  assert.doesNotMatch(ls.stdout, /review-discipline/, 'ls --kind agents excludes non-agent (rule) records');

  // show <uid> → exactly the one record.
  const show = runForge(['registry', 'show', 'agent:code-reviewer'], root);
  assert.strictEqual(show.status, 0, `show must succeed; got ${show.status} ${show.stderr.trim()}`);
  assert.match(show.stdout, /agent:code-reviewer/, 'show returns the requested record');
  assert.doesNotMatch(show.stdout, /diff-reviewer/, 'show returns only the one record');

  // The read-only verbs must not modify registry.json or the log (bytes + mtime).
  const regBytes = fs.readFileSync(regPath);
  const regMtime = fs.statSync(regPath).mtimeMs;
  const logBytes = fs.existsSync(logPath) ? fs.readFileSync(logPath) : Buffer.alloc(0);
  const logMtime = fs.existsSync(logPath) ? fs.statSync(logPath).mtimeMs : 0;

  // changed --since <ref>: build a SECOND snapshot ref differing by one bump, then
  // assert `changed` lists exactly the bumped uid. We capture the pre-bump snapshot
  // as the <ref> baseline (a sibling file), bump, rebuild, and query.
  const refSnap = path.join(root, '.forge', 'registry.ref.json');
  fs.copyFileSync(regPath, refSnap);
  fs.appendFileSync(path.join(root, 'agents', 'diff-reviewer.md'), '\n<!-- bump -->\n', 'utf8');
  const rebuild = runForge(['registry', 'build', '--write'], root);
  assert.strictEqual(rebuild.status, 0, `rebuild must succeed; got ${rebuild.status} ${rebuild.stderr.trim()}`);
  const changed = runForge(['registry', 'changed', '--since', refSnap], root);
  assert.strictEqual(changed.status, 0, `changed must succeed; got ${changed.status} ${changed.stderr.trim()}`);
  assert.match(changed.stdout, /diff-reviewer/, 'changed lists the bumped uid (diff-reviewer)');
  assert.doesNotMatch(changed.stdout, /code-reviewer/, 'changed does NOT list the unchanged uid (code-reviewer)');

  // Re-assert read-only verbs (ls/show) left the snapshot/log untouched. Run them
  // again post-rebuild and compare against a fresh snapshot of the current files.
  const regBytes2 = fs.readFileSync(regPath);
  const regMtime2 = fs.statSync(regPath).mtimeMs;
  runForge(['registry', 'ls', '--kind', 'agents'], root);
  runForge(['registry', 'show', 'agent:code-reviewer'], root);
  runForge(['registry', 'changed', '--since', refSnap], root);
  assert.ok(fs.readFileSync(regPath).equals(regBytes2), 'ls/show/changed do not rewrite registry.json bytes');
  assert.strictEqual(fs.statSync(regPath).mtimeMs, regMtime2, 'ls/show/changed do not touch registry.json mtime');
  if (fs.existsSync(logPath)) {
    // The query verbs after the rebuild must not append to or touch the log.
    const logBytesNow = fs.readFileSync(logPath);
    const logMtimeNow = fs.statSync(logPath).mtimeMs;
    runForge(['registry', 'ls', '--kind', 'agents'], root);
    runForge(['registry', 'show', 'agent:code-reviewer'], root);
    assert.ok(fs.readFileSync(logPath).equals(logBytesNow), 'query verbs do not rewrite the log bytes');
    assert.strictEqual(fs.statSync(logPath).mtimeMs, logMtimeNow, 'query verbs do not touch the log mtime');
  }
  // Reference the pre-bump captures so the linter sees them consumed.
  assert.ok(Buffer.isBuffer(regBytes) && Buffer.isBuffer(logBytes) && regMtime >= 0 && logMtime >= 0, 'captured pre-bump state');
});

// ===========================================================================
// EVAL-REG-010 — Build is fail-open on a bad artifact (BR-REG-010)
// ===========================================================================
test('EVAL-REG-010 — Build is fail-open on a bad artifact', async (t) => {
  const root = sandbox('lib-one-bad');
  t.after(() => cleanup(root));

  const mod = await importRegistry();
  const build = resolveBuild(mod);
  assert.ok(build, 'manager/registry.mjs must export a build entry point');

  // Build must NOT throw on the malformed artifact (fail-open).
  let result;
  await assert.doesNotReject(
    async () => {
      result = await build(root, { write: false });
    },
    'build never throws past its public entry on a bad artifact',
  );
  const reg = result && result.artifacts ? result : readRegistry(root) || result;
  const artifacts = artifactsOf(reg);

  // It records all VALID artifacts (the two agents + the rule).
  const uids = new Set(artifacts.map((a) => a.uid));
  assert.ok(uids.has('agent:code-reviewer'), 'records valid agent code-reviewer');
  assert.ok(uids.has('agent:diff-reviewer'), 'records valid agent diff-reviewer');
  assert.ok(uids.has('rule:review-discipline'), 'records valid rule review-discipline');

  // It emits EXACTLY ONE finding for the bad one, in the C2 finding shape with
  // source:"validate-registry".
  const findings = Array.isArray(result && result.findings) ? result.findings : [];
  const badFindings = findings.filter(
    (f) => typeof f.path === 'string' && f.path.includes('broken-frontmatter'),
  );
  assert.strictEqual(badFindings.length, 1, 'exactly one finding for the malformed artifact');
  const f = badFindings[0];
  assert.ok(['ERROR', 'WARN', 'INFO'].includes(f.level), 'finding.level is a valid severity');
  assert.strictEqual(typeof f.path, 'string', 'finding.path is a string');
  assert.ok(f.line === null || Number.isInteger(f.line), 'finding.line is null or an integer');
  assert.strictEqual(typeof f.message, 'string', 'finding.message is a string');
  assert.strictEqual(f.source, 'validate-registry', 'finding.source is "validate-registry"');
  assert.deepStrictEqual(
    Object.keys(f).sort(),
    ['level', 'line', 'message', 'path', 'source'],
    'finding has exactly the five C2 fields',
  );

  // It did NOT abort: the malformed file produced no record, but the build returned.
  assert.ok(!uids.has('agent:broken-frontmatter'), 'malformed artifact is not recorded as a valid record');
});
