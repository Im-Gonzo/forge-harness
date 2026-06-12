// @ts-check
/**
 * tailor.test.mjs — deterministic acceptance specs for the per-project TAILORING + OVERLAY
 * operator (manager/tailor.mjs, ADR-0021). Built-in node:test + node:assert ONLY (zero runtime
 * deps — every import is a node: builtin or a relative path).
 *
 * Run model: `node --test tests/manager/tailor.test.mjs`.
 *
 * SANDBOX DISCIPLINE (NEVER mutate the real repo): mirrors compose.test.mjs. tailor.mjs REUSES
 * compose.mjs `run('list')` (which reuses catalog.mjs `run('build')`); catalog.mjs resolves its
 * FORGE_ROOT from `import.meta.url` (two levels up from manager/) and the synced-source cache from
 * `$HOME`/`~`. We COPY the whole `cli/` tree into a fresh os.tmpdir() sandbox and import the modules
 * FROM THE COPY, so every scan reads the sandbox library + a sandboxed source cache. We point `$HOME`
 * at a sandbox sub-dir so `forge source sync` clones into the sandbox cache. tailoring.json,
 * composition.json, and subscriptions.json are written under a SANDBOX project root we pass via
 * `ctx.cwd`, so no write ever lands in the real repo. HOME is restored after each test; the sandbox
 * tree is removed. Each test imports a FRESH module copy via a cache-busting query string so module
 * top-level state never leaks between tests.
 *
 * Coverage (the Slice 4 contract):
 *   add --type pin --detail v1.2.0 --apply -> list shows the overlay + resolved.version == v1.2.0;
 *   add override "model → opus" -> resolved.model == "opus";
 *   add to a NON-adopted resource -> ERROR (refused, nothing written);
 *   remove reverses an add; idempotent re-add per type (a second pin REPLACES the prior detail);
 *   preview (no --apply) writes nothing;
 *   orphan after un-adopt (compose remove) -> list WARN but entry RETAINED in the file;
 *   unknown verb -> ok:false + ERROR + usage (the bin maps this to exit 2).
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
// Sandbox helpers — copy cli/ into /tmp, import the modules from the copy.
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

/** Build a fresh sandbox: copy cli/ into os.tmpdir()/<prefix> and return its paths. */
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

/** Minimal pathToFileURL (avoid importing url just for this; build a file:// URL). */
function pathToFileURL(p) {
  return 'file://' + path.resolve(p).split(path.sep).join('/').replace(/^([A-Za-z]):/, '/$1:');
}

/** Import a FRESH copy of the sandbox's tailor.mjs (cache-busted per call). */
async function loadTailor(cli) {
  const mod = path.join(cli, 'manager', 'tailor.mjs');
  return import(`${pathToFileURL(mod)}?t=${Date.now()}-${Math.random()}`);
}

/** Import a FRESH copy of the sandbox's compose.mjs (to adopt/remove a resource). */
async function loadCompose(cli) {
  const mod = path.join(cli, 'manager', 'compose.mjs');
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

/** Read the sandbox project's tailoring file (or null when absent). */
function readTail(project) {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, '.forge', 'tailoring.json'), 'utf8'));
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
 * Build a local upstream git fixture repo on branch `main` carrying an agent (agents/hello.md), so
 * after a `source sync` we get a slice (fx/agent) we can subscribe + adopt + tailor.
 */
function makeFixture(root) {
  const repo = path.join(root, 'upstream');
  fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'agents', 'hello.md'),
    [
      '---',
      'name: hello',
      'description: An upstream fixture agent used to exercise tailoring overlays on an adopted resource.',
      'owner: forge',
      'criticality: normal',
      'tags: [fixture]',
      'version: 0.1.0',
      '---',
      '',
      '# hello',
      '',
      'A harmless upstream agent.',
      '',
    ].join('\n'),
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.com');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'upstream fixture');
  return { repo };
}

/** Register + sync a `fx` source from a local git fixture into the sandbox cache. */
async function syncFixtureSource(cli, root) {
  const fx = makeFixture(root);
  const { run: sourceRun } = await loadSource(cli);
  const addRes = await sourceRun('add', ['fx', `file://${fx.repo}`, '--ref', 'main', '--apply'], {});
  assert.strictEqual(addRes.ok, true, `source add failed: ${JSON.stringify(addRes.findings)}`);
  const syncRes = await sourceRun('sync', ['fx', '--apply', '--now', '2026-01-01T00:00:00Z'], {});
  assert.strictEqual(syncRes.ok, true, `source sync failed: ${JSON.stringify(syncRes.findings)}`);
  return fx;
}

/** Subscribe a slice id in the sandbox project (so its records enter the read-view). */
async function subscribe(cli, project, sliceId) {
  const { run } = await loadSlices(cli);
  const res = await run('subscribe', [sliceId, '--apply'], { cwd: project });
  assert.strictEqual(res.ok, true, `subscribe ${sliceId} failed: ${JSON.stringify(res.findings)}`);
}

/** Adopt agent:hello from source fx in the sandbox project (the tailorability gate). */
async function adoptHello(cli, project) {
  const { run } = await loadCompose(cli);
  const res = await run('adopt', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project });
  assert.strictEqual(res.ok, true, `adopt failed: ${JSON.stringify(res.findings)}`);
}

/** Remove agent:hello from source fx (un-adopt — turns any tailoring of it into an orphan). */
async function removeHello(cli, project) {
  const { run } = await loadCompose(cli);
  const res = await run('remove', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project });
  assert.strictEqual(res.ok, true, `remove failed: ${JSON.stringify(res.findings)}`);
}

/** Full setup: sync fx, subscribe fx/agent, adopt agent:hello. The standard tailorable fixture. */
async function setupAdopted(cli, root, project) {
  await syncFixtureSource(cli, root);
  await subscribe(cli, project, 'fx/agent');
  await adoptHello(cli, project);
}

// ===========================================================================
// list — empty + JOINed tailored view
// ===========================================================================

test('list: empty tailoring is a valid empty envelope (no tailored, ok=true)', async () => {
  await withSandbox('forge-tailor-list-empty-', async ({ cli, project }) => {
    const { run } = await loadTailor(cli);
    const res = await run('list', [], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.ok(Array.isArray(res.data.tailored), 'tailored is an array');
    assert.strictEqual(res.data.tailored.length, 0, 'nothing tailored');
    assert.deepStrictEqual(res.data.counts, { tailored: 0, overlays: 0 });
    assert.ok(typeof res.data.tailoringPath === 'string', 'tailoringPath is present');
  });
});

// ===========================================================================
// add pin --apply -> list shows the overlay + resolved.version
// ===========================================================================

test('add --type pin --detail v1.2.0 --apply: list shows the overlay + resolved.version == v1.2.0', async () => {
  await withSandbox('forge-tailor-pin-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);

    const res = await run('add', ['agent:hello', '--type', 'pin', '--detail', 'v1.2.0', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, `add failed: ${JSON.stringify(res.findings)}`);
    assert.strictEqual(res.data.changed, true);
    assert.strictEqual(res.data.written, true, '--apply persists');

    // The on-disk file validates against the schema shape.
    const tail = readTail(project);
    assert.ok(tail, 'tailoring.json was created');
    assert.strictEqual(tail.schema, 'forge.tailoring.v1');
    assert.strictEqual(tail.version, 1);
    assert.deepStrictEqual(tail.tailored, [
      { uid: 'agent:hello', sourceId: 'fx', overlays: [{ type: 'pin', detail: 'v1.2.0' }] },
    ]);

    // list JOINs to the composition record and folds the overlay into the resolved preview.
    const listRes = await run('list', [], { cwd: project });
    assert.strictEqual(listRes.ok, true, `list failed: ${JSON.stringify(listRes.findings)}`);
    assert.strictEqual(listRes.data.tailored.length, 1);
    const entry = listRes.data.tailored[0];
    assert.strictEqual(entry.uid, 'agent:hello');
    assert.strictEqual(entry.sourceId, 'fx');
    assert.strictEqual(entry.kind, 'agent', 'kind resolved from the composition/catalog record');
    assert.deepStrictEqual(entry.overlays, [{ type: 'pin', detail: 'v1.2.0' }]);
    assert.strictEqual(entry.resolved.version, 'v1.2.0', 'pin folds version into the resolved preview');
    assert.deepStrictEqual(listRes.data.counts, { tailored: 1, overlays: 1 });
  });
});

// ===========================================================================
// add override "model → opus" -> resolved.model == "opus"
// ===========================================================================

test('add --type override --detail "model → opus": resolved.model == "opus"', async () => {
  await withSandbox('forge-tailor-override-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);

    const res = await run('add', ['agent:hello', '--type', 'override', '--detail', 'model → opus', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, `add override failed: ${JSON.stringify(res.findings)}`);
    assert.strictEqual(res.data.written, true);

    const listRes = await run('list', [], { cwd: project });
    const entry = listRes.data.tailored[0];
    assert.deepStrictEqual(entry.overlays, [{ type: 'override', detail: 'model → opus' }]);
    assert.strictEqual(entry.resolved.model, 'opus', 'override "model → opus" folds model=opus');
  });
});

test('add --type override with an unparseable detail leaves the base model + emits an INFO finding', async () => {
  await withSandbox('forge-tailor-override-bad-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);

    // No "→"/"->" arrow -> unparseable.
    await run('add', ['agent:hello', '--type', 'override', '--detail', 'just-a-string', '--source', 'fx', '--apply'], { cwd: project });
    const listRes = await run('list', [], { cwd: project });
    const entry = listRes.data.tailored[0];
    assert.strictEqual(entry.resolved.model, 'sonnet', 'base model is preserved for an unparseable override');
    assert.ok(listRes.findings.some((f) => f.level === 'INFO' && /not "field → value"|unparseable|override/.test(f.message)),
      'an INFO finding explains the unparseable override');
  });
});

// ===========================================================================
// add to a NON-adopted resource -> ERROR
// ===========================================================================

test('add to a NON-adopted resource is REFUSED with an ERROR and writes nothing', async () => {
  await withSandbox('forge-tailor-notadopted-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    // NOTE: deliberately NOT adopting agent:hello — it is in the read-view but not in the composition.
    const { run } = await loadTailor(cli);

    const res = await run('add', ['agent:hello', '--type', 'pin', '--detail', 'v1.2.0', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, false, 'a non-adopted resource cannot be tailored');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /not ADOPTED|adopted/.test(f.message)));
    assert.strictEqual(readTail(project), null, 'nothing persisted');

    // Once adopted, the same add succeeds (the adoption gate, BR-CAT-015).
    await adoptHello(cli, project);
    const ok = await run('add', ['agent:hello', '--type', 'pin', '--detail', 'v1.2.0', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(ok.ok, true, `add after adopt failed: ${JSON.stringify(ok.findings)}`);
    assert.strictEqual(readTail(project).tailored.length, 1);
  });
});

test('add does NOT adopt as a side effect (tailor != adopt)', async () => {
  await withSandbox('forge-tailor-noadopt-side-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    const { run } = await loadTailor(cli);
    await run('add', ['agent:hello', '--type', 'pin', '--detail', 'v1.2.0', '--source', 'fx', '--apply'], { cwd: project });
    // The composition must NOT have been written by a refused tailor add.
    let comp = null;
    try { comp = JSON.parse(fs.readFileSync(path.join(project, '.forge', 'composition.json'), 'utf8')); } catch { /* none */ }
    assert.strictEqual(comp, null, 'tailor add never adopts (composition.json untouched)');
  });
});

// ===========================================================================
// remove — reverses an add
// ===========================================================================

test('remove --type pin --apply: reverses an add (list shows it gone)', async () => {
  await withSandbox('forge-tailor-remove-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);

    await run('add', ['agent:hello', '--type', 'pin', '--detail', 'v1.2.0', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(readTail(project).tailored.length, 1);

    const res = await run('remove', ['agent:hello', '--type', 'pin', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.changed, true);
    assert.strictEqual(res.data.written, true);
    assert.deepStrictEqual(res.data.overlays, [], 'pin overlay removed');
    // An entry with no overlays is dropped from the file on write.
    assert.deepStrictEqual(readTail(project).tailored, [], 'persisted empty tailored set');

    const listRes = await run('list', [], { cwd: project });
    assert.strictEqual(listRes.data.tailored.length, 0, 'nothing tailored after remove');
  });
});

test('remove narrowed by --detail drops only the matching layer; remove of an absent overlay is a no-op WARN', async () => {
  await withSandbox('forge-tailor-remove-narrow-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);

    // Two distinct layers (layer/gate may repeat, deduped by (type, detail)).
    await run('add', ['agent:hello', '--type', 'layer', '--detail', '+ rule A', '--source', 'fx', '--apply'], { cwd: project });
    await run('add', ['agent:hello', '--type', 'layer', '--detail', '+ rule B', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(readTail(project).tailored[0].overlays.length, 2, 'two layers recorded');

    // Remove only "+ rule A".
    const res = await run('remove', ['agent:hello', '--type', 'layer', '--detail', '+ rule A', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.overlays, [{ type: 'layer', detail: '+ rule B' }], 'only "+ rule B" survives');

    // Removing it again is an idempotent no-op WARN.
    const again = await run('remove', ['agent:hello', '--type', 'layer', '--detail', '+ rule A', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.data.changed, false, 'absent overlay -> no change');
    assert.ok(again.findings.some((f) => f.level === 'WARN' && /nothing to remove/.test(f.message)));
  });
});

// ===========================================================================
// idempotent re-add per type — a second pin REPLACES the prior detail
// ===========================================================================

test('add: a second pin REPLACES the prior pin detail (one pin remains, latest wins)', async () => {
  await withSandbox('forge-tailor-pin-replace-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);

    await run('add', ['agent:hello', '--type', 'pin', '--detail', 'v1.2.0', '--source', 'fx', '--apply'], { cwd: project });
    const res = await run('add', ['agent:hello', '--type', 'pin', '--detail', 'v2.0.0', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.changed, true, 'replacing the pin detail is a change');

    const tail = readTail(project);
    assert.deepStrictEqual(tail.tailored[0].overlays, [{ type: 'pin', detail: 'v2.0.0' }],
      'exactly one pin remains, with the latest detail');

    const listRes = await run('list', [], { cwd: project });
    assert.strictEqual(listRes.data.tailored[0].resolved.version, 'v2.0.0', 'resolved version is the latest pin');
  });
});

test('add: re-adding an identical (layer, detail) is an idempotent no-op WARN (one layer)', async () => {
  await withSandbox('forge-tailor-layer-idem-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);

    await run('add', ['agent:hello', '--type', 'layer', '--detail', '+ rule A', '--source', 'fx', '--apply'], { cwd: project });
    const res = await run('add', ['agent:hello', '--type', 'layer', '--detail', '+ rule A', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, 're-add is a soft no-op, not an error');
    assert.strictEqual(res.data.changed, false, 'no change on identical re-add');
    assert.ok(res.findings.some((f) => f.level === 'WARN' && /already recorded/.test(f.message)));
    assert.strictEqual(readTail(project).tailored[0].overlays.length, 1, 'still a single layer');
  });
});

// ===========================================================================
// fork/disable — detail optional
// ===========================================================================

test('add --type disable with no --detail folds status=disabled (detail optional)', async () => {
  await withSandbox('forge-tailor-disable-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);

    const res = await run('add', ['agent:hello', '--type', 'disable', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, `disable failed: ${JSON.stringify(res.findings)}`);
    assert.deepStrictEqual(readTail(project).tailored[0].overlays, [{ type: 'disable', detail: '' }]);

    const listRes = await run('list', [], { cwd: project });
    assert.strictEqual(listRes.data.tailored[0].resolved.status, 'disabled', 'disable folds status=disabled');
  });
});

// ===========================================================================
// preview (no --apply) writes nothing
// ===========================================================================

test('add: preview by default writes NOTHING (no --apply)', async () => {
  await withSandbox('forge-tailor-preview-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);

    const res = await run('add', ['agent:hello', '--type', 'pin', '--detail', 'v1.2.0', '--source', 'fx'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.changed, true, 'plan shows the would-add change');
    assert.strictEqual(res.data.written, false, 'preview never writes');
    assert.strictEqual(readTail(project), null, 'no tailoring file created by a preview');
  });
});

// ===========================================================================
// orphan after un-adopt -> list WARN but entry RETAINED
// ===========================================================================

test('orphan: un-adopting (compose remove) after tailor lists the entry as a WARN but RETAINS it', async () => {
  await withSandbox('forge-tailor-orphan-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);

    await run('add', ['agent:hello', '--type', 'pin', '--detail', 'v1.2.0', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(readTail(project).tailored.length, 1);

    // Un-adopt agent:hello -> its (uid, sourceId) leaves the composition (the tailoring is an orphan).
    await removeHello(cli, project);

    const listRes = await run('list', [], { cwd: project });
    assert.strictEqual(listRes.ok, true);
    assert.strictEqual(listRes.data.tailored.length, 0, 'orphan is listed-out of the JOINed set');
    assert.ok(listRes.findings.some((f) => f.level === 'WARN' && /orphan/.test(f.message)),
      'orphan is surfaced as a WARN');
    // CRITICAL: the entry is RETAINED in the file (never silently deleted, BR-CAT-015).
    assert.deepStrictEqual(readTail(project).tailored, [
      { uid: 'agent:hello', sourceId: 'fx', overlays: [{ type: 'pin', detail: 'v1.2.0' }] },
    ], 'orphaned entry retained on disk — removal is always an explicit tailor remove');
  });
});

// ===========================================================================
// validation errors
// ===========================================================================

test('add: an invalid overlay type is an ERROR (no write)', async () => {
  await withSandbox('forge-tailor-badtype-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);
    const res = await run('add', ['agent:hello', '--type', 'frobnicate', '--detail', 'x', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, false);
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /invalid overlay type/.test(f.message)));
    assert.strictEqual(readTail(project), null, 'nothing persisted');
  });
});

test('add: a required-detail type (pin) with NO --detail is an ERROR (no write)', async () => {
  await withSandbox('forge-tailor-nodetail-', async ({ cli, root, project }) => {
    await setupAdopted(cli, root, project);
    const { run } = await loadTailor(cli);
    const res = await run('add', ['agent:hello', '--type', 'pin', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, false);
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /requires --detail/.test(f.message)));
    assert.strictEqual(readTail(project), null, 'nothing persisted');
  });
});

test('add: missing <uid> is an ERROR with usage (no write)', async () => {
  await withSandbox('forge-tailor-nouid-', async ({ cli, project }) => {
    const { run } = await loadTailor(cli);
    const res = await run('add', ['--type', 'pin', '--detail', 'v1.2.0'], { cwd: project });
    assert.strictEqual(res.ok, false);
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /requires a <uid>/.test(f.message)));
    assert.strictEqual(readTail(project), null, 'nothing persisted');
  });
});

// ===========================================================================
// unknown verb — ok:false + ERROR + usage (the bin maps this to exit 2)
// ===========================================================================

test('unknown verb: returns ok:false with an ERROR finding + usage banner', async () => {
  await withSandbox('forge-tailor-unknown-', async ({ cli, project }) => {
    const { run } = await loadTailor(cli);
    const res = await run('frobnicate', [], { cwd: project });
    assert.strictEqual(res.ok, false, 'an unknown sub-verb is not ok');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /unknown tailor subcommand/.test(f.message)));
    assert.ok(res.data && typeof res.data.usage === 'string', 'usage banner present in data');
  });
});
