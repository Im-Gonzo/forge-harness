// @ts-check
/**
 * source.test.mjs — deterministic acceptance specs for the federated-source registry
 * operator (manager/source.mjs, ADR-0017). Built-in node:test + node:assert ONLY
 * (zero runtime deps — every import is a node: builtin or a relative path).
 *
 * Run model: `node --test tests/manager/source.test.mjs`.
 *
 * SANDBOX DISCIPLINE (NEVER mutate the real repo):
 *   - source.mjs resolves its FORGE_ROOT from `import.meta.url` (two levels up from
 *     manager/), its GLOBAL federation state (the sources manifest + sync lockfile) from
 *     FORGE_HOME (`$FORGE_HOME`, default `~/.forge`, ADR-0023), and its managed cache from
 *     `$HOME`/`~`. We therefore COPY the whole `cli/` tree into a fresh os.tmpdir() sandbox
 *     and import `manager/source.mjs` FROM THE COPY, and point `$HOME`/`$USERPROFILE` at a
 *     sandbox sub-dir so BOTH the global state (`<home>/.forge/manifests/sources.json`,
 *     `<home>/.forge/.forge/sources.lock`) AND the sync cache (`~/.claude/forge-sources`)
 *     land in the sandbox — never the cli/ checkout or the real repo. HOME is restored
 *     after each test and the sandbox tree is removed.
 *   - Each test imports a FRESH module copy via a cache-busting query string so module
 *     top-level state never leaks between tests.
 *
 * Coverage:
 *   add        — git default, local default, --kind auto-detect, invalid id/kind rejected.
 *   list       — enumerate the registered records.
 *   remove     — present (removed) and absent (WARN no-op).
 *   trust      — untrusted -> reviewed flip (apply), idempotent re-trust.
 *   sync       — dry-run plans nothing vs --apply clones + pins the lockfile commit,
 *                against a real file:// local git fixture; PLUS the no-exec guard:
 *                a planted git post-checkout hook + a postinstall in the upstream repo
 *                MUST NOT run during sync (no side-effect marker file is created).
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
// Sandbox helpers — copy cli/ into /tmp, import source.mjs from the copy.
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
 * Build a fresh sandbox: copy cli/ into os.tmpdir()/<prefix> and return its paths.
 * We DELIBERATELY skip the existing `tests/` and `.git`/node_modules trees from the
 * copy — source.mjs only needs manager/, manifests/, .forge/, VERSION — keeping the
 * copy small and fast while preserving the module's relative imports under manager/.
 */
function makeSandbox(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cli = path.join(root, 'cli');
  copyTree(REAL_FORGE_ROOT, cli, new Set(['.git', 'node_modules', 'tests']));
  // Point HOME at a sandbox sub-dir so the sync cache (~/.claude/forge-sources) is sandboxed.
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { root, cli, home };
}

/** Import a FRESH copy of the sandbox's source.mjs (cache-busted per call). */
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

/**
 * The GLOBAL config root the manager persists federation state under (ADR-0023:
 * `$FORGE_HOME`, default `~/.forge`). The sandbox points `$HOME`/`$USERPROFILE` at
 * `sb.home`, so this resolves to `<sb.home>/.forge` — every manifest/lock write lands
 * there, NOT inside the cli/ checkout. Mirrors `store.mjs#forgeHome`.
 */
function forgeHomeDir() {
  const env = process.env.FORGE_HOME;
  if (env) return path.resolve(env);
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.forge');
}

/** Read the GLOBAL sources manifest (`<FORGE_HOME>/manifests/sources.json`), or null when absent. */
function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(forgeHomeDir(), 'manifests', 'sources.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Read the GLOBAL sync lockfile (`<FORGE_HOME>/.forge/sources.lock`), or null when absent. */
function readLock() {
  try {
    return JSON.parse(fs.readFileSync(path.join(forgeHomeDir(), '.forge', 'sources.lock'), 'utf8'));
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
 * Build a local upstream git fixture repo with one valid agent resource, on branch
 * `main`. Plants TWO would-be side-effect triggers that a clone+read MUST NOT run:
 *   1. a git `post-checkout` hook in .git/hooks that writes a marker file, and
 *   2. a package.json `postinstall` script (sync never runs npm).
 * Returns { repo, commit, markerPath } — markerPath must NOT exist after a safe sync.
 */
function makeGitFixture(root) {
  const repo = path.join(root, 'upstream');
  fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'agents', 'hello.md'),
    [
      '---',
      'name: hello',
      'description: An upstream fixture agent used to exercise source sync clone-and-pin.',
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
  const markerPath = path.join(root, 'NO_EXEC_MARKER.txt');
  // A postinstall that, IF ever run, drops the marker (sync must never run npm).
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'upstream-fixture', version: '0.0.0', scripts: { postinstall: `node -e "require('fs').writeFileSync(process.env.MARK,'PWNED')"` } }, null, 2) + '\n',
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.com');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'upstream fixture');
  const commit = git(repo, 'rev-parse', 'HEAD');
  // Plant the malicious post-checkout hook AFTER the commit, so it is present on disk
  // in .git/hooks when a clone of file://repo would (naively) run checkout hooks.
  const hooksDir = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'post-checkout');
  fs.writeFileSync(hook, `#!/bin/sh\necho PWNED > "${markerPath}"\n`);
  fs.chmodSync(hook, 0o755);
  return { repo, commit, markerPath };
}

// ===========================================================================
// add
// ===========================================================================

test('add: git source — default kind detected as git, trust untrusted, --apply persists', async () => {
  await withSandbox('forge-src-add-git-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    const res = await run('add', ['cookbook', 'https://example.com/repo.git', '--apply'], {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.record.kind, 'git', 'a non-existent path url auto-detects kind=git');
    assert.strictEqual(res.data.record.trust, 'untrusted', 'every new source is untrusted');
    assert.strictEqual(res.data.record.ref, 'main', 'default ref is main');
    assert.strictEqual(res.data.written, true);
    const m = readManifest();
    assert.ok(m.sources.some((s) => s.id === 'cookbook' && s.kind === 'git'), 'persisted to sources.json');
  });
});

test('add: preview by default writes NOTHING (no --apply)', async () => {
  await withSandbox('forge-src-add-preview-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    const before = readManifest();
    const res = await run('add', ['preview-only', 'https://example.com/x.git'], {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.written, false, 'preview never writes');
    assert.strictEqual(res.data.plan.add.length, 1, 'plan still shows the would-add record');
    const after = readManifest();
    assert.deepStrictEqual(after, before, 'manifest unchanged by a preview run');
  });
});

test('add: local source — an existing directory url auto-detects kind=local', async () => {
  await withSandbox('forge-src-add-local-', async ({ cli, root }) => {
    const localDir = path.join(root, 'a-local-source');
    fs.mkdirSync(path.join(localDir, 'agents'), { recursive: true });
    const { run } = await loadSource(cli);
    const res = await run('add', ['mylocal', localDir, '--apply'], {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.record.kind, 'local', 'an existing dir url auto-detects kind=local');
    assert.ok(readManifest().sources.some((s) => s.id === 'mylocal' && s.kind === 'local'));
  });
});

test('add: explicit --kind local wins over auto-detect', async () => {
  await withSandbox('forge-src-add-kindflag-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    // url is NOT an existing dir (would auto-detect git) but --kind local is explicit.
    const res = await run('add', ['forced', '/nonexistent/path', '--kind', 'local', '--apply'], {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.record.kind, 'local', 'explicit --kind local overrides auto-detect');
  });
});

test('add: invalid id is REJECTED with an ERROR and writes nothing', async () => {
  await withSandbox('forge-src-add-badid-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    const res = await run('add', ['Bad Id!', 'https://x.git', '--apply'], {});
    assert.strictEqual(res.ok, false, 'invalid id fails');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /invalid source id/.test(f.message)));
    const m = readManifest();
    assert.ok(!m || !m.sources.some((s) => s.id === 'Bad Id!'), 'nothing persisted');
  });
});

test('add: invalid --kind is REJECTED with an ERROR', async () => {
  await withSandbox('forge-src-add-badkind-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    const res = await run('add', ['ok-id', 'https://x.git', '--kind', 'svn', '--apply'], {});
    assert.strictEqual(res.ok, false, 'invalid kind fails');
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /invalid --kind/.test(f.message)));
  });
});

test('add: duplicate id is skipped + WARN (never clobber)', async () => {
  await withSandbox('forge-src-add-dup-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    await run('add', ['dup', 'https://first.git', '--apply'], {});
    const res = await run('add', ['dup', 'https://second.git', '--apply'], {});
    assert.strictEqual(res.ok, true, 'duplicate is a soft skip, not a hard error');
    assert.strictEqual(res.data.plan.add.length, 0);
    assert.strictEqual(res.data.plan.skipped.length, 1);
    assert.ok(res.findings.some((f) => f.level === 'WARN' && /already present/.test(f.message)));
    const m = readManifest();
    assert.strictEqual(m.sources.find((s) => s.id === 'dup').url, 'https://first.git', 'original url preserved');
  });
});

// ===========================================================================
// list
// ===========================================================================

test('list: enumerates the registered sources with full records', async () => {
  await withSandbox('forge-src-list-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    await run('add', ['one', 'https://one.git', '--apply'], {});
    await run('add', ['two', 'https://two.git', '--ref', 'dev', '--apply'], {});
    const res = await run('list', [], {});
    assert.strictEqual(res.ok, true);
    const ids = res.data.sources.map((s) => s.id).sort();
    assert.deepStrictEqual(ids, ['one', 'two']);
    assert.strictEqual(res.summary.sources, 2);
    assert.strictEqual(res.summary.untrusted, 2, 'both newly-added are untrusted');
    assert.strictEqual(res.data.sources.find((s) => s.id === 'two').ref, 'dev');
  });
});

test('list: empty registry degrades to an INFO finding, ok=true', async () => {
  await withSandbox('forge-src-list-empty-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    const res = await run('list', [], {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.sources.length, 0);
  });
});

// ===========================================================================
// remove
// ===========================================================================

test('remove: present id is removed under --apply', async () => {
  await withSandbox('forge-src-rm-present-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    await run('add', ['gone', 'https://gone.git', '--apply'], {});
    const res = await run('remove', ['gone', '--apply'], {});
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.plan.remove, ['gone']);
    assert.strictEqual(res.data.written, true);
    const m = readManifest();
    assert.ok(!m.sources.some((s) => s.id === 'gone'), 'removed from sources.json');
  });
});

test('remove: absent id is a WARN no-op (additive-safe)', async () => {
  await withSandbox('forge-src-rm-absent-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    const res = await run('remove', ['ghost', '--apply'], {});
    assert.strictEqual(res.ok, true, 'absent removal is a soft warn, not a hard error');
    assert.deepStrictEqual(res.data.plan.missing, ['ghost']);
    assert.strictEqual(res.data.written, false);
    assert.ok(res.findings.some((f) => f.level === 'WARN' && /not present/.test(f.message)));
  });
});

// ===========================================================================
// trust — the security-gated untrusted -> reviewed flip
// ===========================================================================

test('trust: flips untrusted -> reviewed under --apply', async () => {
  await withSandbox('forge-src-trust-flip-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    await run('add', ['t1', 'https://t1.git', '--apply'], {});
    const res = await run('trust', ['t1', '--apply'], {});
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.diff, { from: 'untrusted', to: 'reviewed' });
    assert.strictEqual(res.data.written, true);
    const m = readManifest();
    assert.strictEqual(m.sources.find((s) => s.id === 't1').trust, 'reviewed', 'persisted as reviewed');
  });
});

test('trust: dry-run shows the diff but writes nothing', async () => {
  await withSandbox('forge-src-trust-dry-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    await run('add', ['t2', 'https://t2.git', '--apply'], {});
    const res = await run('trust', ['t2'], {}); // no --apply
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.written, false);
    assert.strictEqual(readManifest().sources.find((s) => s.id === 't2').trust, 'untrusted', 'still untrusted after dry-run');
  });
});

test('trust: re-trusting an already-reviewed source is an idempotent no-op', async () => {
  await withSandbox('forge-src-trust-idem-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    await run('add', ['t3', 'https://t3.git', '--apply'], {});
    await run('trust', ['t3', '--apply'], {});
    const res = await run('trust', ['t3', '--apply'], {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.written, false, 'no-op: nothing to write');
    assert.strictEqual(res.summary.trust, 0, 'no trust flip counted');
    assert.ok(res.findings.some((f) => f.level === 'INFO' && /already trust/.test(f.message)));
    assert.strictEqual(readManifest().sources.find((s) => s.id === 't3').trust, 'reviewed');
  });
});

// ===========================================================================
// sync — dry-run vs apply against a file:// local git fixture, with the no-exec guard
// ===========================================================================

test('sync: dry-run plans the clone but writes NOTHING (no cache, no lockfile)', async () => {
  await withSandbox('forge-src-sync-dry-', async ({ cli, root, home }) => {
    const fx = makeGitFixture(root);
    const { run } = await loadSource(cli);
    await run('add', ['fx', `file://${fx.repo}`, '--ref', 'main', '--apply'], {});
    const res = await run('sync', ['fx'], {}); // dry-run
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.planned, true);
    assert.strictEqual(res.data.applied, false);
    assert.strictEqual(res.data.targets.length, 1);
    assert.strictEqual(res.data.targets[0].action, 'clone');
    assert.strictEqual(readLock(), null, 'no lockfile written on dry-run');
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'forge-sources', 'fx')), 'no cache clone on dry-run');
  });
});

test('sync --apply: clones the file:// git fixture and PINS the resolved commit in the lockfile', async () => {
  await withSandbox('forge-src-sync-apply-', async ({ cli, root, home }) => {
    const fx = makeGitFixture(root);
    const { run } = await loadSource(cli);
    await run('add', ['fx', `file://${fx.repo}`, '--ref', 'main', '--apply'], {});
    const res = await run('sync', ['fx', '--apply', '--now', '2026-01-01T00:00:00Z'], {});
    assert.strictEqual(res.ok, true, `sync failed: ${JSON.stringify(res.findings)}`);
    assert.strictEqual(res.summary.synced, 1);
    assert.strictEqual(res.summary.failed, 0);
    assert.strictEqual(res.summary.locked, 1);

    // Lockfile pins the EXACT upstream commit.
    const lock = readLock();
    assert.ok(lock, 'lockfile was written');
    assert.strictEqual(lock.schema, 'forge.sources.lock.v1');
    const entry = lock.sources.find((s) => s.id === 'fx');
    assert.ok(entry, 'fx pinned in the lockfile');
    assert.strictEqual(entry.commit, fx.commit, 'lockfile commit == upstream HEAD sha (commit-pinned)');
    assert.strictEqual(entry.ref, 'main');
    assert.strictEqual(entry.syncedAt, '2026-01-01T00:00:00Z', 'deterministic --now stamp');

    // The bytes landed in the SANDBOXED cache (~ = sandbox home), never the real repo.
    const cacheClone = path.join(home, '.claude', 'forge-sources', 'fx', 'agents', 'hello.md');
    assert.ok(fs.existsSync(cacheClone), 'cloned agent present in the sandboxed cache');
  });
});

test('sync --apply: NO-EXEC GUARD — a planted git hook + postinstall MUST NOT run (no side-effect marker)', async () => {
  await withSandbox('forge-src-sync-noexec-', async ({ cli, root, home }) => {
    const fx = makeGitFixture(root);
    // Pre-condition: marker absent before sync.
    assert.ok(!fs.existsSync(fx.markerPath), 'marker absent before sync');
    const { run } = await loadSource(cli);
    await run('add', ['fx', `file://${fx.repo}`, '--ref', 'main', '--apply'], {});
    const res = await run('sync', ['fx', '--apply', '--now', '2026-01-01T00:00:00Z'], {});
    assert.strictEqual(res.ok, true, `sync failed: ${JSON.stringify(res.findings)}`);

    // THE GUARD: the upstream repo's post-checkout hook (and its package.json
    // postinstall) must NEVER execute during a clone+read sync. If either ran, the
    // marker file would exist. Assert it does NOT.
    assert.ok(!fs.existsSync(fx.markerPath), 'no-exec guard: planted hook/postinstall did NOT run during sync');

    // Defense in depth: the cloned cache also must not contain the marker.
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'forge-sources', 'fx', 'NO_EXEC_MARKER.txt')));
    // And the security banner finding is always present on a sync run.
    assert.ok(res.findings.some((f) => /clones \+ reads ONLY/.test(f.message)), 'security banner emitted');
  });
});

test('sync --apply: re-sync refreshes in place and re-pins the same commit (idempotent)', async () => {
  await withSandbox('forge-src-sync-resync-', async ({ cli, root }) => {
    const fx = makeGitFixture(root);
    const { run } = await loadSource(cli);
    await run('add', ['fx', `file://${fx.repo}`, '--ref', 'main', '--apply'], {});
    const first = await run('sync', ['fx', '--apply', '--now', '2026-01-01T00:00:00Z'], {});
    assert.strictEqual(first.ok, true, `first sync failed: ${JSON.stringify(first.findings)}`);
    const second = await run('sync', ['fx', '--apply', '--now', '2026-01-02T00:00:00Z'], {});
    assert.strictEqual(second.ok, true, `re-sync failed: ${JSON.stringify(second.findings)}`);
    assert.strictEqual(second.summary.synced, 1);
    const lock = readLock();
    const entry = lock.sources.find((s) => s.id === 'fx');
    assert.strictEqual(entry.commit, fx.commit, 're-sync pins the same upstream commit');
    assert.strictEqual(entry.syncedAt, '2026-01-02T00:00:00Z', 're-sync updates the stamp');
    assert.strictEqual(lock.sources.filter((s) => s.id === 'fx').length, 1, 'lock entry upserted (not duplicated)');
  });
});

// ===========================================================================
// SECURITY — Critical #1: the sync RCE (git transport-helper injection)
//
// ROOT CAUSE: an unvalidated t.url/t.ref reaches `git clone`. git's ext:: (and
// other transport-helper) forms execute a shell command on clone, and a
// '-'-leading url/ref can be parsed as a git OPTION (argv injection).
// core.hooksPath=/dev/null does NOT stop a transport-helper.
//
// FIX (two layers, both asserted below):
//   1. `add` ALLOWLISTS the url scheme (https/http/git/ssh/file:// + scp-like
//      git@host:path) and REJECTS ext::/fd::/<helper>:: and any '-'-leading
//      url OR ref — an ERROR, manifest unchanged.
//   2. The git argv carries `-c protocol.ext.allow=never` and runs with
//      GIT_PROTOCOL_FROM_USER=0, with a `--` separator before positionals.
// ===========================================================================

test('SECURITY add: an ext:: transport-helper url is REJECTED (ERROR, manifest unchanged)', async () => {
  await withSandbox('forge-src-sec-ext-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    // The classic RCE payload: git would run `sh -c "<shell>"` on clone.
    const evil = 'ext::sh -c "touch /tmp/forge_pwned_$$"';
    const res = await run('add', ['evil', evil, '--apply'], {});
    assert.strictEqual(res.ok, false, 'an ext:: url must be a hard ERROR, not registered');
    assert.ok(
      res.findings.some((f) => f.level === 'ERROR' && /transport-helper|ext::|not an allowed transport/.test(f.message)),
      'an ERROR finding explains the transport rejection',
    );
    // Nothing persisted — the manifest must not exist / must not carry the source.
    const m = readManifest();
    assert.ok(!m || !m.sources.some((s) => s.id === 'evil'), 'the ext:: source was NOT written to the manifest');
  });
});

test('SECURITY add: other exotic transport schemes (fd::) and non-allowlisted schemes are REJECTED', async () => {
  await withSandbox('forge-src-sec-schemes-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    for (const evil of ['fd::7', 'transport::whatever', 'svn://example.com/r', 'ext::cat /etc/passwd']) {
      const res = await run('add', ['x', evil, '--apply'], {});
      assert.strictEqual(res.ok, false, `non-allowlisted url must be rejected: ${evil}`);
      assert.ok(res.findings.some((f) => f.level === 'ERROR'), `ERROR finding for: ${evil}`);
      const m = readManifest();
      assert.ok(!m || !m.sources.some((s) => s.id === 'x'), `not persisted: ${evil}`);
    }
  });
});

test('SECURITY add: a \'-\'-leading url is REJECTED (argv injection)', async () => {
  await withSandbox('forge-src-sec-dashurl-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    // A single-dash payload git would parse as an OPTION (e.g. -o…/-u…). It flows
    // through arg parsing as a positional url and must hit the '-'-leading guard.
    const res = await run('add', ['dashurl', '-oProxyCommand=touch /tmp/x', '--apply'], {});
    assert.strictEqual(res.ok, false, "a '-'-leading url must be rejected");
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /argv injection|begin with '-'/.test(f.message)));
    const m = readManifest();
    assert.ok(!m || !m.sources.some((s) => s.id === 'dashurl'), 'not persisted');
  });
});

test('SECURITY add: a \'-\'-leading ref is REJECTED (argv injection)', async () => {
  await withSandbox('forge-src-sec-dashref-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    // A valid, allowlisted url but a hostile single-dash ref git would read as an
    // option (e.g. -u…/-o…). The '-'-leading ref guard must reject it.
    const res = await run('add', ['dashref', 'https://example.com/repo.git', '--ref', '-uPwn', '--apply'], {});
    assert.strictEqual(res.ok, false, "a '-'-leading ref must be rejected");
    assert.ok(res.findings.some((f) => f.level === 'ERROR' && /ref|argv injection|begin with '-'/.test(f.message)));
    const m = readManifest();
    assert.ok(!m || !m.sources.some((s) => s.id === 'dashref'), 'not persisted');
  });
});

test('SECURITY add: an allowlisted https url with a normal ref is still ACCEPTED (no false positive)', async () => {
  await withSandbox('forge-src-sec-ok-', async ({ cli }) => {
    const { run } = await loadSource(cli);
    const res = await run('add', ['good', 'https://example.com/repo.git', '--ref', 'main', '--apply'], {});
    assert.strictEqual(res.ok, true, 'a normal https url + main ref is accepted');
    assert.strictEqual(res.data.written, true);
    // scp-like ssh shorthand is also accepted.
    const res2 = await run('add', ['scp', 'git@github.com:owner/repo.git', '--apply'], {});
    assert.strictEqual(res2.ok, true, 'scp-like git@host:path is accepted');
    assert.strictEqual(res2.data.record.kind, 'git');
  });
});

test('SECURITY sync: the git argv carries protocol.ext.allow=never + GIT_PROTOCOL_FROM_USER=0 + a -- separator (defense in depth)', async () => {
  await withSandbox('forge-src-sec-argv-', async ({ cli, root, home }) => {
    // Shim `git` on PATH with a recorder that writes its argv + relevant env to a
    // file, then exits non-zero (we only need to inspect HOW git was invoked).
    const shimDir = path.join(root, 'shimbin');
    fs.mkdirSync(shimDir, { recursive: true });
    const recPath = path.join(root, 'git-invocations.log');
    const gitShim = path.join(shimDir, 'git');
    fs.writeFileSync(
      gitShim,
      [
        '#!/bin/sh',
        '# Recorder shim: append this invocation (env + argv) as one JSON line.',
        'node -e \'',
        '  const fs=require("fs");',
        '  const rec={',
        '    argv: process.argv.slice(1),',
        '    GIT_PROTOCOL_FROM_USER: process.env.GIT_PROTOCOL_FROM_USER||null,',
        '    GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT||null,',
        '  };',
        '  fs.appendFileSync(process.env.REC, JSON.stringify(rec)+"\\n");',
        '\' -- "$@"',
        'exit 1', // force a clone "failure" so sync stops after the network call
      ].join('\n') + '\n',
    );
    fs.chmodSync(gitShim, 0o755);

    const prevPath = process.env.PATH;
    const prevRec = process.env.REC;
    process.env.PATH = `${shimDir}${path.delimiter}${prevPath || ''}`;
    process.env.REC = recPath;
    try {
      const { run } = await loadSource(cli);
      // Use a non-existent local dir url so kind auto-detects git → clone path.
      await run('add', ['fx', 'https://example.com/repo.git', '--ref', 'main', '--apply'], {});
      await run('sync', ['fx', '--apply', '--now', '2026-01-01T00:00:00Z'], {});
    } finally {
      if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
      if (prevRec === undefined) delete process.env.REC; else process.env.REC = prevRec;
    }

    const lines = fs.readFileSync(recPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.length >= 1, 'the shimmed git was invoked at least once');
    // Find the clone invocation (the networked call that takes the url).
    const clone = lines.find((r) => r.argv.includes('clone'));
    assert.ok(clone, 'a clone invocation was recorded');

    // (a) protocol hardening: ext blocked, transports restricted, file kept.
    const joined = clone.argv.join(' ');
    assert.ok(/-c protocol\.ext\.allow=never/.test(joined), 'argv carries -c protocol.ext.allow=never');
    assert.ok(/-c protocol\.allow=user/.test(joined), 'argv carries -c protocol.allow=user');
    // (b) GIT_PROTOCOL_FROM_USER=0 in the spawned env.
    assert.strictEqual(clone.GIT_PROTOCOL_FROM_USER, '0', 'spawned env sets GIT_PROTOCOL_FROM_USER=0');
    // (c) a `--` separator precedes the positional <url>/<dir>.
    const dashdash = clone.argv.indexOf('--');
    const urlIdx = clone.argv.indexOf('https://example.com/repo.git');
    assert.ok(dashdash !== -1, 'argv contains a -- separator');
    assert.ok(urlIdx !== -1 && dashdash < urlIdx, 'the -- separator precedes the positional url');
    // core.hooksPath neutraliser is still present (kept from the original fix).
    assert.ok(/-c core\.hooksPath=\/dev\/null/.test(joined), 'argv still neutralises core.hooksPath');
  });
});
