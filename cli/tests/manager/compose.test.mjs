// @ts-check
/**
 * compose.test.mjs — deterministic acceptance specs for the per-project COMPOSITION +
 * ADOPTION operator (manager/compose.mjs, ADR-0019). Built-in node:test + node:assert ONLY
 * (zero runtime deps — every import is a node: builtin or a relative path).
 *
 * Run model: `node --test tests/manager/compose.test.mjs`.
 *
 * SANDBOX DISCIPLINE (NEVER mutate the real repo):
 *   - compose.mjs REUSES catalog.mjs `run('build')` for its read-view record production;
 *     catalog.mjs resolves its FORGE_ROOT from `import.meta.url` (two levels up from manager/)
 *     and the synced-source cache from `$HOME`/`~`. We therefore COPY the whole `cli/` tree
 *     into a fresh os.tmpdir() sandbox and import `manager/compose.mjs` FROM THE COPY, so the
 *     catalog scan reads the sandbox library + a sandboxed source cache. We point `$HOME` at a
 *     sandbox sub-dir so `forge source sync` clones into the sandbox cache. composition.json
 *     (and subscriptions.json) are written under a SANDBOX project root we pass via `ctx.cwd`,
 *     so no write ever lands in the real repo. HOME is restored after each test; the sandbox
 *     tree is removed.
 *   - Each test imports a FRESH module copy via a cache-busting query string so module
 *     top-level state never leaks between tests.
 *
 * Coverage (the Slice 2 contract):
 *   adopt subscribed-slice --apply -> compose list shows it (kind/version/criticality joined);
 *   adopt of a NON-read-view (unsubscribed) resource -> ERROR (refused, nothing written);
 *   adopt library-local (sourceId === null, no --source needed);
 *   adopt requiring --source when source-only -> ERROR asking for --source;
 *   remove reverses an adopt; idempotent re-adopt (one entry, no dup);
 *   preview (no --apply) writes nothing;
 *   orphaned entry (unsubscribe after adopt) -> list WARN but entry RETAINED in the file;
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
// Sandbox helpers — copy cli/ into /tmp, import compose.mjs from the copy.
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
 * Build a fresh sandbox: copy cli/ into os.tmpdir()/<prefix> and return its paths. We
 * DELIBERATELY skip the existing `tests/`, `.git`, and `node_modules` trees (compose.mjs + the
 * catalog.mjs it reuses only need manager/, manifests/, .forge/, agents/, skills/, lib/,
 * VERSION). A `project` sub-dir is the active root we point composition/subscriptions at.
 */
function makeSandbox(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cli = path.join(root, 'cli');
  copyTree(REAL_FORGE_ROOT, cli, new Set(['.git', 'node_modules', 'tests']));
  // Point HOME at a sandbox sub-dir so the sync cache (~/.claude/forge-sources) is sandboxed.
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  // The active PROJECT root composition/subscriptions are written under (per-project state).
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  return { root, cli, home, project };
}

/** Import a FRESH copy of the sandbox's compose.mjs (cache-busted per call). */
async function loadCompose(cli) {
  const mod = path.join(cli, 'manager', 'compose.mjs');
  return import(`${pathToFileURL(mod)}?t=${Date.now()}-${Math.random()}`);
}

/** Import a FRESH copy of the sandbox's slices.mjs (to subscribe/unsubscribe a slice). */
async function loadSlices(cli) {
  const mod = path.join(cli, 'manager', 'slices.mjs');
  return import(`${pathToFileURL(mod)}?t=${Date.now()}-${Math.random()}`);
}

/** Import a FRESH copy of the sandbox's source.mjs (to register + sync a source). */
async function loadSource(cli) {
  const mod = path.join(cli, 'manager', 'source.mjs');
  return import(`${pathToFileURL(mod)}?t=${Date.now()}-${Math.random()}`);
}

/** Minimal pathToFileURL (avoid importing url just for this; build a file:// URL). */
function pathToFileURL(p) {
  return 'file://' + path.resolve(p).split(path.sep).join('/').replace(/^([A-Za-z]):/, '/$1:');
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
 * Build a local upstream git fixture repo on branch `main` carrying TWO catalog records of
 * DIFFERENT kinds: an agent (agents/hello.md) and a skill (skills/greet/SKILL.md). After a
 * `source sync` these become two slices (fx/agent, fx/skill), so we can subscribe one and
 * leave the other UNSUBSCRIBED to exercise the read-view gate.
 */
function makeMultiKindFixture(root) {
  const repo = path.join(root, 'upstream');
  fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'skills', 'greet'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'agents', 'hello.md'),
    [
      '---',
      'name: hello',
      'description: An upstream fixture agent used to exercise composition adoption by kind.',
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
  fs.writeFileSync(
    path.join(repo, 'skills', 'greet', 'SKILL.md'),
    [
      '---',
      'name: greet',
      'description: An upstream fixture skill used to exercise adoption from a second kind.',
      '---',
      '',
      '# greet',
      '',
      'A harmless upstream skill.',
      '',
    ].join('\n'),
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.com');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'upstream multi-kind fixture');
  const commit = git(repo, 'rev-parse', 'HEAD');
  return { repo, commit };
}

/**
 * Register + sync a `fx` source from a local git fixture into the sandbox cache, so the
 * catalog (and therefore the compose read-view) has real source records. Returns the fixture.
 */
async function syncFixtureSource(cli, root) {
  const fx = makeMultiKindFixture(root);
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

/** Unsubscribe a slice id in the sandbox project (so its records leave the read-view). */
async function unsubscribe(cli, project, sliceId) {
  const { run } = await loadSlices(cli);
  const res = await run('unsubscribe', [sliceId, '--apply'], { cwd: project });
  assert.strictEqual(res.ok, true, `unsubscribe ${sliceId} failed: ${JSON.stringify(res.findings)}`);
}

/**
 * Find a library-local uid (source === null) from the sandbox catalog so we can exercise
 * library-local adoption with NO --source. The cli/ copy ships real agents/skills, so this is
 * stable; we pick the first agent: record deterministically (sorted) for a predictable uid.
 */
async function firstLibraryLocalUid(cli) {
  const catMod = path.join(cli, 'manager', 'catalog.mjs');
  const { run } = await import(`${pathToFileURL(catMod)}?t=${Date.now()}-${Math.random()}`);
  const res = await run('build', [], {});
  const records = (res && res.data && res.data.records) || [];
  const local = records
    .filter((r) => !r.source && typeof r.uid === 'string')
    .map((r) => r.uid)
    .sort();
  assert.ok(local.length > 0, 'sandbox library has at least one library-local record');
  return local[0];
}

// ===========================================================================
// list — empty + JOINed adopted view
// ===========================================================================

test('list: empty composition is a valid empty envelope (no adopted, ok=true)', async () => {
  await withSandbox('forge-comp-list-empty-', async ({ cli, project }) => {
    const { run } = await loadCompose(cli);
    const res = await run('list', [], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.ok(Array.isArray(res.data.adopted), 'adopted is an array');
    assert.strictEqual(res.data.adopted.length, 0, 'nothing adopted');
    assert.deepStrictEqual(res.data.counts, { adopted: 0, sources: 0 });
    assert.ok(typeof res.data.compositionPath === 'string', 'compositionPath is present');
  });
});

// ===========================================================================
// adopt — subscribed-slice resource (the happy path)
// ===========================================================================

test('adopt subscribed-slice --apply: compose list shows it with kind/version/criticality JOINed', async () => {
  await withSandbox('forge-comp-adopt-sub-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    const { run } = await loadCompose(cli);

    const res = await run('adopt', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, `adopt failed: ${JSON.stringify(res.findings)}`);
    assert.strictEqual(res.data.changed, true);
    assert.strictEqual(res.data.written, true, '--apply persists');
    assert.deepStrictEqual(res.data.adopted, [{ uid: 'agent:hello', sourceId: 'fx' }]);

    // The on-disk file validates against the schema shape.
    const comp = readComp(project);
    assert.ok(comp, 'composition.json was created');
    assert.strictEqual(comp.schema, 'forge.composition.v1');
    assert.strictEqual(comp.version, 1);
    assert.deepStrictEqual(comp.adopted, [{ uid: 'agent:hello', sourceId: 'fx' }]);

    // list JOINs to the catalog record to resolve kind/version/criticality.
    const listRes = await run('list', [], { cwd: project });
    assert.strictEqual(listRes.ok, true, `list failed: ${JSON.stringify(listRes.findings)}`);
    assert.strictEqual(listRes.data.adopted.length, 1);
    const entry = listRes.data.adopted[0];
    assert.strictEqual(entry.uid, 'agent:hello');
    assert.strictEqual(entry.sourceId, 'fx');
    assert.strictEqual(entry.kind, 'agent', 'kind resolved from the catalog record');
    assert.strictEqual(entry.version, '0.1.0', 'version resolved from the catalog record');
    assert.strictEqual(entry.criticality, 'normal', 'criticality resolved from the catalog record');
    assert.deepStrictEqual(listRes.data.counts, { adopted: 1, sources: 1 });
  });
});

// ===========================================================================
// adopt — NON-read-view (unsubscribed) resource is REFUSED
// ===========================================================================

test('adopt of an UNSUBSCRIBED (non-read-view) resource is REFUSED with an ERROR and writes nothing', async () => {
  await withSandbox('forge-comp-adopt-unsub-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    // Subscribe ONLY fx/agent — fx/skill stays out of the read-view.
    await subscribe(cli, project, 'fx/agent');
    const { run } = await loadCompose(cli);

    const res = await run('adopt', ['skill:greet', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, false, 'a non-read-view resource cannot be adopted');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /read-view/.test(f.message)));
    assert.strictEqual(readComp(project), null, 'nothing persisted');

    // Once its slice IS subscribed, the same adopt succeeds (read-view gate, BR-CAT-008).
    await subscribe(cli, project, 'fx/skill');
    const ok = await run('adopt', ['skill:greet', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(ok.ok, true, `adopt after subscribe failed: ${JSON.stringify(ok.findings)}`);
    assert.deepStrictEqual(readComp(project).adopted, [{ uid: 'skill:greet', sourceId: 'fx' }]);
  });
});

// ===========================================================================
// adopt — library-local (sourceId === null, no --source)
// ===========================================================================

test('adopt library-local: no --source needed; entry sourceId is null', async () => {
  await withSandbox('forge-comp-adopt-lib-', async ({ cli, project }) => {
    const { run } = await loadCompose(cli);
    const uid = await firstLibraryLocalUid(cli);

    const res = await run('adopt', [uid, '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, `library-local adopt failed: ${JSON.stringify(res.findings)}`);
    assert.strictEqual(res.data.sourceId, null, 'library-local entry has sourceId null');
    assert.strictEqual(res.data.written, true);
    assert.deepStrictEqual(readComp(project).adopted, [{ uid, sourceId: null }]);

    const listRes = await run('list', [], { cwd: project });
    assert.strictEqual(listRes.data.adopted.length, 1);
    assert.strictEqual(listRes.data.adopted[0].sourceId, null);
    assert.deepStrictEqual(listRes.data.counts, { adopted: 1, sources: 0 }, 'library-local adds no source');
  });
});

// ===========================================================================
// adopt — source-only uid with --source OMITTED -> ERROR asking for --source
// ===========================================================================

test('adopt: a source-only uid with NO --source ERRORs asking for --source (never guesses)', async () => {
  await withSandbox('forge-comp-adopt-ambig-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    const { run } = await loadCompose(cli);

    // agent:hello is visible ONLY from source fx (no library-local copy) and --source omitted.
    const res = await run('adopt', ['agent:hello', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, false, 'a source-only uid without --source is refused');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /--source/.test(f.message)),
      'the error asks for --source');
    assert.strictEqual(readComp(project), null, 'nothing persisted');
  });
});

// ===========================================================================
// remove — reverses an adopt
// ===========================================================================

test('remove --apply: reverses an adopt (list shows it gone)', async () => {
  await withSandbox('forge-comp-remove-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    const { run } = await loadCompose(cli);

    await run('adopt', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project });
    assert.deepStrictEqual(readComp(project).adopted, [{ uid: 'agent:hello', sourceId: 'fx' }]);

    const res = await run('remove', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.changed, true);
    assert.strictEqual(res.data.written, true);
    assert.deepStrictEqual(res.data.adopted, [], 'agent:hello removed');
    assert.deepStrictEqual(readComp(project).adopted, [], 'persisted empty set');

    const listRes = await run('list', [], { cwd: project });
    assert.strictEqual(listRes.data.adopted.length, 0, 'nothing adopted after remove');
  });
});

test('remove: an absent entry is an idempotent WARN no-op (no file created)', async () => {
  await withSandbox('forge-comp-remove-absent-', async ({ cli, project }) => {
    const { run } = await loadCompose(cli);
    const res = await run('remove', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, 'absent remove is a soft warn, not an error');
    assert.strictEqual(res.data.changed, false);
    assert.strictEqual(res.data.written, false);
    assert.ok(res.findings.some((f) => f.level === 'WARN' && /nothing to remove/.test(f.message)));
    assert.strictEqual(readComp(project), null, 'no file created by an absent-entry no-op');
  });
});

// ===========================================================================
// idempotent re-adopt — one entry, no dup
// ===========================================================================

test('adopt: idempotent re-adopt is a no-op WARN (no duplicate entry)', async () => {
  await withSandbox('forge-comp-adopt-idem-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    const { run } = await loadCompose(cli);

    await run('adopt', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project });
    const res = await run('adopt', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, 're-adopt is a soft no-op, not an error');
    assert.strictEqual(res.data.changed, false, 'no change on re-adopt');
    assert.strictEqual(res.data.written, false, 'nothing to write');
    assert.ok(res.findings.some((f) => f.level === 'WARN' && /already adopted/.test(f.message)));
    assert.deepStrictEqual(readComp(project).adopted, [{ uid: 'agent:hello', sourceId: 'fx' }],
      'still a single entry');
  });
});

// ===========================================================================
// preview (no --apply) writes nothing
// ===========================================================================

test('adopt: preview by default writes NOTHING (no --apply)', async () => {
  await withSandbox('forge-comp-adopt-preview-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    const { run } = await loadCompose(cli);

    const res = await run('adopt', ['agent:hello', '--source', 'fx'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.changed, true, 'plan shows the would-add change');
    assert.strictEqual(res.data.written, false, 'preview never writes');
    assert.strictEqual(readComp(project), null, 'no composition file created by a preview');
  });
});

// ===========================================================================
// orphaned entry — unsubscribe after adopt -> list WARN but entry RETAINED
// ===========================================================================

test('orphan: unsubscribing a slice after adopt lists the entry as a WARN but RETAINS it in the file', async () => {
  await withSandbox('forge-comp-orphan-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    const { run } = await loadCompose(cli);

    await run('adopt', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project });
    assert.deepStrictEqual(readComp(project).adopted, [{ uid: 'agent:hello', sourceId: 'fx' }]);

    // Unsubscribe the slice -> agent:hello leaves the read-view (an orphan).
    await unsubscribe(cli, project, 'fx/agent');

    const listRes = await run('list', [], { cwd: project });
    assert.strictEqual(listRes.ok, true);
    assert.strictEqual(listRes.data.adopted.length, 0, 'orphan is listed-out of the JOINed set');
    assert.ok(listRes.findings.some((f) => f.level === 'WARN' && /orphan/.test(f.message)),
      'orphan is surfaced as a WARN');
    // CRITICAL: the entry is RETAINED in the file (never silently deleted, BR-CAT-009).
    assert.deepStrictEqual(readComp(project).adopted, [{ uid: 'agent:hello', sourceId: 'fx' }],
      'orphaned entry retained on disk — removal is always an explicit compose remove');
  });
});

// ===========================================================================
// library-local + source dual adoption — two DISTINCT entries (the (uid,sourceId) key)
// ===========================================================================

test('adopt: the same uid library-local and from a source are two DISTINCT entries', async () => {
  await withSandbox('forge-comp-dual-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    const { run } = await loadCompose(cli);
    const libUid = await firstLibraryLocalUid(cli);

    await run('adopt', [libUid, '--apply'], { cwd: project }); // library-local (sourceId null)
    await run('adopt', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project }); // source fx
    const comp = readComp(project);
    assert.strictEqual(comp.adopted.length, 2, 'two distinct (uid, sourceId) entries');
    // Deterministic sort: by uid then sourceId (null first).
    assert.ok(comp.adopted.some((e) => e.uid === libUid && e.sourceId === null));
    assert.ok(comp.adopted.some((e) => e.uid === 'agent:hello' && e.sourceId === 'fx'));
  });
});

// ===========================================================================
// unknown verb — ok:false + ERROR + usage (the bin maps this to exit 2)
// ===========================================================================

test('unknown verb: returns ok:false with an ERROR finding + usage banner', async () => {
  await withSandbox('forge-comp-unknown-', async ({ cli, project }) => {
    const { run } = await loadCompose(cli);
    const res = await run('frobnicate', [], { cwd: project });
    assert.strictEqual(res.ok, false, 'an unknown sub-verb is not ok');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /unknown compose subcommand/.test(f.message)));
    assert.ok(res.data && typeof res.data.usage === 'string', 'usage banner present in data');
  });
});

test('adopt: missing <uid> is an ERROR with usage (no write)', async () => {
  await withSandbox('forge-comp-adopt-missing-', async ({ cli, project }) => {
    const { run } = await loadCompose(cli);
    const res = await run('adopt', [], { cwd: project });
    assert.strictEqual(res.ok, false);
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /requires a <uid>/.test(f.message)));
    assert.strictEqual(readComp(project), null, 'nothing persisted');
  });
});
