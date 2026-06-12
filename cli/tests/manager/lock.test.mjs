// @ts-check
/**
 * lock.test.mjs — deterministic acceptance specs for the per-project LOCKFILE operator
 * (manager/lock.mjs, ADR-0022). Built-in node:test + node:assert ONLY (zero runtime deps — every
 * import is a node: builtin or a relative path).
 *
 * Run model: `node --test tests/manager/lock.test.mjs`.
 *
 * SANDBOX DISCIPLINE (NEVER mutate the real repo):
 *   - lock.mjs REUSES compose.mjs/tailor.mjs/conflict.mjs read helpers, which in turn reuse
 *     catalog.mjs `run('build'/'dedup')`; catalog.mjs resolves its FORGE_ROOT from `import.meta.url`
 *     (two levels up from manager/) and the synced-source cache from `$HOME`/`~`. We therefore COPY
 *     the whole `cli/` tree into a fresh os.tmpdir() sandbox and import `manager/lock.mjs` FROM THE
 *     COPY, so the catalog scan reads the sandbox library + a sandboxed source cache. We point
 *     `$HOME` at a sandbox sub-dir so `forge source sync` clones into the sandbox cache. forge.lock
 *     (and composition/tailoring/adjudication) are written under a SANDBOX project root we pass via
 *     `ctx.cwd`, so no write ever lands in the real repo. HOME is restored after each test; the
 *     sandbox tree is removed.
 *   - Each test imports a FRESH module copy via a cache-busting query string so module top-level
 *     state never leaks between tests.
 *
 * Coverage (the Slice 5 contract):
 *   adopt+tailor a resource -> lock write --apply -> forge.lock has entries + hash;
 *   write again -> IDENTICAL hash (determinism);
 *   hash EXCLUDES generatedAt (two writes differ in generatedAt but share the hash);
 *   change an overlay -> hash changes;
 *   show -> exists/inSync true after write, false after a change;
 *   diff after a change -> the +/~/- changes;
 *   preview (no --apply) writes NOTHING;
 *   ASSERT .claude/ is NEVER written by lock write;
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
// Sandbox helpers — copy cli/ into /tmp, import lock.mjs from the copy.
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
 * Build a fresh sandbox: copy cli/ into os.tmpdir()/<prefix> and return its paths. We DELIBERATELY
 * skip the existing `tests/`, `.git`, and `node_modules` trees. A `project` sub-dir is the active
 * root we point forge.lock / composition / tailoring / adjudication at.
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

/** Minimal pathToFileURL (avoid importing url just for this; build a file:// URL). */
function pathToFileURL(p) {
  return 'file://' + path.resolve(p).split(path.sep).join('/').replace(/^([A-Za-z]):/, '/$1:');
}

/** Import a FRESH copy of a sandbox manager module (cache-busted per call). */
async function loadMod(cli, name) {
  const mod = path.join(cli, 'manager', name);
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

/** Read the sandbox project's forge.lock (or null when absent). */
function readLockFile(project) {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, 'forge.lock'), 'utf8'));
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
 * Build a local upstream git fixture repo on branch `main` carrying one agent (agents/hello.md), so
 * after a `source sync` it becomes a slice (fx/agent) we can subscribe + adopt + tailor.
 */
function makeFixture(root) {
  const repo = path.join(root, 'upstream');
  fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'agents', 'hello.md'),
    [
      '---',
      'name: hello',
      'description: An upstream fixture agent used to exercise the project lockfile resolution.',
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
  git(repo, 'commit', '-q', '-m', 'upstream lock fixture');
  const commit = git(repo, 'rev-parse', 'HEAD');
  return { repo, commit };
}

/**
 * Register + sync a `fx` source from a local git fixture into the sandbox cache, so the catalog (and
 * therefore the compose read-view) has a real source record + a pinned commit in
 * <FORGE_ROOT>/.forge/sources.lock. Returns the fixture.
 */
async function syncFixtureSource(cli, root) {
  const fx = makeFixture(root);
  const { run: sourceRun } = await loadMod(cli, 'source.mjs');
  const addRes = await sourceRun('add', ['fx', `file://${fx.repo}`, '--ref', 'main', '--apply'], {});
  assert.strictEqual(addRes.ok, true, `source add failed: ${JSON.stringify(addRes.findings)}`);
  const syncRes = await sourceRun('sync', ['fx', '--apply', '--now', '2026-01-01T00:00:00Z'], {});
  assert.strictEqual(syncRes.ok, true, `source sync failed: ${JSON.stringify(syncRes.findings)}`);
  return fx;
}

/** Subscribe a slice id in the sandbox project (so its records enter the read-view). */
async function subscribe(cli, project, sliceId) {
  const { run } = await loadMod(cli, 'slices.mjs');
  const res = await run('subscribe', [sliceId, '--apply'], { cwd: project });
  assert.strictEqual(res.ok, true, `subscribe ${sliceId} failed: ${JSON.stringify(res.findings)}`);
}

/** Adopt a (uid, source) into the sandbox project composition. */
async function adopt(cli, project, uid, source) {
  const { run } = await loadMod(cli, 'compose.mjs');
  const args = [uid, '--apply'];
  if (source) args.push('--source', source);
  const res = await run('adopt', args, { cwd: project });
  assert.strictEqual(res.ok, true, `adopt ${uid} failed: ${JSON.stringify(res.findings)}`);
}

/** Add a tailoring overlay to a (uid, source) in the sandbox project. */
async function tailorAdd(cli, project, uid, source, type, detail) {
  const { run } = await loadMod(cli, 'tailor.mjs');
  const args = [uid, '--type', type, '--detail', detail, '--apply'];
  if (source) args.push('--source', source);
  const res = await run('add', args, { cwd: project });
  assert.strictEqual(res.ok, true, `tailor add ${type} failed: ${JSON.stringify(res.findings)}`);
}

/** Remove a tailoring overlay by type from a (uid, source) in the sandbox project. */
async function tailorRemove(cli, project, uid, source, type) {
  const { run } = await loadMod(cli, 'tailor.mjs');
  const args = [uid, '--type', type, '--apply'];
  if (source) args.push('--source', source);
  const res = await run('remove', args, { cwd: project });
  assert.strictEqual(res.ok, true, `tailor remove ${type} failed: ${JSON.stringify(res.findings)}`);
}

/** Assert NO .claude/ tree was created under the project root (MANIFEST-ONLY, BR-CAT-019). */
function assertNoClaudeDir(project) {
  assert.strictEqual(
    fs.existsSync(path.join(project, '.claude')),
    false,
    'lock write MUST NOT materialize .claude/ (MANIFEST-ONLY, BR-CAT-019)',
  );
}

// ===========================================================================
// write — adopt + tailor a resource, write the lock, assert entries + hash
// ===========================================================================

test('write --apply: forge.lock has one entry per composed (uid,sourceId) with kind/version/commit/overlays/hash', async () => {
  await withSandbox('forge-lock-write-', async ({ cli, root, project }) => {
    const fx = await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    await adopt(cli, project, 'agent:hello', 'fx');
    await tailorAdd(cli, project, 'agent:hello', 'fx', 'pin', 'v9.9.9');

    const { run } = await loadMod(cli, 'lock.mjs');
    const res = await run('write', ['--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, `lock write failed: ${JSON.stringify(res.findings)}`);
    assert.strictEqual(res.data.written, true, '--apply persists');

    const lock = readLockFile(project);
    assert.ok(lock, 'forge.lock was created');
    assert.strictEqual(lock.schema, 'forge.lock.v1');
    assert.strictEqual(lock.version, 1);
    assert.ok(typeof lock.hash === 'string' && /^[0-9a-f]{8,64}$/.test(lock.hash), 'a hex content hash');
    assert.ok(typeof lock.generatedAt === 'string' && lock.generatedAt.length > 0, 'an ISO generatedAt');
    assert.strictEqual(lock.entries.length, 1, 'one entry per composed (uid,sourceId)');

    const e = lock.entries[0];
    assert.strictEqual(e.uid, 'agent:hello');
    assert.strictEqual(e.sourceId, 'fx');
    assert.strictEqual(e.kind, 'agent', 'kind JOINed from the catalog record');
    assert.strictEqual(e.version, 'v9.9.9', 'pin overlay wins the resolved version (ADR-0021 §3)');
    assert.strictEqual(e.commit, fx.commit, 'commit JOINed from .forge/sources.lock');
    assert.ok(e.overlays.some((o) => o.type === 'pin' && o.detail === 'v9.9.9'), 'overlay folded in');
    assert.strictEqual(e.adjudication, null, 'no conflict -> no adjudication winner');

    // MANIFEST-ONLY: no .claude/ materialized.
    assertNoClaudeDir(project);
  });
});

// ===========================================================================
// determinism — re-write yields the IDENTICAL hash; hash EXCLUDES generatedAt
// ===========================================================================

test('write: re-writing an UNCHANGED composition yields the IDENTICAL hash, and the hash EXCLUDES generatedAt', async () => {
  await withSandbox('forge-lock-determinism-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    await adopt(cli, project, 'agent:hello', 'fx');

    const { run } = await loadMod(cli, 'lock.mjs');
    const first = await run('write', ['--apply'], { cwd: project });
    const lock1 = readLockFile(project);
    assert.ok(lock1 && typeof lock1.hash === 'string');

    // Second write of the SAME composition. The hash must be identical even though generatedAt may
    // differ (the hash is over the canonical entries only — BR-CAT-018).
    const second = await run('write', ['--apply'], { cwd: project });
    const lock2 = readLockFile(project);

    assert.strictEqual(first.data.hash, second.data.hash, 'same composition -> same hash (determinism)');
    assert.strictEqual(lock1.hash, lock2.hash, 'persisted hash is stable across re-writes');
    assert.strictEqual(second.data.changed, false, 'an unchanged composition reports no change');

    // PROOF the hash excludes generatedAt: tamper generatedAt in the on-disk lock, recompute via
    // a fresh write of the SAME composition — the hash must not move.
    const tampered = { ...lock2, generatedAt: '1999-12-31T23:59:59Z' };
    fs.writeFileSync(path.join(project, 'forge.lock'), JSON.stringify(tampered, null, 2) + '\n');
    const third = await run('write', ['--apply'], { cwd: project });
    assert.strictEqual(third.data.hash, lock2.hash, 'hash unaffected by a different generatedAt (EXCLUDES generatedAt)');
  });
});

// ===========================================================================
// overlay change -> hash changes
// ===========================================================================

test('write: changing a tailoring overlay CHANGES the hash', async () => {
  await withSandbox('forge-lock-overlay-change-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    await adopt(cli, project, 'agent:hello', 'fx');

    const { run } = await loadMod(cli, 'lock.mjs');
    const before = await run('write', ['--apply'], { cwd: project });
    const hashBefore = before.data.hash;

    // Add an overlay -> the resolved entry changes -> the hash must move.
    await tailorAdd(cli, project, 'agent:hello', 'fx', 'override', 'model → opus');
    const after = await run('write', ['--apply'], { cwd: project });
    assert.notStrictEqual(after.data.hash, hashBefore, 'a new overlay changes the content hash');
    assert.strictEqual(after.data.changed, true, 'the write reports a change vs the prior lock');
  });
});

// ===========================================================================
// show — exists/inSync true after write, false after a change
// ===========================================================================

test('show: exists + inSync true right after a write; inSync false after the composition changes', async () => {
  await withSandbox('forge-lock-show-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    await adopt(cli, project, 'agent:hello', 'fx');

    const { run } = await loadMod(cli, 'lock.mjs');

    // Before any write: no lock, inSync false.
    const pre = await run('show', [], { cwd: project });
    assert.strictEqual(pre.ok, true);
    assert.strictEqual(pre.data.exists, false, 'no forge.lock yet');
    assert.strictEqual(pre.data.inSync, false);
    assert.ok(typeof pre.data.lockPath === 'string', 'lockPath present');

    await run('write', ['--apply'], { cwd: project });
    const post = await run('show', [], { cwd: project });
    assert.strictEqual(post.data.exists, true, 'forge.lock exists after write');
    assert.strictEqual(post.data.inSync, true, 'file hash === freshly-resolved hash right after write');
    assert.strictEqual(typeof post.data.committed, 'boolean', 'committed is a best-effort boolean');
    assert.ok(post.data.lock && Array.isArray(post.data.lock.entries), 'lock contents returned');

    // Change the composition (add an overlay) -> the lock is now STALE.
    await tailorAdd(cli, project, 'agent:hello', 'fx', 'disable', '');
    const stale = await run('show', [], { cwd: project });
    assert.strictEqual(stale.data.exists, true, 'lock still on disk');
    assert.strictEqual(stale.data.inSync, false, 'inSync false after a composition change');
    assert.ok(stale.findings.some((f) => f.level === 'WARN' && /STALE/.test(f.message)), 'a STALE warning');
  });
});

// ===========================================================================
// diff — after a change, the +/~/- changes
// ===========================================================================

test('diff: surfaces ~ (changed) / + (added) / - (removed) entries vs the current lock', async () => {
  await withSandbox('forge-lock-diff-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    await adopt(cli, project, 'agent:hello', 'fx');

    const { run } = await loadMod(cli, 'lock.mjs');
    await run('write', ['--apply'], { cwd: project });

    // In sync immediately after write: no changes.
    const clean = await run('diff', [], { cwd: project });
    assert.strictEqual(clean.ok, true);
    assert.strictEqual(clean.data.changes.length, 0, 'no changes right after write');
    assert.strictEqual(clean.data.inSync, true);

    // ~ change: add an overlay (the entry's overlays/version move, the entry stays).
    await tailorAdd(cli, project, 'agent:hello', 'fx', 'pin', 'v2.0.0');
    const tilde = await run('diff', [], { cwd: project });
    assert.strictEqual(tilde.data.inSync, false);
    assert.strictEqual(tilde.data.summary.changed, 1, 'one ~ change');
    const ch = tilde.data.changes.find((c) => c.uid === 'agent:hello');
    assert.ok(ch && ch.op === '~', 'agent:hello shows as a ~ change');
    assert.ok(/version|overlays/.test(ch.note), 'note describes the version/overlay delta');

    // Re-write to absorb the ~ change, then a + addition: adopt a library-local resource.
    await run('write', ['--apply'], { cwd: project });
    const libUid = await firstLibraryLocalUid(cli);
    await adopt(cli, project, libUid, null);
    const plus = await run('diff', [], { cwd: project });
    assert.ok(plus.data.changes.some((c) => c.op === '+' && c.uid === libUid), 'the new library-local entry is a + addition');
    assert.ok(plus.data.summary.added >= 1);

    // Re-write, then a - removal: remove the agent:hello overlay's resource by un-adopting it.
    await run('write', ['--apply'], { cwd: project });
    const { run: composeRun } = await loadMod(cli, 'compose.mjs');
    await composeRun('remove', ['agent:hello', '--source', 'fx', '--apply'], { cwd: project });
    const minus = await run('diff', [], { cwd: project });
    assert.ok(minus.data.changes.some((c) => c.op === '-' && c.uid === 'agent:hello'), 'the dropped entry is a - removal');
    assert.ok(minus.data.summary.removed >= 1);
  });
});

/** Find a library-local uid (source === null) from the sandbox catalog (first agent, sorted). */
async function firstLibraryLocalUid(cli) {
  const { run } = await loadMod(cli, 'catalog.mjs');
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
// preview (no --apply) writes nothing + never materializes .claude/
// ===========================================================================

test('write: preview by default writes NOTHING (no forge.lock, no .claude/)', async () => {
  await withSandbox('forge-lock-preview-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    await adopt(cli, project, 'agent:hello', 'fx');

    const { run } = await loadMod(cli, 'lock.mjs');
    const res = await run('write', [], { cwd: project }); // NO --apply
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.written, false, 'preview never writes');
    assert.ok(typeof res.data.hash === 'string', 'the would-be hash is still computed');
    assert.ok(res.data.lock && Array.isArray(res.data.lock.entries), 'the would-be lock is returned');
    assert.strictEqual(readLockFile(project), null, 'no forge.lock created by a preview');
    assertNoClaudeDir(project);
  });
});

// ===========================================================================
// MANIFEST-ONLY — lock write never materializes .claude/ even with overlays/adjudication
// ===========================================================================

test('write --apply: MANIFEST-ONLY — never materializes .claude/ (BR-CAT-019)', async () => {
  await withSandbox('forge-lock-manifest-only-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    await subscribe(cli, project, 'fx/agent');
    await adopt(cli, project, 'agent:hello', 'fx');
    await tailorAdd(cli, project, 'agent:hello', 'fx', 'fork', '');
    await tailorAdd(cli, project, 'agent:hello', 'fx', 'override', 'model → opus');

    const { run } = await loadMod(cli, 'lock.mjs');
    await run('write', ['--apply'], { cwd: project });
    assert.ok(readLockFile(project), 'forge.lock written');
    // The ONLY new top-level file under the project root is forge.lock (+ the .forge/ stores the
    // compose/tailor helpers already created); NO .claude/ tree.
    assertNoClaudeDir(project);
  });
});

// ===========================================================================
// unknown verb — ok:false + ERROR + usage (the bin maps this to exit 2)
// ===========================================================================

test('unknown verb: returns ok:false with an ERROR finding + usage banner', async () => {
  await withSandbox('forge-lock-unknown-', async ({ cli, project }) => {
    const { run } = await loadMod(cli, 'lock.mjs');
    const res = await run('frobnicate', [], { cwd: project });
    assert.strictEqual(res.ok, false, 'an unknown sub-verb is not ok');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /unknown lock subcommand/.test(f.message)));
    assert.ok(res.data && typeof res.data.usage === 'string', 'usage banner present in data');
  });
});

// ===========================================================================
// empty composition — a valid empty lock (no entries, a stable hash)
// ===========================================================================

test('write: an empty composition resolves to a valid empty lock (0 entries, a stable hash)', async () => {
  await withSandbox('forge-lock-empty-', async ({ cli, project }) => {
    const { run } = await loadMod(cli, 'lock.mjs');
    const a = await run('write', ['--apply'], { cwd: project });
    assert.strictEqual(a.ok, true);
    const lock = readLockFile(project);
    assert.ok(lock, 'forge.lock created for an empty composition');
    assert.strictEqual(lock.entries.length, 0, 'no entries');
    assert.ok(typeof lock.hash === 'string' && lock.hash.length >= 8, 'a stable empty-set hash');
    // Idempotent: a second write of the empty composition keeps the same hash.
    const b = await run('write', ['--apply'], { cwd: project });
    assert.strictEqual(a.data.hash, b.data.hash, 'empty-composition hash is stable');
    assertNoClaudeDir(project);
  });
});
