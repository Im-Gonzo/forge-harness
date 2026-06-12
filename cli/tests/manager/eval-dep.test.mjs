// @ts-check
/**
 * eval-dep.test.mjs — executable acceptance specs for the typed dependency graph
 * and prose-ref resolution (SPEC-03, BR-DEP-001..007).
 *
 * Covers EVAL-DEP-001 .. EVAL-DEP-006 from docs/manager/evals/EVAL-DEP.md. One
 * `test(...)` per EVAL case, named with the EVAL id + title, asserting the
 * Given/When/Then of that case. All cases are tagged Phase v0.3 and gated here.
 *
 * SHIPPED GREEN — the v0.3 dependency-graph feature is built: `buildRegistry()`
 * populates each record's `dependsOn[]` and the registry `danglingRefs[]`; the dual-mode
 * `registry` script exposes the deps/rdeps/orphans/dangling verbs; and validate-registry
 * scans prose refs. The original `react-reviewer` headline regression has since been FIXED
 * (the real prose handoff was redirected to existing reviewers), so EVAL-DEP-001 now plants
 * a SYNTHETIC dangling reviewer in `fixtures/dangling-ref/` to keep the detection capability
 * under test while ALSO asserting the real repo is clean. Each case asserts the v0.3
 * behaviour via:
 *   - For the PURE graph (dangling/dependsOn) we `import()` `buildRegistry` INSIDE the
 *     test body (wrapped so a missing module becomes an assertion, never a thrown
 *     crash that aborts the runner) and assert on the returned object.
 *   - For the QUERY verbs we `spawnSync` `node manager/registry.mjs <verb> <root>` (a
 *     dual-mode, isMain-guarded script) and assert on status/stdout.
 *   - For the WARN/ERROR severity gate and the validate-xref CONTROL we `spawnSync`
 *     the validators. We NEVER `import()` a validator: lint/validate-registry.mjs and
 *     lint/validate-xref.mjs call `process.exit()` at module-evaluation time, which
 *     would silently kill the node:test runner (the v0.2 isMain defect). spawnSync is
 *     the only safe way to drive them.
 *
 * The store/findings/walk/hash/resolve-kind/frontmatter libs and `buildRegistry`'s
 * scan ARE implemented; where this file leans on them (predicting uids, building the
 * record set) those calls run for real.
 *
 * Zero runtime deps (node: builtins only). Each test is deterministic and
 * self-cleaning: graph fixtures are copied into an os.tmpdir() sandbox (NEVER mutated
 * in place); the real repo is only ever READ (EVAL-DEP-001/006). Run model:
 * `node --test tests/manager/`.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const FIXTURES = path.join(SCRIPT_DIR, 'fixtures');
const REGISTRY_MODULE = path.join(FORGE_ROOT, 'manager', 'registry.mjs');
const VALIDATE_REGISTRY = path.join(FORGE_ROOT, 'lint', 'validate-registry.mjs');
const VALIDATE_XREF = path.join(FORGE_ROOT, 'lint', 'validate-xref.mjs');

// ---------------------------------------------------------------------------
// Sandbox helpers — copy a frozen fixture into a tmp FORGE_ROOT so a build (or a
// committed-registry mutation) never touches the real repo or the frozen
// fixtures. Returns the ABSOLUTE sandbox root (the module reverse-index resolves
// components only under an absolute root); the caller cleans it up.
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
 * @param {string} name fixture directory under tests/manager/fixtures
 * @returns {string} absolute sandbox root (a copied FORGE_ROOT)
 */
function sandbox(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-dep-${name}-`));
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
 * Dynamic-import the registry module and resolve `buildRegistry`. Returns null
 * (never throws) when the module or the export is missing — the caller turns null
 * into an assertion failure (HONEST RED), never a crash that aborts the runner.
 *
 * SAFE because registry.mjs guards its direct-execution block behind `isMain()` and
 * never calls process.exit() at import time. We do NOT import the validators (they
 * DO exit at import) — those are driven via spawnSync only.
 * @returns {Promise<((root:string, prior?:any)=>any)|null>}
 */
async function importBuildRegistry() {
  try {
    const mod = await import(REGISTRY_MODULE);
    if (mod && typeof mod.buildRegistry === 'function') return mod.buildRegistry;
    if (mod && mod.default && typeof mod.default.buildRegistry === 'function') {
      return mod.default.buildRegistry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run the dual-mode registry script: `node manager/registry.mjs <args…>`. The
 * trailing positional is the rootDir the script scans. Used so an unbuilt graph
 * verb (exit 1 today) registers as RED rather than crashing the runner.
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {{status:number|null, stdout:string, stderr:string}}
 */
function runRegistryScript(args, cwd = FORGE_ROOT) {
  const res = spawnSync(process.execPath, [REGISTRY_MODULE, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/**
 * Run a validator script: `node lint/<validator>.mjs [--strict] <root>`. spawnSync
 * ONLY — these scripts process.exit() at import, so they must never be import()ed.
 * @param {string} validatorPath
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{status:number|null, out:string}}
 */
function runValidator(validatorPath, args, cwd) {
  const res = spawnSync(process.execPath, [validatorPath, ...args], { cwd, encoding: 'utf8' });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

/**
 * Read a committed registry snapshot from a sandbox root, or null if absent/bad.
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
 * Coerce a build result OR a snapshot to its danglingRefs[] (tolerant of shape).
 * @param {any} reg
 * @returns {any[]}
 */
function danglingOf(reg) {
  if (reg && Array.isArray(reg.danglingRefs)) return reg.danglingRefs;
  return [];
}

/**
 * Find the record for a uid in a build result / snapshot.
 * @param {any} reg @param {string} uid
 * @returns {any|null}
 */
function recordOf(reg, uid) {
  const arr = reg && Array.isArray(reg.artifacts) ? reg.artifacts : [];
  return arr.find((a) => a && a.uid === uid) || null;
}

/**
 * Seed a committed registry into a sandbox via the dual-mode build script so the
 * read-only query verbs (deps/rdeps/orphans/dangling) and validate-registry have a
 * `.forge/registry.json` to read.
 * @param {string} root
 */
function seedRegistry(root) {
  return runRegistryScript(['build', '--write', root], root);
}

// ===========================================================================
// EVAL-DEP-001 — a planted dangling reviewer is reported, and the REAL repo is clean
//
// Verifies BR-DEP-002/003/004. The original headline regression (the real
// `react-reviewer` prose handoff in agents/typescript-reviewer.md + react-patterns.md)
// has been FIXED by redirecting that handoff to existing reviewers, so the real repo
// must now report ZERO dangling refs. To keep the DETECTION capability under test
// without re-introducing the real defect, this case plants a synthetic dangling ref in
// a frozen fixture (`fixtures/dangling-ref/`: one agent whose prose handoff routes to a
// non-existent `ghost-reviewer`) and asserts the graph reports it; a CONTROL confirms
// `validate-xref` alone does NOT see the bare-name ref (proving the prose-ref upgrade is
// load-bearing); and a final assertion proves the redirect worked (real repo clean).
// ===========================================================================
test('EVAL-DEP-001 — planted dangling reviewer is reported; the real repo is clean', async (t) => {
  // --- Part A: the PLANTED dangling ref on the synthetic fixture --------------
  // Preconditions on the frozen fixture: the referrer exists and there is no
  // ghost-reviewer agent file (so the <x>-reviewer prose ref must dangle).
  const fixtureRoot = path.join(FIXTURES, 'dangling-ref');
  assert.ok(
    fs.existsSync(path.join(fixtureRoot, 'agents', 'planted-reviewer.md')),
    'precondition: fixtures/dangling-ref/agents/planted-reviewer.md exists',
  );
  assert.ok(
    !fs.existsSync(path.join(fixtureRoot, 'agents', 'ghost-reviewer.md')),
    'precondition: there is NO agents/ghost-reviewer.md in the fixture (so the ref must dangle)',
  );

  // CONTROL: validate-xref alone does NOT report the bare-name ghost-reviewer. It only
  // matches the literal `agents/<x>.md` path form, never the backticked bare name —
  // that blind spot is exactly what BR-DEP-002 closes. spawnSync ONLY (validate-xref
  // process.exit()s at import).
  const xref = runValidator(VALIDATE_XREF, [fixtureRoot], fixtureRoot);
  assert.doesNotMatch(
    xref.out,
    /ghost-reviewer/,
    'CONTROL: validate-xref does NOT report ghost-reviewer (so the graph upgrade is load-bearing)',
  );

  // Build the registry over a sandbox COPY of the fixture (never mutated in place) and
  // assert the recorded dangling entry.
  const root = sandbox('dangling-ref');
  t.after(() => cleanup(root));
  const buildRegistry = await importBuildRegistry();
  assert.ok(buildRegistry, 'manager/registry.mjs must export buildRegistry');
  const reg = buildRegistry(root);

  const dangling = danglingOf(reg);
  const entry = dangling.find((d) => d && d.rawRef === 'ghost-reviewer');
  assert.ok(
    entry,
    `danglingRefs[] must contain a ghost-reviewer entry; got ${JSON.stringify(dangling)}`,
  );

  // `from` is the planted-reviewer agent uid (the agent that makes the prose ref).
  assert.strictEqual(
    entry.from,
    'agent:planted-reviewer',
    'dangling.from is the planted-reviewer agent uid',
  );

  // sites[] reference the fixture agent file.
  const sitePaths = Array.isArray(entry.sites) ? entry.sites.map((s) => s && s.path) : [];
  assert.ok(
    sitePaths.some((p) => typeof p === 'string' && p.includes('agents/planted-reviewer.md')),
    `sites[] references agents/planted-reviewer.md; got ${JSON.stringify(sitePaths)}`,
  );

  // Exactly ONE consolidated entry for ghost-reviewer (every site collapses into one
  // dangling ref keyed by rawRef, not several separate entries).
  assert.strictEqual(
    dangling.filter((d) => d && d.rawRef === 'ghost-reviewer').length,
    1,
    'exactly one consolidated ghost-reviewer dangling entry (all sites under one entry)',
  );

  // --- Part B: the redirect worked — the REAL repo reports ZERO dangling refs -
  // The two files that used to carry the real `react-reviewer` handoff still exist, but
  // their prose now routes to existing reviewers. A fresh build over the real tree must
  // therefore record NO danglingRefs[] at all (read-only; the real repo is never mutated).
  assert.ok(
    fs.existsSync(path.join(FORGE_ROOT, 'agents', 'typescript-reviewer.md')),
    'precondition: agents/typescript-reviewer.md exists',
  );
  assert.ok(
    fs.existsSync(path.join(FORGE_ROOT, 'rules', 'typescript', 'react-patterns.md')),
    'precondition: rules/typescript/react-patterns.md exists',
  );
  const realReg = buildRegistry(FORGE_ROOT);
  const realDangling = danglingOf(realReg);
  assert.deepStrictEqual(
    realDangling,
    [],
    `the real repo must report ZERO dangling refs after the redirect; got ${JSON.stringify(realDangling)}`,
  );
});

// ===========================================================================
// EVAL-DEP-002 — Typed edges with correct type and source (BR-DEP-001)
//
// graph-alltypes exercises each edge type. The build must yield each expected edge
// with the right `type` and `source` (frontmatter|prose|manifest) and the source
// artifact's dependsOn[] must list the resolved target uids. RED today: dependsOn[]
// is always [] and there is no edge surface.
// ===========================================================================
test('EVAL-DEP-002 — Typed edges with correct type and source', async (t) => {
  const root = sandbox('graph-alltypes');
  t.after(() => cleanup(root));

  const buildRegistry = await importBuildRegistry();
  assert.ok(buildRegistry, 'manager/registry.mjs must export buildRegistry');
  const reg = buildRegistry(root);
  assert.ok(reg && Array.isArray(reg.artifacts) && reg.artifacts.length > 0, 'build returns artifacts');

  // dependsOn[] is the resolved-outbound projection of the edges (SPEC-03 / BR-DEP-001).
  // Assert the resolved targets per source artifact; these are RED ([] today).
  const bundle = recordOf(reg, 'bundle:eval-judge');
  assert.ok(bundle, 'bundle:eval-judge present');
  const bundleDeps = Array.isArray(bundle.dependsOn) ? bundle.dependsOn : [];
  // uses-skill, uses-agent, uses-reviewer frontmatter pointers all resolve.
  assert.ok(bundleDeps.includes('skill:run-eval'), `bundle dependsOn includes skill:run-eval (uses-skill); got ${JSON.stringify(bundleDeps)}`);
  assert.ok(bundleDeps.includes('agent:graph-reviewer'), `bundle dependsOn includes agent:graph-reviewer (uses-agent); got ${JSON.stringify(bundleDeps)}`);
  assert.ok(bundleDeps.includes('agent:secondary-reviewer'), `bundle dependsOn includes agent:secondary-reviewer (uses-reviewer); got ${JSON.stringify(bundleDeps)}`);

  // The agent routes-to (prose) the secondary reviewer and references the rule.
  const agent = recordOf(reg, 'agent:graph-reviewer');
  assert.ok(agent, 'agent:graph-reviewer present');
  const agentDeps = Array.isArray(agent.dependsOn) ? agent.dependsOn : [];
  assert.ok(agentDeps.includes('agent:secondary-reviewer'), `agent dependsOn includes agent:secondary-reviewer (routes-to, prose); got ${JSON.stringify(agentDeps)}`);
  assert.ok(agentDeps.includes('rule:citation-rule'), `agent dependsOn includes rule:citation-rule (applies-rule/references); got ${JSON.stringify(agentDeps)}`);

  // If the build additionally exposes an edge list, assert the typed-edge shape:
  // each edge has {from,to,type,source} and the expected (type,source) pairs are
  // present. This is OPTIONAL surface — when absent the dependsOn assertions above
  // already gate BR-DEP-001; when present we pin type+source provenance.
  const edges = Array.isArray(reg.edges) ? reg.edges : null;
  if (edges) {
    const hasEdge = (from, to, type, source) =>
      edges.some(
        (e) => e && e.from === from && e.to === to && e.type === type && e.source === source,
      );
    assert.ok(hasEdge('bundle:eval-judge', 'skill:run-eval', 'uses-skill', 'frontmatter'), 'uses-skill edge (frontmatter)');
    assert.ok(hasEdge('bundle:eval-judge', 'agent:graph-reviewer', 'uses-agent', 'frontmatter'), 'uses-agent edge (frontmatter)');
    assert.ok(hasEdge('bundle:eval-judge', 'agent:secondary-reviewer', 'uses-reviewer', 'frontmatter'), 'uses-reviewer edge (frontmatter)');
    assert.ok(hasEdge('agent:graph-reviewer', 'agent:secondary-reviewer', 'routes-to', 'prose'), 'routes-to edge (prose)');
    // member-of (manifest) for a module-named component.
    assert.ok(
      edges.some((e) => e && e.from === 'bundle:eval-judge' && e.type === 'member-of' && e.source === 'manifest'),
      'member-of edge (manifest)',
    );
    // selects (manifest) profile->module.
    assert.ok(
      edges.some((e) => e && e.type === 'selects' && e.source === 'manifest'),
      'selects edge (manifest)',
    );
  }
});

// ===========================================================================
// EVAL-DEP-003 — Dangling ref WARN by default, ERROR under --strict (BR-DEP-003)
//
// graph-dangling has one agent with a prose ref to a non-existent foo-reviewer.
// validate-registry: WARN (exit 0 for that finding) by default; ERROR (exit 1)
// under --strict. The danglingRefs[] entry carries from/rawRef/refKind/sites[].
// validators are driven by spawnSync ONLY (they process.exit() at import).
// ===========================================================================
test('EVAL-DEP-003 — Dangling ref WARN by default, ERROR under --strict', async (t) => {
  const root = sandbox('graph-dangling');
  t.after(() => cleanup(root));

  // Seed a committed registry so validate-registry has a snapshot to read.
  const seed = seedRegistry(root);
  assert.strictEqual(seed.status, 0, `seed build must succeed; got ${seed.status} ${seed.stderr.trim()}`);

  // --- Severity gate (RED today: validate-registry does not scan prose refs). ---
  // Default: the dangling foo-reviewer is a WARN, NOT an ERROR → exit 0.
  const def = runValidator(VALIDATE_REGISTRY, [root], root);
  assert.match(
    def.out,
    /^WARN\b.*foo-reviewer/m,
    `default run must WARN about the dangling foo-reviewer; got: ${def.out.trim().slice(0, 400)}`,
  );
  assert.doesNotMatch(
    def.out,
    /^ERROR\b.*foo-reviewer/m,
    'default run must NOT ERROR on the dangling ref',
  );
  assert.strictEqual(def.status, 0, `dangling ref is advisory by default → exit 0; got ${def.status}`);

  // --strict: the SAME ref becomes an ERROR → exit 1.
  const strict = runValidator(VALIDATE_REGISTRY, ['--strict', root], root);
  assert.match(
    strict.out,
    /foo-reviewer/,
    `--strict run still names the dangling foo-reviewer; got: ${strict.out.trim().slice(0, 400)}`,
  );
  assert.strictEqual(strict.status, 1, `under --strict the dangling ref ERRORs → exit 1; got ${strict.status}`);

  // --- danglingRefs[] entry shape (from/rawRef/refKind/sites[]{path,line}). ---
  const buildRegistry = await importBuildRegistry();
  assert.ok(buildRegistry, 'manager/registry.mjs must export buildRegistry');
  const reg = buildRegistry(root);
  const entry = danglingOf(reg).find((d) => d && d.rawRef === 'foo-reviewer');
  assert.ok(entry, `danglingRefs[] contains a foo-reviewer entry; got ${JSON.stringify(danglingOf(reg))}`);
  assert.strictEqual(entry.from, 'agent:source-reviewer', 'entry.from is the referencing agent uid');
  assert.strictEqual(typeof entry.refKind, 'string', 'entry.refKind is a string');
  assert.ok(Array.isArray(entry.sites) && entry.sites.length >= 1, 'entry.sites[] is a non-empty array');
  for (const s of entry.sites) {
    assert.strictEqual(typeof s.path, 'string', 'site.path is a string');
    assert.ok(s.line === null || Number.isInteger(s.line), 'site.line is null or an integer');
  }
  assert.ok(
    entry.sites.some((s) => typeof s.path === 'string' && s.path.includes('agents/source-reviewer.md')),
    'a site points at agents/source-reviewer.md',
  );
});

// ===========================================================================
// EVAL-DEP-004 — `rdeps` computes the blast radius (BR-DEP-005)
//
// graph-rdeps: B and C each route-to A. `registry rdeps a-reviewer` returns exactly
// {b-reviewer, c-reviewer}; `registry deps b-reviewer` returns the targets B points
// at (a-reviewer); neither writes registry.json. RED today: the dual-mode script has
// no deps/rdeps verb (exit 1).
// ===========================================================================
test('EVAL-DEP-004 — rdeps computes the blast radius', async (t) => {
  const root = sandbox('graph-rdeps');
  t.after(() => cleanup(root));

  // Seed a committed registry so the read-only verbs have a snapshot to read.
  const seed = seedRegistry(root);
  assert.strictEqual(seed.status, 0, `seed build must succeed; got ${seed.status} ${seed.stderr.trim()}`);

  const regPath = path.join(root, '.forge', 'registry.json');
  const bytesBefore = fs.readFileSync(regPath);
  const mtimeBefore = fs.statSync(regPath).mtimeMs;

  // rdeps a-reviewer → exactly {b-reviewer, c-reviewer} (the blast radius).
  const rdeps = runRegistryScript(['rdeps', 'agent:a-reviewer', root], root);
  assert.strictEqual(rdeps.status, 0, `rdeps must succeed (status 0); got ${rdeps.status} ${rdeps.stderr.trim()}`);
  assert.match(rdeps.stdout, /b-reviewer/, 'rdeps a-reviewer lists b-reviewer');
  assert.match(rdeps.stdout, /c-reviewer/, 'rdeps a-reviewer lists c-reviewer');
  // a-reviewer itself is NOT a reverse-dependent of itself.
  assert.doesNotMatch(rdeps.stdout, /^agent:a-reviewer$/m, 'rdeps a-reviewer does not list a-reviewer itself');

  // deps b-reviewer → the targets B points at (a-reviewer).
  const deps = runRegistryScript(['deps', 'agent:b-reviewer', root], root);
  assert.strictEqual(deps.status, 0, `deps must succeed (status 0); got ${deps.status} ${deps.stderr.trim()}`);
  assert.match(deps.stdout, /a-reviewer/, 'deps b-reviewer lists a-reviewer (its outbound target)');

  // Neither verb wrote registry.json (bytes + mtime unchanged).
  assert.ok(fs.readFileSync(regPath).equals(bytesBefore), 'deps/rdeps do not rewrite registry.json bytes');
  assert.strictEqual(fs.statSync(regPath).mtimeMs, mtimeBefore, 'deps/rdeps do not touch registry.json mtime');
});

// ===========================================================================
// EVAL-DEP-005 — Orphan = no module AND zero inbound edges (BR-DEP-006)
//
// graph-orphans: routed-reviewer is in no module but reached by router's routes-to
// edge (NOT an orphan); lonely-reviewer is in no module with zero inbound edges (the
// ONLY orphan). `registry orphans` lists ONLY lonely-reviewer. RED today: no orphans
// verb (exit 1).
// ===========================================================================
test('EVAL-DEP-005 — Orphan = no module AND zero inbound edges', async (t) => {
  const root = sandbox('graph-orphans');
  t.after(() => cleanup(root));

  const seed = seedRegistry(root);
  assert.strictEqual(seed.status, 0, `seed build must succeed; got ${seed.status} ${seed.stderr.trim()}`);

  const orphans = runRegistryScript(['orphans', root], root);
  assert.strictEqual(orphans.status, 0, `orphans must succeed (status 0); got ${orphans.status} ${orphans.stderr.trim()}`);

  // The zero-inbound, module-less artifact IS listed.
  assert.match(orphans.stdout, /lonely-reviewer/, 'orphans lists the zero-inbound, module-less lonely-reviewer');
  // The routed-to artifact (module-less but reachable) is NOT listed.
  assert.doesNotMatch(orphans.stdout, /routed-reviewer/, 'orphans does NOT list the routed-to (reachable) artifact');
  // The in-module router is obviously not an orphan.
  assert.doesNotMatch(orphans.stdout, /router-reviewer/, 'orphans does NOT list the in-module router-reviewer');
});

// ===========================================================================
// EVAL-DEP-006 — Graph query verbs are read-only (BR-DEP-007)
//
// On a sandbox copy of the REAL graph surface (real agents/ + rules/ + manifests/ —
// the real repo is never mutated) PLUS a single PLANTED dangling agent dropped in (the
// fixture's planted-reviewer with its `ghost-reviewer` prose dangler, since the real
// react-reviewer regression has since been fixed): deps/rdeps/orphans/dangling all run
// read-only, `dangling` includes the planted ghost-reviewer entry, each emits findings
// in the C2 shape with source:"validate-registry", and none of the four touches
// registry.json bytes/mtime.
// ===========================================================================
test('EVAL-DEP-006 — Graph query verbs are read-only', async (t) => {
  // Build a sandbox that mirrors the REAL graph surface WITHOUT mutating the real repo.
  // Copy the real agents/, rules/, manifests/ and VERSION, then drop in the fixture's
  // planted-reviewer agent so a single `ghost-reviewer` prose ref dangles. There is
  // deliberately NO agents/ghost-reviewer.md.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dep-real-'));
  t.after(() => cleanup(root));
  for (const sub of ['agents', 'rules', 'manifests']) {
    const src = path.join(FORGE_ROOT, sub);
    if (fs.existsSync(src)) copyTree(src, path.join(root, sub));
  }
  if (fs.existsSync(path.join(FORGE_ROOT, 'VERSION'))) {
    fs.copyFileSync(path.join(FORGE_ROOT, 'VERSION'), path.join(root, 'VERSION'));
  }
  // Plant the synthetic dangling-reviewer agent into the sandbox's agents/ (it routes-to
  // a non-existent `ghost-reviewer`). The real repo is clean, so the dangler under test
  // is this planted one, never a real defect.
  fs.copyFileSync(
    path.join(FIXTURES, 'dangling-ref', 'agents', 'planted-reviewer.md'),
    path.join(root, 'agents', 'planted-reviewer.md'),
  );
  assert.ok(
    !fs.existsSync(path.join(root, 'agents', 'ghost-reviewer.md')),
    'precondition: the sandbox has NO ghost-reviewer agent (so it dangles)',
  );

  // Commit a registry for the read-only verbs to read.
  const seed = seedRegistry(root);
  assert.strictEqual(seed.status, 0, `seed build must succeed; got ${seed.status} ${seed.stderr.trim()}`);

  const regPath = path.join(root, '.forge', 'registry.json');
  const bytesBefore = fs.readFileSync(regPath);
  const mtimeBefore = fs.statSync(regPath).mtimeMs;

  // dangling includes the planted ghost-reviewer entry.
  const dangling = runRegistryScript(['dangling', root], root);
  assert.strictEqual(dangling.status, 0, `dangling must succeed (status 0); got ${dangling.status} ${dangling.stderr.trim()}`);
  assert.match(dangling.stdout, /ghost-reviewer/, 'dangling lists the planted ghost-reviewer dangling ref');

  // orphans returns its orphan set (read-only; runs without crashing).
  const orphans = runRegistryScript(['orphans', root], root);
  assert.strictEqual(orphans.status, 0, `orphans must succeed (status 0); got ${orphans.status} ${orphans.stderr.trim()}`);

  // deps/rdeps on a real uid run read-only.
  const deps = runRegistryScript(['deps', 'agent:typescript-reviewer', root], root);
  assert.strictEqual(deps.status, 0, `deps must succeed (status 0); got ${deps.status} ${deps.stderr.trim()}`);
  const rdeps = runRegistryScript(['rdeps', 'agent:typescript-reviewer', root], root);
  assert.strictEqual(rdeps.status, 0, `rdeps must succeed (status 0); got ${rdeps.status} ${rdeps.stderr.trim()}`);

  // Findings shape (C2) with source:"validate-registry" — assert via the --json
  // envelope of `dangling`, where findings[] carry {level,path,line,message,source}.
  const danglingJson = runRegistryScript(['dangling', root, '--json'], root);
  assert.strictEqual(danglingJson.status, 0, `dangling --json must succeed; got ${danglingJson.status} ${danglingJson.stderr.trim()}`);
  let env = null;
  try {
    env = JSON.parse(danglingJson.stdout.trim().split('\n').filter(Boolean).pop() || 'null');
  } catch {
    env = null;
  }
  assert.ok(env && Array.isArray(env.findings), `dangling --json emits an envelope with findings[]; got: ${danglingJson.stdout.trim().slice(0, 300)}`);
  const danglingFinding = env.findings.find(
    (f) => f && typeof f.message === 'string' && f.message.includes('ghost-reviewer'),
  );
  assert.ok(danglingFinding, 'a finding names the planted ghost-reviewer dangling ref');
  assert.strictEqual(danglingFinding.source, 'validate-registry', 'finding.source is "validate-registry"');
  assert.deepStrictEqual(
    Object.keys(danglingFinding).sort(),
    ['level', 'line', 'message', 'path', 'source'],
    'finding has exactly the five C2 fields {level,line,message,path,source}',
  );

  // None of the four verbs touched registry.json (bytes + mtime unchanged).
  assert.ok(fs.readFileSync(regPath).equals(bytesBefore), 'query verbs do not rewrite registry.json bytes');
  assert.strictEqual(fs.statSync(regPath).mtimeMs, mtimeBefore, 'query verbs do not touch registry.json mtime');
});
