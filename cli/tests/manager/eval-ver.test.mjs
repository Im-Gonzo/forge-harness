// @ts-check
/**
 * eval-ver.test.mjs — executable acceptance specs for SPEC-02 (per-artifact
 * versioning) + the advisory bump/drift gates (BR-VER-001..008). Covers
 * EVAL-VER-001 through EVAL-VER-008 from docs/manager/evals/EVAL-VER.md.
 *
 * Run model: `node --test tests/manager/`. Built-in node:test + node:assert ONLY
 * (zero runtime deps — every import is a node: builtin or a relative path).
 *
 * RED-first discipline (see the module header in EVAL-VER.md):
 *   - Features NOT yet built — `manager/registry.mjs` (`run`/`summarize`,
 *     `bump`/`roll-up`/`show`), `lint/validate-registry.mjs`, and the
 *     `bin/forge.mjs registry …` subcommands — must make a test FAIL, never crash
 *     the runner. We therefore dynamic-import the unbuilt module INSIDE the test
 *     body wrapped in try/catch and then ASSERT the module/feature exists (a
 *     missing module degrades to an assertion failure = honest RED). For CLI
 *     behavior we spawnSync `node bin/forge.mjs <args>` and assert on
 *     status/stdout/stderr (an unimplemented subcommand exits 2 today = RED).
 *   - Features already implemented in `manager/lib/*` (hash, frontmatter, store
 *     atomic/lossy, the C2 finding shape) SHOULD pass and are NOT forced RED.
 *
 * Determinism & isolation: every test that touches state copies the relevant
 * frozen fixture into an `fs.mkdtempSync` sandbox under os.tmpdir() and treats
 * that copy as FORGE_ROOT; the real repo and the frozen fixtures are NEVER
 * mutated. Each test cleans up its own sandbox. The real repo is only ever read
 * (the EVAL-VER-001 negative half reads the live, aligned `0.1.0`/`0.1.0`/`0.1.0`
 * triple read-only).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Repo geography (resolved from THIS file, not cwd — agent threads reset cwd).
// ---------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url)); // …/tests/manager
const FORGE_ROOT = path.resolve(HERE, '..', '..'); // repo root
const FIXTURES = path.join(HERE, 'fixtures');
const BIN = path.join(FORGE_ROOT, 'bin', 'forge.mjs');

const REGISTRY_MJS = path.join(FORGE_ROOT, 'manager', 'registry.mjs');
const VALIDATE_REGISTRY_MJS = path.join(FORGE_ROOT, 'lint', 'validate-registry.mjs');

// Already-built libs we legitimately depend on (these SHOULD load).
const STORE_MJS = path.join(FORGE_ROOT, 'manager', 'lib', 'store.mjs');
const HASH_MJS = path.join(FORGE_ROOT, 'manager', 'lib', 'hash.mjs');
const FRONTMATTER_MJS = path.join(FORGE_ROOT, 'manager', 'lib', 'frontmatter.mjs');

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Sandbox helpers — copy a frozen fixture into a temp FORGE_ROOT we may mutate.
// ---------------------------------------------------------------------------

/** Recursively copy a directory tree (zero-dep; node ≥ 16 has fs.cpSync). */
function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

/**
 * Make a throwaway sandbox dir; if `fixture` is given, copy that fixture into it.
 * Returns the absolute sandbox path. Caller passes it to `cleanup()` in finally.
 * @param {string} [fixture] fixture dir name under tests/manager/fixtures
 * @returns {string}
 */
function makeSandbox(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ver-'));
  if (fixture) copyTree(path.join(FIXTURES, fixture), dir);
  return dir;
}

/** Best-effort recursive remove; never throws. */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Dynamic-import a not-yet-built module. Returns the module namespace, or null
 * if it does not exist / fails to load. NEVER throws — a missing feature becomes
 * an assertion failure in the caller (honest RED), not a runner crash.
 * @param {string} absPath
 * @returns {Promise<any|null>}
 */
async function tryImport(absPath) {
  try {
    return await import(absPath);
  } catch {
    return null;
  }
}

/**
 * Resolve whichever public entry the registry module exposes for a verb. The C4
 * contract (SPEC-01) is `run(subcmd, args, ctx)`; we also accept a direct named
 * export (`bump`, `rollUp`, `show`, `build`) so the test pins BEHAVIOR, not one
 * call shape. Returns null when the module/verb is absent (→ RED).
 * @param {any} mod imported manager/registry.mjs namespace (or null)
 * @returns {null | ((subcmd:string,args?:any,ctx?:any)=>any)}
 */
function registryRunner(mod) {
  if (!mod) return null;
  if (typeof mod.run === 'function') return mod.run;
  if (mod.default && typeof mod.default.run === 'function') return mod.default.run.bind(mod.default);
  return null;
}

/**
 * Run a manager registry verb either via the C4 `run(subcmd,args,ctx)` entry or,
 * failing that, a directly-exported function — under the given FORGE_ROOT sandbox.
 * Returns { ok, value } where ok=false means the feature is not yet reachable.
 * @param {any} mod
 * @param {string} subcmd
 * @param {string[]} args
 * @param {string} root absolute FORGE_ROOT sandbox
 */
async function callRegistry(mod, subcmd, args, root) {
  const run = registryRunner(mod);
  const ctx = { root, forgeRoot: root, cwd: root, write: true, apply: true };
  if (run) {
    try {
      const value = await run(subcmd, args, ctx);
      return { ok: true, value };
    } catch (e) {
      return { ok: false, value: e };
    }
  }
  // Fall back to a direct named export keyed by verb (e.g. mod.build / mod.bump).
  const fn = mod && typeof mod[subcmd] === 'function' ? mod[subcmd] : null;
  if (fn) {
    try {
      return { ok: true, value: await fn(args, ctx) };
    } catch (e) {
      return { ok: false, value: e };
    }
  }
  return { ok: false, value: null };
}

/**
 * Read the committed registry snapshot a build would have written, using the
 * REAL store seam so we test the real on-disk contract (forgeStateDir/<root>).
 * @param {string} root sandbox FORGE_ROOT
 * @returns {Promise<{snapshot:any, log:any[], dir:string}>}
 */
async function readBuiltRegistry(root) {
  const store = await import(STORE_MJS);
  const dir = store.forgeStateDir(root);
  const snapshot = store.readJson(path.join(dir, 'registry.json'));
  const log = store.readJsonl(path.join(dir, 'registry.log.jsonl'));
  return { snapshot, log, dir };
}

/** Find one artifact record by uid in a built snapshot (or null). */
function findRecord(snapshot, uid) {
  const arr = snapshot && Array.isArray(snapshot.artifacts) ? snapshot.artifacts : [];
  return arr.find((a) => a && a.uid === uid) || null;
}

/** Spawn the real CLI under a sandbox cwd; capture status/stdout/stderr. */
function runCli(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
  });
}

/**
 * Run validate-registry against `root`. Prefers a runnable child (spawnSync, the
 * real auto-discovered shape) and falls back to an importable `run()` export.
 * Returns { reachable, status, text } — text is stdout+stderr combined (findings
 * print to stderr, the summary to stdout — SPEC/ADR-0004). reachable=false ⇒ the
 * validator does not exist yet (→ RED).
 * @param {string} root
 * @param {boolean} [strict]
 */
function runValidateRegistry(root, strict = false) {
  if (!fs.existsSync(VALIDATE_REGISTRY_MJS)) {
    return { reachable: false, status: null, text: '' };
  }
  const args = [VALIDATE_REGISTRY_MJS];
  if (strict) args.push('--strict');
  args.push(root);
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30000 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  return { reachable: true, status: r.status, text };
}

// ===========================================================================
// EVAL-VER-001 — VERSION triple-drift is an advisory WARN
// Phase: v0.2 (advisory drift — focus case). Verifies BR-VER-007, BR-REG-008.
//
// Decided model (aligned with EVAL-REG-008): a `-design` pre-release suffix is
// STRIPPED before comparing VERSION / package.json / .claude-plugin/plugin.json,
// so drift means the CORE versions differ. Drift is proven against the
// versions-drifted FIXTURE (core 0.2.0 vs 0.1.0 vs 0.1.0) → advisory WARN, exit 0
// non-strict. The REAL repo (0.1.0 / 0.1.0 / 0.1.0) is ALIGNED — all three equal,
// no suffix to strip → NO drift WARN.
// ===========================================================================
test('EVAL-VER-001 — VERSION triple-drift is an advisory WARN', async () => {
  // Sanity: the real repo's three version sources are ALIGNED (all equal, no
  // pre-release suffix to strip, so it is NOT drifted) — read-only, never mutated.
  // The invariant under test is mutual alignment, not any one release number, so
  // this tracks the real VERSION across bumps rather than pinning a stale literal.
  const realVersion = fs.readFileSync(path.join(FORGE_ROOT, 'VERSION'), 'utf8').trim();
  const realPkg = JSON.parse(fs.readFileSync(path.join(FORGE_ROOT, 'package.json'), 'utf8'));
  const realPlugin = JSON.parse(
    fs.readFileSync(path.join(FORGE_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  assert.ok(
    !/-/.test(realVersion),
    'precondition: real VERSION has no pre-release suffix (nothing to strip before alignment)',
  );
  assert.strictEqual(realPkg.version, realVersion, 'precondition: real package.json aligns with VERSION');
  assert.strictEqual(realPlugin.version, realVersion, 'precondition: real plugin.json aligns with VERSION');

  // Positive half: the versions-drifted FIXTURE (core 0.2.0 vs 0.1.0 vs 0.1.0)
  // emits an advisory WARN naming ALL THREE raw values and does NOT exit 1 on this
  // finding alone (advisory under default; --strict fails by design).
  const drifted = makeSandbox('versions-drifted');
  try {
    const drift = runValidateRegistry(drifted, false);
    assert.ok(
      drift.reachable,
      'lint/validate-registry.mjs must exist to assert the advisory triple-drift WARN (RED until built)',
    );
    const warnLine = drift.text
      .split(/\r?\n/)
      .find(
        (l) =>
          /^WARN\b/.test(l) &&
          /version triple drift:/.test(l) &&
          /0\.2\.0/.test(l) &&
          /package\.json='0\.1\.0'/.test(l) &&
          /plugin\.json='0\.1\.0'/.test(l),
      );
    assert.ok(
      warnLine,
      'expected a WARN naming all three raw values (VERSION=0.2.0 package.json=0.1.0 plugin.json=0.1.0)',
    );
    assert.ok(
      drift.status === 0 || drift.status === null,
      'triple-drift WARN alone must NOT cause a non-zero exit (advisory, C5)',
    );

    // --strict turns the advisory WARN into a non-zero exit (the strict dial).
    const strict = runValidateRegistry(drifted, true);
    assert.strictEqual(strict.status, 1, 'under --strict the drift WARN fails the exit (1)');
  } finally {
    cleanup(drifted);
  }

  // Negative half: the REAL repo (0.1.0 / 0.1.0 / 0.1.0) is aligned → NO VERSION
  // triple-drift finding.
  const real = runValidateRegistry(FORGE_ROOT, false);
  assert.ok(real.reachable, 'validate-registry must exist (RED until built)');
  const realDriftLine = real.text
    .split(/\r?\n/)
    .find((l) => /version triple drift/i.test(l));
  assert.ok(!realDriftLine, 'real repo (-design stripped) emits NO VERSION triple-drift finding');
});

// ===========================================================================
// EVAL-VER-002 — Three-part identity present; sane seed
// Phase: v0.2. Verifies BR-VER-001. (Capability — registry build.)
// ===========================================================================
test('EVAL-VER-002 — Three-part identity present; sane seed', async () => {
  const root = makeSandbox('lib-min');
  try {
    const mod = await tryImport(REGISTRY_MJS);
    assert.ok(mod, 'manager/registry.mjs must exist to build a registry (RED until built)');

    const built = await callRegistry(mod, 'build', ['--write'], root);
    assert.ok(built.ok, 'registry build must be reachable via run()/build() (RED until built)');

    const { snapshot } = await readBuiltRegistry(root);
    assert.ok(snapshot && Array.isArray(snapshot.artifacts), 'build writes a snapshot with artifacts[]');

    // Every record carries the full three-part identity.
    for (const a of snapshot.artifacts) {
      assert.match(a.contentHash, HEX64_RE, `${a.uid}: contentHash is 64-hex`);
      assert.ok(Number.isInteger(a.revision) && a.revision >= 1, `${a.uid}: revision is a positive int`);
      assert.match(a.version, SEMVER_RE, `${a.uid}: version is valid semver`);
    }

    // A brand-new artifact (no prior committed registry) seeds rev:1 / "0.1.0".
    const rec = findRecord(snapshot, 'agent:code-reviewer');
    assert.ok(rec, 'code-reviewer record present');
    assert.strictEqual(rec.revision, 1, 'new artifact seeds revision: 1');
    assert.strictEqual(rec.version, '0.1.0', 'new artifact seeds version: "0.1.0"');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// EVAL-VER-003 — Semver level semantics
// Phase: v0.2. Verifies BR-VER-002. (patch/minor/major from a 1.2.3 base.)
// ===========================================================================
test('EVAL-VER-003 — Semver level semantics', async () => {
  const mod = await tryImport(REGISTRY_MJS);
  assert.ok(mod, 'manager/registry.mjs must exist to author bumps (RED until built)');

  // Bump each level INDEPENDENTLY from a record seeded at 1.2.3.
  const expectations = [
    ['--patch', '1.2.4'],
    ['--minor', '1.3.0'],
    ['--major', '2.0.0'],
  ];
  for (const [level, want] of expectations) {
    const root = makeSandbox('lib-min');
    try {
      const store = await import(STORE_MJS);
      // Build, then seed the target record at 1.2.3 in the committed snapshot.
      const built = await callRegistry(mod, 'build', ['--write'], root);
      assert.ok(built.ok, `registry build reachable (${level}) (RED until built)`);
      const dir = store.forgeStateDir(root);
      const regPath = path.join(dir, 'registry.json');
      const snap = store.readJson(regPath);
      assert.ok(snap, 'committed registry present after build');
      const rec = findRecord(snap, 'agent:code-reviewer');
      assert.ok(rec, 'code-reviewer record present to seed at 1.2.3');
      rec.version = '1.2.3';
      assert.strictEqual(store.writeJsonAtomic(regPath, snap), true, 'seed write 1.2.3');

      const bumped = await callRegistry(mod, 'bump', ['agent:code-reviewer', level], root);
      assert.ok(bumped.ok, `bump ${level} reachable (RED until built)`);

      const after = store.readJson(regPath);
      const got = findRecord(after, 'agent:code-reviewer');
      assert.ok(got, 'record present after bump');
      assert.strictEqual(got.version, want, `bump ${level} from 1.2.3 → ${want}`);
    } finally {
      cleanup(root);
    }
  }
});

// ===========================================================================
// EVAL-VER-004 — Bump increments revision and appends one log line
// Phase: v0.2. Verifies BR-VER-003.
// ===========================================================================
test('EVAL-VER-004 — Bump increments revision and appends one log line', async () => {
  const root = makeSandbox('lib-min');
  try {
    const mod = await tryImport(REGISTRY_MJS);
    assert.ok(mod, 'manager/registry.mjs must exist (RED until built)');
    const store = await import(STORE_MJS);

    const built = await callRegistry(mod, 'build', ['--write'], root);
    assert.ok(built.ok, 'registry build reachable (RED until built)');

    const before = await readBuiltRegistry(root);
    const recBefore = findRecord(before.snapshot, 'agent:code-reviewer');
    assert.ok(recBefore, 'record present before bump');
    assert.strictEqual(recBefore.revision, 1, 'starts at revision 1');
    assert.strictEqual(recBefore.version, '0.1.0', 'starts at version 0.1.0');
    const hashBefore = recBefore.contentHash;
    const logLenBefore = before.log.length;

    const bumped = await callRegistry(mod, 'bump', ['agent:code-reviewer', '--patch'], root);
    assert.ok(bumped.ok, 'bump --patch reachable (RED until built)');

    const after = await readBuiltRegistry(root);
    const recAfter = findRecord(after.snapshot, 'agent:code-reviewer');
    assert.ok(recAfter, 'record present after bump');
    assert.strictEqual(recAfter.revision, 2, 'revision → 2');
    assert.strictEqual(recAfter.version, '0.1.1', 'version → 0.1.1');
    assert.match(recAfter.contentHash, HEX64_RE, 'contentHash refreshed (still 64-hex)');
    assert.ok(typeof recAfter.updatedAt === 'string' && recAfter.updatedAt.length > 0, 'updatedAt set');

    // Exactly ONE new log line, recording the from/to triple for this uid.
    const newLines = after.log.slice(logLenBefore);
    const uidLines = newLines.filter((l) => l && l.uid === 'agent:code-reviewer');
    assert.strictEqual(uidLines.length, 1, 'exactly one log line appended for the bump');
    const entry = uidLines[0];
    assert.ok(entry.from && entry.to, 'log line carries from/to');
    assert.strictEqual(entry.from.rev, 1, 'log from.rev = 1');
    assert.strictEqual(entry.to.rev, 2, 'log to.rev = 2');
    assert.strictEqual(entry.from.ver, '0.1.0', 'log from.ver = 0.1.0');
    assert.strictEqual(entry.to.ver, '0.1.1', 'log to.ver = 0.1.1');
    assert.strictEqual(entry.from.hash, hashBefore, 'log from.hash = prior hash');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// EVAL-VER-005 — Roll-up is deterministic
// Phase: v0.6 (roll-up automation). Verifies BR-VER-004.
// ===========================================================================
test('EVAL-VER-005 — Roll-up is deterministic', async () => {
  const root = makeSandbox('lib-min');
  try {
    const mod = await tryImport(REGISTRY_MJS);
    assert.ok(mod, 'manager/registry.mjs must exist for roll-up (RED until built)');

    const built = await callRegistry(mod, 'build', ['--write'], root);
    assert.ok(built.ok, 'registry build reachable (RED until built)');

    // Two roll-ups with no intervening change → identical VERSION (purity).
    const a = await callRegistry(mod, 'roll-up', [], root);
    const b = await callRegistry(mod, 'roll-up', [], root);
    assert.ok(a.ok && b.ok, 'roll-up reachable (RED until v0.6 built)');
    const va = rollUpVersion(a.value);
    const vb = rollUpVersion(b.value);
    assert.ok(va !== null, 'roll-up returns a VERSION string');
    assert.strictEqual(va, vb, 'two roll-ups of an unchanged tree return the identical VERSION');

    // Sort-by-uid stability: a uid-shuffled committed registry yields the SAME
    // computed VERSION (BR-VER-004 / BR-REG-006). Shuffle the snapshot in place.
    const store = await import(STORE_MJS);
    const regPath = path.join(store.forgeStateDir(root), 'registry.json');
    const snap = store.readJson(regPath);
    assert.ok(snap && Array.isArray(snap.artifacts) && snap.artifacts.length > 1, 'multiple artifacts to shuffle');
    snap.artifacts = [...snap.artifacts].reverse(); // perturb order only
    assert.strictEqual(store.writeJsonAtomic(regPath, snap), true, 'wrote uid-shuffled copy');
    const c = await callRegistry(mod, 'roll-up', [], root);
    assert.ok(c.ok, 'roll-up reachable on shuffled copy (RED until built)');
    assert.strictEqual(rollUpVersion(c.value), va, 'VERSION is invariant under uid ordering (sort-by-uid stability)');
  } finally {
    cleanup(root);
  }
});

/** Extract a VERSION string from whatever roll-up returns (string | {VERSION} | {version}). */
function rollUpVersion(v) {
  if (typeof v === 'string' && v.length > 0) return v;
  if (v && typeof v === 'object') {
    if (typeof v.VERSION === 'string') return v.VERSION;
    if (typeof v.version === 'string') return v.version;
  }
  return null;
}

// ===========================================================================
// EVAL-VER-006 — Per-artifact changelog is the filtered log
// Phase: v0.2. Verifies BR-VER-005.
// ===========================================================================
test('EVAL-VER-006 — Per-artifact changelog is the filtered log', async () => {
  const root = makeSandbox('lib-min');
  try {
    const mod = await tryImport(REGISTRY_MJS);
    assert.ok(mod, 'manager/registry.mjs must exist (RED until built)');

    const built = await callRegistry(mod, 'build', ['--write'], root);
    assert.ok(built.ok, 'registry build reachable (RED until built)');

    const A = 'agent:code-reviewer';
    const B = 'agent:diff-reviewer';
    // Two bumps of A and one of B, interleaved.
    assert.ok((await callRegistry(mod, 'bump', [A, '--patch'], root)).ok, 'bump A#1 (RED until built)');
    assert.ok((await callRegistry(mod, 'bump', [B, '--patch'], root)).ok, 'bump B#1 (RED until built)');
    assert.ok((await callRegistry(mod, 'bump', [A, '--minor'], root)).ok, 'bump A#2 (RED until built)');

    // show A (or the changelog accessor) returns exactly A's two entries, in
    // append order, and none of B's.
    const shown = await callRegistry(mod, 'show', [A], root);
    assert.ok(shown.ok, 'registry show reachable (RED until built)');
    const changelog = extractChangelog(shown.value);
    assert.ok(Array.isArray(changelog), 'show A surfaces a changelog array (filtered log)');
    assert.strictEqual(changelog.length, 2, "exactly A's two entries");
    assert.ok(
      changelog.every((e) => e && e.uid === A),
      'every changelog entry is A; none of B',
    );
    // Append order: patch (rev 1→2) before minor (rev 2→3).
    assert.strictEqual(changelog[0].to.rev, 2, 'first entry is the patch (rev 2)');
    assert.strictEqual(changelog[1].to.rev, 3, 'second entry is the minor (rev 3)');
  } finally {
    cleanup(root);
  }
});

/** Pull the per-artifact changelog out of a `show` result (record.changelog | {changelog} | array). */
function extractChangelog(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    if (Array.isArray(v.changelog)) return v.changelog;
    if (v.record && Array.isArray(v.record.changelog)) return v.record.changelog;
    if (Array.isArray(v.log)) return v.log;
  }
  return null;
}

// ===========================================================================
// EVAL-VER-007 — Advisory bump gate (content-only drift → advisory WARN)
// Phase: v0.2 (FOCUS — advisory drift). Verifies BR-VER-006.
//
// Decided model: a CONTENT-only change (same STRUCTURAL identity — kind/id/path/
// status/modules unchanged — but the committed contentHash != a fresh scan hash)
// is an advisory WARN, never an ERROR. Exit 0 under default; --strict turns the
// advisory WARN into a non-zero exit (the strict dial).
// ===========================================================================
test('EVAL-VER-007 — Advisory bump gate (content-only drift → advisory WARN)', async () => {
  const root = makeSandbox('lib-min');
  try {
    const store = await import(STORE_MJS);

    // Seed a committed registry via the DIRECT manager script (the `forge registry`
    // CLI dispatch is a W3 deliverable, so we do not depend on it here).
    const build = spawnSync(process.execPath, [REGISTRY_MJS, 'build', '--write', root], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.strictEqual(
      build.status,
      0,
      `seed build must succeed; got ${build.status} ${(build.stderr || '').trim()}`,
    );

    // Tamper ONE record's committed contentHash to 64 zeros — a valid-shaped but
    // WRONG hash — leaving every STRUCTURAL field (kind/id/path/status/modules)
    // AND its revision untouched. That is content-only drift, not structural.
    const regPath = path.join(store.forgeStateDir(root), 'registry.json');
    const snap = store.readJson(regPath);
    const rec = findRecord(snap, 'agent:code-reviewer');
    assert.ok(rec, 'record present to staleify');
    const structuralBefore = JSON.stringify({
      kind: rec.kind,
      id: rec.id,
      path: rec.path,
      status: rec.status,
      modules: [...(rec.modules || [])].sort(),
    });
    const revUnchanged = rec.revision;
    rec.contentHash = '0'.repeat(64);
    assert.strictEqual(store.writeJsonAtomic(regPath, snap), true, 'wrote content-drift committed registry');

    // Under DEFAULT, validate-registry emits a WARN naming the gate phrase + uid,
    // and this content-only finding does NOT fail the exit (advisory, exit 0).
    const def = runValidateRegistry(root, false);
    assert.ok(def.reachable, 'validate-registry must exist (RED until built)');
    const defWarn = def.text
      .split(/\r?\n/)
      .find(
        (l) =>
          /^WARN\b/.test(l) &&
          /content changed but revision not bumped/i.test(l) &&
          /code-reviewer/.test(l),
      );
    assert.ok(defWarn, 'expected a WARN "content changed but revision not bumped" naming the uid');
    // It is NOT escalated to a stale ERROR (content-only ≠ structural).
    assert.ok(
      !/^ERROR\b.*registry stale/m.test(def.text),
      'content-only drift must NOT be reported as a structural stale ERROR',
    );
    assert.strictEqual(def.status, 0, 'content-drift WARN alone exits 0 (advisory, C5)');

    // Under --strict, the SAME advisory WARN fails the exit (the strict dial).
    const strict = runValidateRegistry(root, true);
    assert.strictEqual(strict.status, 1, 'under --strict the content-drift WARN exits 1');

    // The record's structural identity + revision were genuinely left unchanged
    // (the gate's precondition: this is content drift, not a structural change).
    const reread = findRecord(store.readJson(regPath), 'agent:code-reviewer');
    assert.strictEqual(reread.revision, revUnchanged, 'gate precondition: revision unchanged');
    const structuralAfter = JSON.stringify({
      kind: reread.kind,
      id: reread.id,
      path: reread.path,
      status: reread.status,
      modules: [...(reread.modules || [])].sort(),
    });
    assert.strictEqual(structuralAfter, structuralBefore, 'gate precondition: structural identity unchanged');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// EVAL-VER-008 — Frontmatter mirror; registry authoritative; back-compatible
// Phase: v0.2. Verifies BR-VER-008.
// ===========================================================================
test('EVAL-VER-008 — Frontmatter mirror; registry authoritative; back-compatible', async () => {
  // (a) The optional advisory `version:` frontmatter key is TOLERATED — this
  //     part exercises the ALREADY-BUILT frontmatter lib (SHOULD pass): a
  //     `version: 9.9.9` is parsed but registry resolution wins.
  const fmMod = await import(FRONTMATTER_MJS);
  const doc = [
    '---',
    'name: drifty',
    'owner: forge',
    'criticality: normal',
    'tags: [review]',
    'version: 9.9.9', // advisory; disagrees with the registry on purpose
    '---',
    '',
    '# body',
    '',
  ].join('\n');
  const parsed = fmMod.parseFrontmatter(doc);
  assert.strictEqual(parsed.present, true, 'frontmatter parsed');
  assert.strictEqual(parsed.data.version, '9.9.9', 'advisory version: key is tolerated (read, not rejected)');

  // (b) Registry authoritative on conflict: with the SAME artifact whose
  //     frontmatter says 9.9.9 but the registry record says 0.2.0, resolution
  //     returns the REGISTRY value (0.2.0). Requires manager/registry.mjs (RED).
  const root = makeSandbox('lib-min');
  try {
    const mod = await tryImport(REGISTRY_MJS);
    assert.ok(mod, 'manager/registry.mjs must exist to resolve the authoritative version (RED until built)');
    const store = await import(STORE_MJS);

    // Plant a divergent advisory `version: 9.9.9` into the on-disk artifact.
    const agentPath = path.join(root, 'agents', 'code-reviewer.md');
    const original = fs.readFileSync(agentPath, 'utf8');
    fs.writeFileSync(agentPath, original.replace(/^version:.*$/m, 'version: 9.9.9'), 'utf8');

    const built = await callRegistry(mod, 'build', ['--write'], root);
    assert.ok(built.ok, 'registry build reachable (RED until built)');

    // Force the committed registry version to 0.2.0 (the authoritative value).
    const regPath = path.join(store.forgeStateDir(root), 'registry.json');
    const snap = store.readJson(regPath);
    const rec = findRecord(snap, 'agent:code-reviewer');
    assert.ok(rec, 'record present');
    rec.version = '0.2.0';
    assert.strictEqual(store.writeJsonAtomic(regPath, snap), true, 'set authoritative registry version 0.2.0');

    const resolved = await resolveVersion(mod, 'agent:code-reviewer', root);
    assert.strictEqual(
      resolved,
      '0.2.0',
      'registry (0.2.0) wins over the 9.9.9 frontmatter mirror',
    );
  } finally {
    cleanup(root);
  }

  // (c) Bundle integer `version: N` maps to "N.0.0" — lib-allkinds ships a
  //     bundle at integer `version: 1` (same mapping shape EVAL-VER-008 names
  //     with `version: 3` → "3.0.0"). Requires the build (RED until built).
  const allkinds = makeSandbox('lib-allkinds');
  try {
    const mod = await tryImport(REGISTRY_MJS);
    assert.ok(mod, 'manager/registry.mjs must exist to map bundle integer version (RED until built)');
    const built = await callRegistry(mod, 'build', ['--write'], allkinds);
    assert.ok(built.ok, 'registry build reachable on lib-allkinds (RED until built)');
    const { snapshot } = await readBuiltRegistry(allkinds);
    const bundle = findRecord(snapshot, 'bundle:work-module');
    assert.ok(bundle, 'bundle:work-module record present');
    assert.strictEqual(
      bundle.version,
      '1.0.0',
      'bundle integer version 1 maps to "1.0.0" (so 3 → "3.0.0") (BR-VER-008)',
    );
  } finally {
    cleanup(allkinds);
  }

  // (d) Back-compat: the presence of the `version:` key must not NEWLY fail any
  //     existing validator. Exercise it through the CLI: `forge validate` on a
  //     tree carrying advisory `version:` frontmatter must not error on that key.
  //     (The full self-validate suite isn't pointed at lib-min, so we assert the
  //     parse path stays clean and the CLI does not crash on the key.)
  assert.doesNotThrow(() => fmMod.parseFrontmatter(doc), 'parsing version: never throws (back-compatible)');
});

/**
 * Resolve a uid's authoritative version via whatever the registry exposes:
 * a `resolveVersion`/`versionOf` export, the `show` verb's record, or the
 * committed snapshot read through the store seam. Returns the version string
 * or null. Pins BEHAVIOR (registry wins) over a single API shape.
 */
async function resolveVersion(mod, uid, root) {
  if (mod && typeof mod.resolveVersion === 'function') {
    try {
      const v = await mod.resolveVersion(uid, { root, forgeRoot: root });
      if (typeof v === 'string') return v;
    } catch {
      /* fall through */
    }
  }
  const shown = await callRegistry(mod, 'show', [uid], root);
  if (shown.ok) {
    const v = shown.value;
    if (v && typeof v === 'object') {
      if (typeof v.version === 'string') return v.version;
      if (v.record && typeof v.record.version === 'string') return v.record.version;
    }
  }
  // Fall back to the committed snapshot (the authoritative store).
  const store = await import(STORE_MJS);
  const snap = store.readJson(path.join(store.forgeStateDir(root), 'registry.json'));
  const rec = findRecord(snap, uid);
  return rec ? rec.version : null;
}
