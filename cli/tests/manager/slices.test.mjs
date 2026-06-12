// @ts-check
/**
 * slices.test.mjs — deterministic acceptance specs for the catalog SLICE + per-project
 * SUBSCRIPTION operator (manager/slices.mjs, ADR-0018). Built-in node:test + node:assert
 * ONLY (zero runtime deps — every import is a node: builtin or a relative path).
 *
 * Run model: `node --test tests/manager/slices.test.mjs`.
 *
 * SANDBOX DISCIPLINE (NEVER mutate the real repo):
 *   - slices.mjs REUSES catalog.mjs `run('build')` for its record production; catalog.mjs
 *     resolves its FORGE_ROOT from `import.meta.url` (two levels up from manager/) and the
 *     synced-source cache from `$HOME`/`~`. We therefore COPY the whole `cli/` tree into a
 *     fresh os.tmpdir() sandbox and import `manager/slices.mjs` FROM THE COPY, so the
 *     catalog scan reads the sandbox library + a sandboxed source cache. We point `$HOME`
 *     at a sandbox sub-dir so `forge source sync` clones into the sandbox cache. The
 *     subscriptions file is written under a SANDBOX project root we pass via `ctx.cwd`, so
 *     no write ever lands in the real repo. HOME is restored after each test; the sandbox
 *     tree is removed.
 *   - Each test imports a FRESH module copy via a cache-busting query string so module
 *     top-level state never leaks between tests.
 *
 * Coverage:
 *   list         — derives slices by source+kind with correct counts + ids "<sourceId>/<kind>";
 *                  library-local records are never sliced; --source filters; empty registry
 *                  is a valid empty envelope.
 *   subscribe    — preview (no --apply) writes NOTHING; --apply writes + list shows subscribed:true;
 *                  idempotent re-subscribe; invalid slice id rejected.
 *   unsubscribe  — reverses a subscribe (--apply); idempotent absent no-op; additive (other ids kept).
 *   unknown verb — ok:false + ERROR finding + usage (the bin maps this to exit 2).
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
// Sandbox helpers — copy cli/ into /tmp, import slices.mjs from the copy.
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
 * DELIBERATELY skip the existing `tests/`, `.git`, and `node_modules` trees from the copy
 * (slices.mjs + the catalog.mjs it reuses only need manager/, manifests/, .forge/, agents/,
 * skills/, lib/, VERSION). A `project` sub-dir is the active root we point subscriptions at.
 */
function makeSandbox(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cli = path.join(root, 'cli');
  copyTree(REAL_FORGE_ROOT, cli, new Set(['.git', 'node_modules', 'tests']));
  // Point HOME at a sandbox sub-dir so the sync cache (~/.claude/forge-sources) is sandboxed.
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  // The active PROJECT root subscriptions are written under (per-project state, ADR-0018).
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  return { root, cli, home, project };
}

/** Import a FRESH copy of the sandbox's slices.mjs (cache-busted per call). */
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

/** Read the sandbox project's subscriptions file (or null when absent). */
function readSubs(project) {
  try {
    return JSON.parse(fs.readFileSync(path.join(project, '.forge', 'subscriptions.json'), 'utf8'));
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
 * `source sync` these become two slices (fx/agent count 1, fx/skill count 1).
 * Returns { repo, commit }.
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
      'description: An upstream fixture agent used to exercise slice derivation by kind.',
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
      'description: An upstream fixture skill used to exercise slice derivation by a second kind.',
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
 * catalog (and therefore slice derivation) has real source records. Returns the fixture.
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

// ===========================================================================
// list — slice derivation by source + kind
// ===========================================================================

test('list: empty registry is a valid empty envelope (no slices, ok=true)', async () => {
  await withSandbox('forge-slice-list-empty-', async ({ cli, project }) => {
    const { run } = await loadSlices(cli);
    const res = await run('list', [], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.ok(Array.isArray(res.data.sources), 'sources is an array');
    assert.strictEqual(res.data.sources.length, 0, 'no source slices with no synced source');
    assert.ok(typeof res.data.subscriptionsPath === 'string', 'subscriptionsPath is present');
  });
});

test('list: derives slices by source+kind with id "<sourceId>/<kind>", name=kind, count, subscribed:false', async () => {
  await withSandbox('forge-slice-list-derive-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    const { run } = await loadSlices(cli);
    const res = await run('list', [], { cwd: project });
    assert.strictEqual(res.ok, true, `list failed: ${JSON.stringify(res.findings)}`);

    const fxEntry = res.data.sources.find((s) => s.sourceId === 'fx');
    assert.ok(fxEntry, 'fx source appears with slices');
    const byId = new Map(fxEntry.slices.map((sl) => [sl.id, sl]));

    const agent = byId.get('fx/agent');
    assert.ok(agent, 'fx/agent slice derived');
    assert.strictEqual(agent.kind, 'agent', 'slice kind is the registry kind');
    assert.strictEqual(agent.name, 'agent', 'slice name is the kind');
    assert.strictEqual(agent.count, 1, 'one agent record => count 1');
    assert.strictEqual(agent.subscribed, false, 'new slice defaults UNSUBSCRIBED (opt-in)');

    const skill = byId.get('fx/skill');
    assert.ok(skill, 'fx/skill slice derived');
    assert.strictEqual(skill.kind, 'skill');
    assert.strictEqual(skill.count, 1, 'one skill record => count 1');
    assert.strictEqual(skill.subscribed, false);

    assert.strictEqual(res.summary.subscribed, 0, 'nothing subscribed yet');
  });
});

test('list: library-local records (source === null) are NEVER sliced', async () => {
  await withSandbox('forge-slice-list-liblocal-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    const { run } = await loadSlices(cli);
    const res = await run('list', [], { cwd: project });
    assert.strictEqual(res.ok, true);
    // Every emitted slice id is "<sourceId>/<kind>" and every source entry has a non-empty
    // sourceId — a null-source (library-local) record could never produce a slice id.
    for (const srcEntry of res.data.sources) {
      assert.ok(srcEntry.sourceId && srcEntry.sourceId.length > 0, 'no empty-sourceId (library-local) entry');
      for (const sl of srcEntry.slices) {
        assert.ok(sl.id.startsWith(`${srcEntry.sourceId}/`), `slice id is "<sourceId>/<kind>": ${sl.id}`);
      }
    }
    // The library itself has many agent/skill records, but the ONLY sliced source is fx.
    const ids = res.data.sources.map((s) => s.sourceId);
    assert.deepStrictEqual(ids, ['fx'], 'only the synced source is sliced, never the library');
  });
});

test('list --source <id>: filters to one source\'s slices', async () => {
  await withSandbox('forge-slice-list-filter-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    const { run } = await loadSlices(cli);
    const res = await run('list', ['--source', 'fx'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.sources.map((s) => s.sourceId), ['fx']);
    // A non-existent source filter yields zero sources + an INFO finding.
    const none = await run('list', ['--source', 'nope'], { cwd: project });
    assert.strictEqual(none.ok, true);
    assert.strictEqual(none.data.sources.length, 0);
    assert.ok(none.findings.some((f) => f.level === 'INFO' && /no slices for source/.test(f.message)));
  });
});

// ===========================================================================
// subscribe — preview vs --apply, idempotent, subscribed:true round-trips through list
// ===========================================================================

test('subscribe: preview by default writes NOTHING (no --apply)', async () => {
  await withSandbox('forge-slice-sub-preview-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    const { run } = await loadSlices(cli);
    const before = readSubs(project);
    const res = await run('subscribe', ['fx/agent'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.changed, true, 'plan shows the would-add change');
    assert.strictEqual(res.data.written, false, 'preview never writes');
    assert.strictEqual(readSubs(project), before, 'no subscriptions file created by a preview');
  });
});

test('subscribe --apply: writes the file and list then shows subscribed:true', async () => {
  await withSandbox('forge-slice-sub-apply-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    const { run } = await loadSlices(cli);
    const res = await run('subscribe', ['fx/agent', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, `subscribe failed: ${JSON.stringify(res.findings)}`);
    assert.strictEqual(res.data.written, true, '--apply persists');
    assert.deepStrictEqual(res.data.subscribed, ['fx/agent']);

    // The on-disk file validates against the schema shape.
    const subs = readSubs(project);
    assert.ok(subs, 'subscriptions.json was created');
    assert.strictEqual(subs.schema, 'forge.subscriptions.v1');
    assert.strictEqual(subs.version, 1);
    assert.deepStrictEqual(subs.subscribed, ['fx/agent']);

    // list now reflects the subscription on the fx/agent slice (and NOT fx/skill).
    const listRes = await run('list', [], { cwd: project });
    const byId = new Map(listRes.data.sources.find((s) => s.sourceId === 'fx').slices.map((sl) => [sl.id, sl]));
    assert.strictEqual(byId.get('fx/agent').subscribed, true, 'fx/agent now subscribed:true');
    assert.strictEqual(byId.get('fx/skill').subscribed, false, 'fx/skill stays unsubscribed');
    assert.strictEqual(listRes.summary.subscribed, 1, 'one subscribed slice');
  });
});

test('subscribe: idempotent re-subscribe is a no-op WARN (no duplicate)', async () => {
  await withSandbox('forge-slice-sub-idem-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    const { run } = await loadSlices(cli);
    await run('subscribe', ['fx/agent', '--apply'], { cwd: project });
    const res = await run('subscribe', ['fx/agent', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, 're-subscribe is a soft no-op, not an error');
    assert.strictEqual(res.data.changed, false, 'no change on re-subscribe');
    assert.strictEqual(res.data.written, false, 'nothing to write');
    assert.ok(res.findings.some((f) => f.level === 'WARN' && /already subscribed/.test(f.message)));
    assert.deepStrictEqual(readSubs(project).subscribed, ['fx/agent'], 'still a single entry');
  });
});

test('subscribe: an invalid slice id is REJECTED with an ERROR and writes nothing', async () => {
  await withSandbox('forge-slice-sub-badid-', async ({ cli, project }) => {
    const { run } = await loadSlices(cli);
    const res = await run('subscribe', ['not-a-slice-id', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, false, 'a bad slice id fails (needs "<sourceId>/<kind>")');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /invalid slice id/.test(f.message)));
    assert.strictEqual(readSubs(project), null, 'nothing persisted');
  });
});

// ===========================================================================
// unsubscribe — reverses a subscribe, idempotent, additive (preserves other ids)
// ===========================================================================

test('unsubscribe --apply: reverses a subscribe (list shows subscribed:false again)', async () => {
  await withSandbox('forge-slice-unsub-apply-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    const { run } = await loadSlices(cli);
    await run('subscribe', ['fx/agent', '--apply'], { cwd: project });
    const res = await run('unsubscribe', ['fx/agent', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.changed, true);
    assert.strictEqual(res.data.written, true);
    assert.deepStrictEqual(res.data.subscribed, [], 'fx/agent removed');
    assert.deepStrictEqual(readSubs(project).subscribed, [], 'persisted empty set');

    const listRes = await run('list', [], { cwd: project });
    const agent = listRes.data.sources.find((s) => s.sourceId === 'fx').slices.find((sl) => sl.id === 'fx/agent');
    assert.strictEqual(agent.subscribed, false, 'fx/agent unsubscribed again');
  });
});

test('unsubscribe: is ADDITIVE — removing one id preserves the others', async () => {
  await withSandbox('forge-slice-unsub-additive-', async ({ cli, root, project }) => {
    await syncFixtureSource(cli, root);
    const { run } = await loadSlices(cli);
    await run('subscribe', ['fx/agent', '--apply'], { cwd: project });
    await run('subscribe', ['fx/skill', '--apply'], { cwd: project });
    assert.deepStrictEqual(readSubs(project).subscribed, ['fx/agent', 'fx/skill'], 'both subscribed (sorted)');
    const res = await run('unsubscribe', ['fx/agent', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.subscribed, ['fx/skill'], 'only fx/agent removed; fx/skill preserved');
    assert.deepStrictEqual(readSubs(project).subscribed, ['fx/skill'], 'persisted with the other id intact');
  });
});

test('unsubscribe: absent id is an idempotent WARN no-op', async () => {
  await withSandbox('forge-slice-unsub-absent-', async ({ cli, project }) => {
    const { run } = await loadSlices(cli);
    const res = await run('unsubscribe', ['fx/agent', '--apply'], { cwd: project });
    assert.strictEqual(res.ok, true, 'absent unsubscribe is a soft warn, not an error');
    assert.strictEqual(res.data.changed, false);
    assert.strictEqual(res.data.written, false);
    assert.ok(res.findings.some((f) => f.level === 'WARN' && /not subscribed/.test(f.message)));
    assert.strictEqual(readSubs(project), null, 'no file created by an absent-id no-op');
  });
});

// ===========================================================================
// unknown verb — ok:false + ERROR + usage (the bin maps this to exit 2)
// ===========================================================================

test('unknown verb: returns ok:false with an ERROR finding + usage banner', async () => {
  await withSandbox('forge-slice-unknown-', async ({ cli, project }) => {
    const { run } = await loadSlices(cli);
    const res = await run('frobnicate', [], { cwd: project });
    assert.strictEqual(res.ok, false, 'an unknown sub-verb is not ok');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /unknown slice subcommand/.test(f.message)));
    assert.ok(res.data && typeof res.data.usage === 'string', 'usage banner present in data');
  });
});

test('subscribe: missing <sliceId> is an ERROR with usage (no write)', async () => {
  await withSandbox('forge-slice-sub-missing-', async ({ cli, project }) => {
    const { run } = await loadSlices(cli);
    const res = await run('subscribe', [], { cwd: project });
    assert.strictEqual(res.ok, false);
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /requires a <sliceId>/.test(f.message)));
    assert.strictEqual(readSubs(project), null, 'nothing persisted');
  });
});
