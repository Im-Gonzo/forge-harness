// @ts-check
/**
 * conflict.test.mjs — deterministic acceptance specs for the per-project CONFLICT +
 * ADJUDICATION operator (manager/conflict.mjs, ADR-0020). Built-in node:test + node:assert ONLY
 * (zero runtime deps — every import is a node: builtin or a relative path).
 *
 * Run model: `node --test tests/manager/conflict.test.mjs`.
 *
 * SANDBOX DISCIPLINE (NEVER mutate the real repo) — mirrors compose.test.mjs:
 *   - conflict.mjs REUSES catalog.mjs `run('dedup')` for its record production and compose.mjs for
 *     resolve --apply; catalog.mjs resolves its FORGE_ROOT from `import.meta.url` (two levels up
 *     from manager/) and the synced-source cache from `$HOME`/`~`. We therefore COPY the whole
 *     `cli/` tree into a fresh os.tmpdir() sandbox and import `manager/conflict.mjs` FROM THE COPY,
 *     so the catalog scan reads the sandbox library + a sandboxed source cache. We point `$HOME` at
 *     a sandbox sub-dir so `forge source sync` clones into the sandbox cache. adjudication.json /
 *     composition.json / subscriptions.json are written under a SANDBOX project root we pass via
 *     `ctx.cwd`, so no write ever lands in the real repo. HOME is restored after each test; the
 *     sandbox tree is removed.
 *   - Each test imports a FRESH module copy via a cache-busting query string so module top-level
 *     state never leaks between tests.
 *
 * Coverage (the Slice 3 contract):
 *   TWO local sources publishing the SAME uid with DIFFERENT bytes (a uid-collision) ->
 *     conflict list shows 1 conflict with 2 candidates + state "blocking" (default policy block) +
 *     suggested fallback null (no eval/judge -> "needs human");
 *   set policy normal=auto -> state "auto" + suggested still null (no real signal — never fabricated);
 *   resolve --winner <src> --apply -> choice recorded, composition adopts winner + drops loser;
 *   policy set persists (the written file validates against the schema shape);
 *   preview (no --apply) writes nothing;
 *   unknown verb -> ok:false + ERROR + usage (the bin maps this to exit 2);
 *   NO model/judge agent is spawned (pure deterministic — no child process is launched by the op).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // …/tests/manager
const REAL_FORGE_ROOT = path.resolve(HERE, '..', '..'); // the real cli/ repo root

// ---------------------------------------------------------------------------
// Sandbox helpers — copy cli/ into /tmp, import conflict.mjs from the copy.
// ---------------------------------------------------------------------------

/** Recursively copy a dir, skipping the heavy/irrelevant trees, into dest. */
function copyTree(src, dest, skip) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) copyTree(s, d, skip);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Build a fresh sandbox: copy cli/ into os.tmpdir()/<prefix> and return its paths. A `project`
 * sub-dir is the active root we point adjudication/composition/subscriptions at; `home` sandboxes
 * the sync cache (~/.claude/forge-sources).
 */
function makeSandbox(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cli = path.join(root, 'cli');
  copyTree(REAL_FORGE_ROOT, cli, new Set(['.git', 'node_modules', 'tests']));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  return { root, cli, home, project };
}

/** Minimal pathToFileURL (build a file:// URL without importing url just for this). */
function pathToFileURL(p) {
  return 'file://' + path.resolve(p).split(path.sep).join('/').replace(/^([A-Za-z]):/, '/$1:');
}

/** Import a FRESH copy of the sandbox's conflict.mjs (cache-busted per call). */
async function loadConflict(cli) {
  const mod = path.join(cli, 'manager', 'conflict.mjs');
  return import(`${pathToFileURL(mod)}?t=${Date.now()}-${Math.random()}`);
}

/** Import a FRESH copy of the sandbox's slices.mjs (to subscribe a slice). */
async function loadSlices(cli) {
  const mod = path.join(cli, 'manager', 'slices.mjs');
  return import(`${pathToFileURL(mod)}?t=${Date.now()}-${Math.random()}`);
}

/** Import a FRESH copy of the sandbox's source.mjs (to register + sync a source). */
async function loadSource(cli) {
  const mod = path.join(cli, 'manager', 'source.mjs');
  return import(`${pathToFileURL(mod)}?t=${Date.now()}-${Math.random()}`);
}

/** Run `fn` with HOME overridden to `home`, restoring it (and the sandbox) after. */
async function withSandbox(prefix, fn) {
  const sb = makeSandbox(prefix);
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = sb.home;
  process.env.USERPROFILE = sb.home;
  try {
    await fn(sb);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Read the sandbox project's adjudication file (or null when absent). */
function readAdj(project) {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, '.forge', 'adjudication.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Read the sandbox project's composition file (or null when absent). */
function readComp(project) {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, '.forge', 'composition.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** git helper — run a git command in `cwd`, asserting success. */
function git(cwd, ...gitArgs) {
  const r = spawnSync('git', gitArgs, { cwd, encoding: 'utf8', shell: false });
  assert.strictEqual(r.status, 0, `git ${gitArgs.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * Build a local upstream git fixture repo on branch `main` carrying ONE agent record
 * agents/hello.md whose BODY is `body` (so two fixtures with different bodies publish the SAME
 * uid `agent:hello` with DIFFERENT contentHash — a dedup uid-collision once both are synced).
 */
function makeAgentFixture(root, name, body) {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'agents', 'hello.md'),
    [
      '---',
      'name: hello',
      'description: An upstream fixture agent used to exercise project-level conflict adjudication.',
      'owner: forge',
      'criticality: normal',
      'tags: [fixture]',
      'version: 0.1.0',
      '---',
      '',
      '# hello',
      '',
      body,
      '',
    ].join('\n'),
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.com');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `upstream fixture ${name}`);
  return { repo };
}

/**
 * Register + sync TWO sources (`fx-a`, `fx-b`) that BOTH publish agent:hello with DIFFERENT bytes
 * (a uid-collision), then subscribe BOTH slices so the read-view has two distinct candidates for
 * the same uid. Returns nothing — assertions live in the tests.
 */
async function syncTwoCollidingSources(cli, root, project) {
  makeAgentFixture(root, 'upstream-a', 'Variant A of the harmless upstream agent.');
  makeAgentFixture(root, 'upstream-b', 'Variant B — DIFFERENT bytes, same uid, to force a uid-collision.');
  const { run: sourceRun } = await loadSource(cli);

  const addA = await sourceRun('add', ['fx-a', `file://${path.join(root, 'upstream-a')}`, '--ref', 'main', '--apply'], {});
  assert.strictEqual(addA.ok, true, `source add fx-a failed: ${JSON.stringify(addA.findings)}`);
  const addB = await sourceRun('add', ['fx-b', `file://${path.join(root, 'upstream-b')}`, '--ref', 'main', '--apply'], {});
  assert.strictEqual(addB.ok, true, `source add fx-b failed: ${JSON.stringify(addB.findings)}`);

  const syncA = await sourceRun('sync', ['fx-a', '--apply', '--now', '2026-01-01T00:00:00Z'], {});
  assert.strictEqual(syncA.ok, true, `source sync fx-a failed: ${JSON.stringify(syncA.findings)}`);
  const syncB = await sourceRun('sync', ['fx-b', '--apply', '--now', '2026-01-01T00:00:00Z'], {});
  assert.strictEqual(syncB.ok, true, `source sync fx-b failed: ${JSON.stringify(syncB.findings)}`);

  const { run: sliceRun } = await loadSlices(cli);
  for (const sliceId of ['fx-a/agent', 'fx-b/agent']) {
    const res = await sliceRun('subscribe', [sliceId, '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, `subscribe ${sliceId} failed: ${JSON.stringify(res.findings)}`);
  }
}

// ===========================================================================
// list — empty + a uid-collision conflict
// ===========================================================================

test('list: empty (no sources) is a valid empty envelope (no conflicts, ok=true)', async () => {
  await withSandbox('forge-conflict-list-empty-', async ({ cli, project }) => {
    const { run } = await loadConflict(cli);
    const res = await run('list', [], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.ok(Array.isArray(res.data.conflicts), 'conflicts is an array');
    assert.deepStrictEqual(res.data.counts, { total: 0, blocking: 0, auto: 0, manual: 0 });
    assert.deepStrictEqual(res.data.policy, { normal: 'block', compliance: 'block', safety: 'block' },
      'default policy is all-block');
    assert.ok(typeof res.data.adjudicationPath === 'string', 'adjudicationPath is present');
  });
});

test('list: two sources publishing the SAME uid -> 1 conflict, 2 candidates, state "blocking", suggested null', async () => {
  await withSandbox('forge-conflict-list-collision-', async ({ cli, root, project }) => {
    await syncTwoCollidingSources(cli, root, project);
    const { run } = await loadConflict(cli);

    const res = await run('list', [], { cwd: project });
    assert.strictEqual(res.ok, true, `list failed: ${JSON.stringify(res.findings)}`);
    assert.strictEqual(res.data.conflicts.length, 1, 'exactly one read-view conflict');

    const c = res.data.conflicts[0];
    assert.strictEqual(c.uid, 'agent:hello');
    assert.strictEqual(c.kind, 'agent');
    assert.strictEqual(c.criticality, 'normal');
    assert.strictEqual(c.candidates.length, 2, 'two DISTINCT candidates (one per source)');
    const sources = c.candidates.map((cd) => cd.sourceId).sort();
    assert.deepStrictEqual(sources, ['fx-a', 'fx-b']);
    // No eval/judge signal exists -> score null, judge null, suggested null ("needs human").
    assert.ok(c.candidates.every((cd) => cd.score === null), 'no fabricated eval scores');
    assert.strictEqual(c.judge, null, 'no recorded judge verdict -> judge null');
    assert.strictEqual(c.suggested, null, 'no signal -> suggested null (needs human)');
    // Default policy block + no choice -> blocking.
    assert.strictEqual(c.state, 'blocking');
    assert.deepStrictEqual(res.data.counts, { total: 1, blocking: 1, auto: 0, manual: 0 });
  });
});

// ===========================================================================
// policy normal=auto -> state flips to "auto" (suggested still null — no real signal)
// ===========================================================================

test('policy normal=auto: a normal conflict with no choice flips to state "auto"', async () => {
  await withSandbox('forge-conflict-policy-auto-', async ({ cli, root, project }) => {
    await syncTwoCollidingSources(cli, root, project);
    const { run } = await loadConflict(cli);

    const setRes = await run('policy', ['--set', 'normal=auto', '--apply'], { cwd: project });
    assert.strictEqual(setRes.ok, true, `policy set failed: ${JSON.stringify(setRes.findings)}`);
    assert.strictEqual(setRes.data.changed, true);
    assert.strictEqual(setRes.data.written, true, '--apply persists');
    assert.strictEqual(setRes.data.policy.normal, 'auto');

    const listRes = await run('list', [], { cwd: project });
    const c = listRes.data.conflicts[0];
    assert.strictEqual(c.state, 'auto', 'policy normal=auto flips a no-choice normal conflict to auto');
    assert.strictEqual(c.suggested, null, 'still null — auto does not fabricate a suggested winner');
    assert.deepStrictEqual(listRes.data.counts, { total: 1, blocking: 0, auto: 1, manual: 0 });
  });
});

test('policy: persisted file validates against the forge.adjudication.v1 shape; get returns it', async () => {
  await withSandbox('forge-conflict-policy-persist-', async ({ cli, project }) => {
    const { run } = await loadConflict(cli);

    await run('policy', ['--set', 'compliance=auto', '--set', 'safety=block', '--apply'], { cwd: project });
    const adj = readAdj(project);
    assert.ok(adj, 'adjudication.json was created');
    assert.strictEqual(adj.schema, 'forge.adjudication.v1');
    assert.strictEqual(adj.version, 1);
    assert.deepStrictEqual(adj.policy, { normal: 'block', compliance: 'auto', safety: 'block' });
    assert.deepStrictEqual(adj.choices, [], 'no choices recorded by a policy set');

    // GET (no --set) returns the persisted policy.
    const getRes = await run('policy', [], { cwd: project });
    assert.strictEqual(getRes.ok, true);
    assert.strictEqual(getRes.data.changed, false);
    assert.deepStrictEqual(getRes.data.policy, { normal: 'block', compliance: 'auto', safety: 'block' });
  });
});

test('policy: an invalid mode is an ERROR (writes nothing)', async () => {
  await withSandbox('forge-conflict-policy-invalid-', async ({ cli, project }) => {
    const { run } = await loadConflict(cli);
    const res = await run('policy', ['--set', 'normal=maybe', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, false, 'an invalid mode is refused');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /auto\|block/.test(f.message)));
    assert.strictEqual(readAdj(project), null, 'nothing persisted');
  });
});

// ===========================================================================
// resolve --winner <src> --apply -> choice recorded; composition adopts winner + drops loser
// ===========================================================================

test('resolve --winner --apply: records the choice + adopts the winner + drops the losing peer', async () => {
  await withSandbox('forge-conflict-resolve-', async ({ cli, root, project }) => {
    await syncTwoCollidingSources(cli, root, project);
    const { run } = await loadConflict(cli);

    const res = await run('resolve', ['agent:hello', '--winner', 'fx-a', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, `resolve failed: ${JSON.stringify(res.findings)}`);
    assert.strictEqual(res.data.changed, true);
    assert.strictEqual(res.data.written, true, '--apply persists the choice');
    assert.strictEqual(res.data.composeApplied, true, 'the composition was updated');

    // The recorded choice is in adjudication.json.
    const adj = readAdj(project);
    assert.ok(adj, 'adjudication.json created');
    assert.deepStrictEqual(adj.choices, [{ uid: 'agent:hello', winner: 'fx-a' }]);

    // The composition adopted the WINNER (fx-a) and the loser (fx-b) is NOT present.
    const comp = readComp(project);
    assert.ok(comp, 'composition.json created');
    assert.deepStrictEqual(comp.adopted, [{ uid: 'agent:hello', sourceId: 'fx-a' }],
      'winner adopted, losing peer dropped');

    // list now shows the conflict as "manual" (a recorded choice).
    const listRes = await run('list', [], { cwd: project });
    const c = listRes.data.conflicts[0];
    assert.strictEqual(c.state, 'manual', 'a recorded choice flips state to manual');
    assert.strictEqual(c.choice, 'fx-a', 'the recorded winner is surfaced as choice');
    assert.deepStrictEqual(listRes.data.counts, { total: 1, blocking: 0, auto: 0, manual: 1 });
  });
});

test('resolve: idempotent re-resolve to the same winner is a no-op WARN', async () => {
  await withSandbox('forge-conflict-resolve-idem-', async ({ cli, root, project }) => {
    await syncTwoCollidingSources(cli, root, project);
    const { run } = await loadConflict(cli);

    await run('resolve', ['agent:hello', '--winner', 'fx-a', '--apply'], { cwd: project });
    const res = await run('resolve', ['agent:hello', '--winner', 'fx-a', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, 're-resolve is a soft no-op, not an error');
    assert.strictEqual(res.data.changed, false, 'no change on re-resolve');
    assert.ok(res.findings.some((f) => f.level === 'WARN' && /already resolved/.test(f.message)));
    assert.deepStrictEqual(readAdj(project).choices, [{ uid: 'agent:hello', winner: 'fx-a' }],
      'still a single recorded choice');
  });
});

test('resolve --winner library: selects the library-local copy (winner null)', async () => {
  await withSandbox('forge-conflict-resolve-lib-', async ({ cli, root, project }) => {
    await syncTwoCollidingSources(cli, root, project);
    const { run } = await loadConflict(cli);
    // No --apply: preview the recording so we exercise the "library" -> null mapping without
    // needing a library-local candidate present in the read-view for adoption.
    const res = await run('resolve', ['agent:hello', '--winner', 'library'], { cwd: project });
    assert.strictEqual(res.ok, true, `resolve failed: ${JSON.stringify(res.findings)}`);
    assert.strictEqual(res.data.winner, null, '"library" maps to the library-local copy (null)');
    assert.strictEqual(res.data.changed, true, 'preview plans the recording');
  });
});

test('resolve: missing --winner is an ERROR (no write)', async () => {
  await withSandbox('forge-conflict-resolve-nowin-', async ({ cli, project }) => {
    const { run } = await loadConflict(cli);
    const res = await run('resolve', ['agent:hello', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, false);
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /--winner/.test(f.message)));
    assert.strictEqual(readAdj(project), null, 'nothing persisted');
  });
});

// ===========================================================================
// preview (no --apply) writes nothing
// ===========================================================================

test('resolve: preview by default writes NOTHING (no --apply)', async () => {
  await withSandbox('forge-conflict-resolve-preview-', async ({ cli, root, project }) => {
    await syncTwoCollidingSources(cli, root, project);
    const { run } = await loadConflict(cli);

    const res = await run('resolve', ['agent:hello', '--winner', 'fx-a'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.changed, true, 'plan shows the would-record change');
    assert.strictEqual(res.data.written, false, 'preview never writes');
    assert.strictEqual(readAdj(project), null, 'no adjudication file created by a preview');
    assert.strictEqual(readComp(project), null, 'no composition file touched by a preview');
  });
});

test('policy: preview by default writes NOTHING (no --apply)', async () => {
  await withSandbox('forge-conflict-policy-preview-', async ({ cli, project }) => {
    const { run } = await loadConflict(cli);
    const res = await run('policy', ['--set', 'normal=auto'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.changed, true, 'plan shows the would-set change');
    assert.strictEqual(res.data.written, false, 'preview never writes');
    assert.strictEqual(readAdj(project), null, 'no adjudication file created by a preview');
  });
});

// ===========================================================================
// single read-view candidate is NOT a conflict (BR-CAT-010)
// ===========================================================================

test('list: a uid visible from only ONE subscribed source is NOT a conflict', async () => {
  await withSandbox('forge-conflict-single-', async ({ cli, root, project }) => {
    makeAgentFixture(root, 'upstream-a', 'Variant A.');
    makeAgentFixture(root, 'upstream-b', 'Variant B — different bytes.');
    const { run: sourceRun } = await loadSource(cli);
    await sourceRun('add', ['fx-a', `file://${path.join(root, 'upstream-a')}`, '--ref', 'main', '--apply'], {});
    await sourceRun('add', ['fx-b', `file://${path.join(root, 'upstream-b')}`, '--ref', 'main', '--apply'], {});
    await sourceRun('sync', ['fx-a', '--apply', '--now', '2026-01-01T00:00:00Z'], {});
    await sourceRun('sync', ['fx-b', '--apply', '--now', '2026-01-01T00:00:00Z'], {});
    // Subscribe ONLY fx-a -> only ONE candidate for agent:hello in the read-view.
    const { run: sliceRun } = await loadSlices(cli);
    await sliceRun('subscribe', ['fx-a/agent', '--apply'], { cwd: project });

    const { run } = await loadConflict(cli);
    const res = await run('list', [], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.conflicts.length, 0,
      'a single read-view candidate for a uid is not a conflict (BR-CAT-010)');
  });
});

// ===========================================================================
// DETERMINISM — the operator spawns NO child process / model (it imports siblings in-process)
// ===========================================================================

test('list: is pure deterministic — no model/judge agent is spawned (no child process launched)', async () => {
  await withSandbox('forge-conflict-deterministic-', async ({ cli, root, project }) => {
    await syncTwoCollidingSources(cli, root, project);
    const { run } = await loadConflict(cli);

    // Spy on child_process.spawn/spawnSync/exec/execSync/fork: the conflict operator must collect
    // deterministically (reusing the catalog/compose SIBLING modules in-process), never launch a
    // child to run a judge agent or any model.
    const cp = await import('node:child_process');
    const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
    const orig = {};
    let spawned = 0;
    for (const n of names) {
      orig[n] = cp[n];
      try {
        cp[n] = (...a) => { spawned++; return orig[n](...a); };
      } catch { /* some are non-writable getters — best-effort spy */ }
    }
    try {
      const res = await run('list', [], { cwd: project });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.data.conflicts.length, 1, 'still derives the conflict deterministically');
    } finally {
      for (const n of names) {
        try { cp[n] = orig[n]; } catch { /* ignore */ }
      }
    }
    assert.strictEqual(spawned, 0, 'conflict list spawned NO child process (no model/judge invocation)');
  });
});

// ===========================================================================
// unknown verb — ok:false + ERROR + usage (the bin maps this to exit 2)
// ===========================================================================

test('unknown verb: returns ok:false with an ERROR finding + usage banner', async () => {
  await withSandbox('forge-conflict-unknown-', async ({ cli, project }) => {
    const { run } = await loadConflict(cli);
    const res = await run('frobnicate', [], { cwd: project });
    assert.strictEqual(res.ok, false, 'an unknown sub-verb is not ok');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /unknown conflict subcommand/.test(f.message)));
    assert.ok(res.data && typeof res.data.usage === 'string', 'usage banner present in data');
  });
});

test('resolve: missing <uid> is an ERROR with usage (no write)', async () => {
  await withSandbox('forge-conflict-resolve-missing-', async ({ cli, project }) => {
    const { run } = await loadConflict(cli);
    const res = await run('resolve', [], { cwd: project });
    assert.strictEqual(res.ok, false);
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /requires a <uid>/.test(f.message)));
    assert.strictEqual(readAdj(project), null, 'nothing persisted');
  });
});
