// @ts-check
/**
 * eval-cli.test.mjs — executable acceptance tests for EVAL-CLI-001 … EVAL-CLI-010
 * (docs/manager/evals/EVAL-CLI.md). RED-first: every case whose feature is not yet
 * built (the `--json` envelope at the parent runner, the manager subcommand dispatch
 * in bin/forge.mjs, manager/registry.mjs, manager/status.mjs, the human/JSON `status`
 * composer, the `--strict` exit dial, lazy dispatch, overlap resolution) must FAIL —
 * not crash the runner. Unimplemented bin sub-verbs exit 2 today => the spawn-based
 * assertions go RED honestly; not-yet-existing modules are dynamically imported INSIDE
 * the test body, wrapped so a missing module becomes an assertion failure (RED), never
 * a thrown import that aborts the file.
 *
 * The parser-direct slice of EVAL-CLI-001 (parseFindings against the throwaway
 * validate-fixture.mjs captured output) and the byte-diff of that child are exercised
 * against the ALREADY-built manager/lib/findings.mjs, so they are GREEN.
 *
 * Run model: node --test tests/manager/   (built-in node:test + node:assert, ZERO deps).
 *
 * Hygiene: a sandboxed FORGE_ROOT / state home is minted per test via
 * fs.mkdtempSync(os.tmpdir()); fixtures are read READ-ONLY and never mutated; each test
 * is deterministic and self-cleaning.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(HERE, '..', '..'); // forge repo root
const BIN = path.join(FORGE_ROOT, 'bin', 'forge.mjs');
const RUN_ALL = path.join(FORGE_ROOT, 'lint', 'run-all.mjs');
const FIX = path.join(HERE, 'fixtures');
const VALIDATE_FIXTURE = path.join(FIX, 'validate-fixture.mjs');
const CLI001_TREE = path.join(FIX, 'cli-001-tree');
const ENVELOPE_SCHEMA = path.join(FORGE_ROOT, 'schemas', 'envelope.schema.json');
const FINDING_SCHEMA = path.join(FORGE_ROOT, 'schemas', 'finding.schema.json');
const LIB_FINDINGS = path.join(FORGE_ROOT, 'manager', 'lib', 'findings.mjs');
const LIB_JSON_OUT = path.join(FORGE_ROOT, 'manager', 'lib', 'json-out.mjs');

// ---------------------------------------------------------------------------
// Zero-dep helpers (no test framework beyond node:test)
// ---------------------------------------------------------------------------

/** Run `node bin/forge.mjs <args>` and capture status/stdout/stderr. */
function runForge(args, { cwd = FORGE_ROOT, env } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...(env || {}) },
  });
}

/** Run `node lint/run-all.mjs <args>`. */
function runRunAll(args, { cwd = FORGE_ROOT } = {}) {
  return spawnSync(process.execPath, [RUN_ALL, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
}

/** A fresh, empty sandbox dir under os.tmpdir(); caller is responsible for cleanup. */
function mkSandbox(tag = 'forge-cli') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Parse the FIRST balanced top-level JSON object found in `text` (or null). */
function firstJsonObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Tiny zero-dep validator for the SUBSET of JSON Schema (draft-07) our two
 * schemas use: required, type (incl. unions + null), enum, additionalProperties,
 * minLength, minimum, items{$ref}, definitions/$ref, format:"date-time".
 * Returns an array of human-readable error strings ([] === valid).
 */
function validateSchema(schema, value) {
  const errs = [];
  const root = schema;
  function resolveRef(ref) {
    // only local "#/definitions/<name>" refs are used by our schemas
    const m = /^#\/definitions\/(.+)$/.exec(ref);
    if (!m) return null;
    return (root.definitions || {})[m[1]] || null;
  }
  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (Number.isInteger(v)) return 'integer';
    return typeof v; // object | string | number | boolean
  }
  function check(node, v, where) {
    if (!node) return;
    if (node.$ref) {
      const target = resolveRef(node.$ref);
      if (!target) errs.push(`${where}: unresolved $ref ${node.$ref}`);
      else check(target, v, where);
      return;
    }
    if (node.type) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      const actual = typeOf(v);
      // integer satisfies "number"; a JSON number that is whole reports "integer"
      const ok =
        types.includes(actual) ||
        (actual === 'integer' && types.includes('number'));
      if (!ok) {
        errs.push(`${where}: type ${JSON.stringify(types)} but got ${actual}`);
        return;
      }
    }
    if (node.enum && !node.enum.includes(v)) {
      errs.push(`${where}: ${JSON.stringify(v)} not in enum ${JSON.stringify(node.enum)}`);
    }
    if (typeof v === 'string') {
      if (typeof node.minLength === 'number' && v.length < node.minLength) {
        errs.push(`${where}: string shorter than minLength ${node.minLength}`);
      }
      if (node.format === 'date-time') {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) errs.push(`${where}: not a date-time: ${v}`);
      }
    }
    if (typeof v === 'number' && typeof node.minimum === 'number' && v < node.minimum) {
      errs.push(`${where}: ${v} < minimum ${node.minimum}`);
    }
    if (node.type === 'object' || node.properties || node.required) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        if (!node.type) return; // nothing more to check
      } else {
        for (const r of node.required || []) {
          if (!(r in v)) errs.push(`${where}: missing required "${r}"`);
        }
        const props = node.properties || {};
        if (node.additionalProperties === false) {
          for (const k of Object.keys(v)) {
            if (!(k in props)) errs.push(`${where}: additional property "${k}" not allowed`);
          }
        }
        for (const [k, sub] of Object.entries(props)) {
          if (k in v) check(sub, v[k], `${where}.${k}`);
        }
      }
    }
    if (node.type === 'array' && Array.isArray(v) && node.items) {
      v.forEach((item, i) => check(node.items, item, `${where}[${i}]`));
    }
  }
  check(root, value, '$');
  return errs;
}

const ENVELOPE = JSON.parse(fs.readFileSync(ENVELOPE_SCHEMA, 'utf8'));
const FINDING = JSON.parse(fs.readFileSync(FINDING_SCHEMA, 'utf8'));

// ===========================================================================
// EVAL-CLI-001 — `--json` envelope from run-all, parsed from `LEVEL path:line`,
// no child change
// ===========================================================================

test('EVAL-CLI-001 — `--json` envelope from run-all, parsed from LEVEL path:line, no child change', async () => {
  // --- GREEN slice: the parser turns the unmodified child's captured output into
  //     exactly the canonical C2 finding (this exercises the already-built lib). ---
  const { parseFindings } = await import(LIB_FINDINGS);
  const child = spawnSync(process.execPath, [VALIDATE_FIXTURE], { encoding: 'utf8' });
  assert.strictEqual(child.status, 0, 'fixture validator exits 0 (WARN-only)');
  const combined = (child.stdout || '') + (child.stderr || ''); // BOTH streams
  const parsed = parseFindings(combined, 'validate-fixture.mjs');
  assert.deepStrictEqual(
    parsed,
    [
      {
        level: 'WARN',
        path: 'agents/x.md',
        line: 12,
        message: 'dangling ref "y"',
        source: 'validate-fixture.mjs',
      },
    ],
    'parser yields exactly the one canonical finding from stdout+stderr',
  );

  // --- Child is byte-identical: the run must not add a --json mode to it. ---
  const before = fs.readFileSync(VALIDATE_FIXTURE);
  const childInTree = path.join(CLI001_TREE, 'lint', 'validate-fixture.mjs');
  const treeBefore = fs.readFileSync(childInTree);

  // --- RED slice: the parent runner has no --json envelope mode yet, so its
  //     stdout is NOT a single C3 envelope. Asserting the envelope shape => RED. ---
  const res = runRunAll(['--json', CLI001_TREE]);
  const env = firstJsonObject(res.stdout || '');
  assert.ok(
    env !== null,
    'run-all --json must emit a JSON envelope on stdout (RED until the parent synthesizes C3)',
  );
  // stdout must be a SINGLE envelope, not banner text wrapping JSON.
  assert.strictEqual(
    (res.stdout || '').trim().startsWith('{'),
    true,
    'run-all --json stdout must be exactly one C3 envelope (no human banner)',
  );
  const schemaErrs = validateSchema(ENVELOPE, env);
  assert.deepStrictEqual(schemaErrs, [], `envelope must satisfy envelope.schema.json: ${schemaErrs.join('; ')}`);
  assert.strictEqual(env.command, 'validate', 'envelope.command === "validate"');
  assert.strictEqual(env.ok, true, 'WARN-only run => ok:true');
  assert.strictEqual(env.summary && env.summary.warnings, 1, 'summary.warnings === 1');
  assert.deepStrictEqual(
    env.findings,
    [
      {
        level: 'WARN',
        path: 'agents/x.md',
        line: 12,
        message: 'dangling ref "y"',
        source: 'validate-fixture.mjs',
      },
    ],
    'envelope.findings contains exactly the one parsed C2 finding',
  );

  // --- Child byte-diff is empty before/after the run (no --json added to it). ---
  const after = fs.readFileSync(VALIDATE_FIXTURE);
  const treeAfter = fs.readFileSync(childInTree);
  assert.ok(before.equals(after), 'validate-fixture.mjs is byte-identical before/after');
  assert.ok(treeBefore.equals(treeAfter), 'cli-001-tree child validator is byte-identical before/after');
});

// ===========================================================================
// EVAL-CLI-002 — One envelope shape across commands; `ok` reflects error count
// ===========================================================================

test('EVAL-CLI-002 — one envelope shape across commands; ok reflects error count', async () => {
  // Both `forge registry ls --json` and `forge validate --json` must emit a single
  // envelope validating against envelope.schema.json, with each finding matching
  // finding.schema.json. RED: `registry` is an unknown command today (exit 2) and
  // `validate --json` does not yet synthesize a JSON envelope.
  const reg = runForge(['registry', 'ls', '--json']);
  assert.notStrictEqual(reg.status, 2, '`forge registry ls` must be a known sub-verb (RED: exits 2 today)');
  const regEnv = firstJsonObject(reg.stdout || '');
  assert.ok(regEnv !== null, '`registry ls --json` must emit a JSON envelope on stdout');
  assert.deepStrictEqual(
    validateSchema(ENVELOPE, regEnv),
    [],
    'registry envelope must satisfy envelope.schema.json',
  );

  const val = runForge(['validate', '--json', CLI001_TREE]);
  const valEnv = firstJsonObject(val.stdout || '');
  assert.ok(valEnv !== null, '`validate --json` must emit a JSON envelope on stdout');
  assert.deepStrictEqual(
    validateSchema(ENVELOPE, valEnv),
    [],
    'validate envelope must satisfy envelope.schema.json',
  );

  // Each finding individually conforms to finding.schema.json.
  for (const f of valEnv.findings || []) {
    assert.deepStrictEqual(validateSchema(FINDING, f), [], `finding must satisfy finding.schema.json: ${JSON.stringify(f)}`);
  }

  // ok-reflects-errors invariant: a WARN-only tree => ok:true.
  assert.strictEqual(valEnv.ok, true, 'WARN-only validate => ok:true (no ERROR finding)');
  assert.strictEqual(
    Boolean(valEnv.summary && valEnv.summary.errors === 0),
    true,
    'WARN-only validate => summary.errors === 0',
  );
});

// ===========================================================================
// EVAL-CLI-003 — `forge status` composes a panel per dimension, fail-open
// ===========================================================================

test('EVAL-CLI-003 — forge status composes a panel per dimension, fail-open (no-data tri-state)', async () => {
  // Only the registry is present; fleet/telemetry/efficiency/eval have no state.
  // Human `status` must show a live REGISTRY panel + four "(no data — run <cmd>)"
  // panels + OVERALL + NEXT ACTIONS, exit 0; `status --json` must carry each panel
  // under data.panels with the absent ones { ok:null, state:"no-data", hint }.
  const stateHome = mkSandbox('forge-statehome');
  try {
    const env = { HOME: stateHome }; // empty ~/.claude/forge => no machine-local state

    const human = runForge(['status'], { env });
    assert.strictEqual(human.status, 0, 'forge status exits 0 (informational)');
    const out = human.stdout || '';
    assert.match(out, /REGISTRY/i, 'human status shows a REGISTRY panel');
    assert.match(out, /no data — run /i, 'human status shows "(no data — run <command>)" panels for absent dimensions');
    assert.match(out, /OVERALL/i, 'human status shows an OVERALL line');
    assert.match(out, /NEXT ACTIONS/i, 'human status shows a NEXT ACTIONS list');

    const json = runForge(['status', '--json'], { env });
    assert.strictEqual(json.status, 0, 'forge status --json exits 0');
    const envObj = firstJsonObject(json.stdout || '');
    assert.ok(envObj !== null, 'status --json emits a JSON envelope');
    assert.deepStrictEqual(validateSchema(ENVELOPE, envObj), [], 'status envelope satisfies envelope.schema.json');
    const panels = envObj.data && envObj.data.panels;
    assert.ok(panels && typeof panels === 'object', 'data.panels is present');
    // At least one absent dimension carries the no-data tri-state.
    const values = Array.isArray(panels) ? panels : Object.values(panels);
    const noData = values.find((p) => p && p.state === 'no-data');
    assert.ok(noData, 'an absent panel carries state:"no-data"');
    assert.strictEqual(noData.ok, null, 'a no-data panel has ok:null (tri-state, not false)');
    assert.ok(typeof noData.hint === 'string' && noData.hint.length > 0, 'a no-data panel carries a hint');
  } finally {
    rmrf(stateHome);
  }
});

// ===========================================================================
// EVAL-CLI-004 — `status` is informational (exit 0); `doctor` is pass/fail + extended
// ===========================================================================

test('EVAL-CLI-004 — status is informational (exit 0); doctor is pass/fail and extended', async () => {
  // status: standing advisory WARNs print and exit 0.
  const stateHome = mkSandbox('forge-statehome');
  try {
    const status = runForge(['status'], { env: { HOME: stateHome } });
    assert.strictEqual(status.status, 0, 'status exits 0 even with advisory WARNs');

    // doctor on a project with a malformed marker: must exit non-zero AND print the
    // additive "MANAGER SCOPE" lines (registry presence, advisory drift).
    const proj = mkSandbox('forge-broken-proj');
    try {
      fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(proj, '.claude', '.forge.json'), '{ this is : not json', 'utf8');
      const doctor = runForge(['doctor', proj], { env: { HOME: stateHome } });
      assert.notStrictEqual(doctor.status, 0, 'doctor on a broken marker exits non-zero');
      const text = (doctor.stdout || '') + (doctor.stderr || '');
      assert.match(text, /MANAGER SCOPE/i, 'doctor prints additive MANAGER SCOPE lines (RED until added)');
    } finally {
      rmrf(proj);
    }
  } finally {
    rmrf(stateHome);
  }
});

// ===========================================================================
// EVAL-CLI-005 — Dry-run is the default; a writer writes nothing without --write
// ===========================================================================

test('EVAL-CLI-005 — dry-run is the default; a writer writes nothing without the apply flag', () => {
  // `forge registry build` (no --write) must leave the tree byte-identical (no
  // registry.json, no registry.log.jsonl); `--write` must create exactly those.
  // RED: `registry` is an unknown command today (exit 2), so nothing is written —
  // but the assertions about a working dispatch + the --write path fail honestly.
  const tree = mkSandbox('forge-drytree');
  try {
    // a minimal library tree with no prior registry
    fs.mkdirSync(path.join(tree, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'VERSION'), '0.1.0\n', 'utf8');
    fs.writeFileSync(
      path.join(tree, 'agents', 'a.md'),
      '---\nname: a\nowner: forge\ndescription: x\ntags: [t]\ncriticality: low\n---\nbody\n',
      'utf8',
    );

    const hashBefore = hashTree(tree);
    const dry = runForge(['registry', 'build', tree]);
    assert.notStrictEqual(dry.status, 2, '`forge registry build` must be a known sub-verb (RED: exits 2 today)');
    const hashAfter = hashTree(tree);
    assert.strictEqual(hashAfter, hashBefore, 'dry-run registry build leaves the tree byte-identical');
    assert.ok(
      !fs.existsSync(path.join(tree, '.forge', 'registry.json')),
      'dry-run writes no registry.json',
    );
    assert.ok(
      !fs.existsSync(path.join(tree, '.forge', 'registry.log.jsonl')),
      'dry-run writes no registry.log.jsonl',
    );

    const wrote = runForge(['registry', 'build', '--write', tree]);
    assert.notStrictEqual(wrote.status, 2, '`forge registry build --write` must be a known sub-verb');
    assert.ok(
      fs.existsSync(path.join(tree, '.forge', 'registry.json')),
      '--write creates registry.json under .forge/',
    );
  } finally {
    rmrf(tree);
  }
});

/** Recursive content hash of a tree (sorted relative paths + bytes). */
function hashTree(root) {
  const h = crypto.createHash('sha256');
  const rels = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) rels.push(path.relative(root, abs));
    }
  })(root);
  rels.sort();
  for (const rel of rels) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

// ===========================================================================
// EVAL-CLI-006 — Lazy dispatch: the hot path imports no manager module
// ===========================================================================

test('EVAL-CLI-006 — lazy dispatch: the hot path imports no manager module', () => {
  // doctor/init/sync must NOT import any forge/manager/* module; `registry ls` must.
  // We instrument with NODE_OPTIONS that aliases nothing; instead we record the
  // module set via a loader that appends imported specifiers to a trace file.
  const trace = mkSandbox('forge-trace');
  const loader = path.join(trace, 'loader.mjs');
  const tracePath = path.join(trace, 'imports.log');
  fs.writeFileSync(
    loader,
    [
      "import fs from 'node:fs';",
      `const TRACE = ${JSON.stringify(tracePath)};`,
      'export async function resolve(spec, ctx, next) {',
      '  const r = await next(spec, ctx);',
      '  try { fs.appendFileSync(TRACE, (r && r.url ? r.url : spec) + "\\n"); } catch {}',
      '  return r;',
      '}',
    ].join('\n'),
    'utf8',
  );

  const proj = mkSandbox('forge-validproj');
  try {
    // a project with a valid marker so doctor/sync take their normal path
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.claude', '.forge.json'),
      JSON.stringify({ forge: '0.1.0-design', profile: 'base' }, null, 2),
      'utf8',
    );

    function importsFor(args) {
      try {
        fs.writeFileSync(tracePath, '', 'utf8');
      } catch {
        /* ignore */
      }
      const res = spawnSync(
        process.execPath,
        ['--experimental-loader', loader, BIN, ...args],
        { cwd: FORGE_ROOT, encoding: 'utf8', timeout: 120000 },
      );
      let log = '';
      try {
        log = fs.readFileSync(tracePath, 'utf8');
      } catch {
        /* ignore */
      }
      return { res, log };
    }

    const hasManager = (log) => /\/manager\//.test(log);

    for (const cmd of [['doctor', proj], ['init', proj], ['sync', proj]]) {
      const { log } = importsFor(cmd);
      assert.strictEqual(
        hasManager(log),
        false,
        `hot path \`forge ${cmd[0]}\` must import NO forge/manager/* module`,
      );
    }

    const { res, log } = importsFor(['registry', 'ls']);
    // RED: `registry` is unknown today (exit 2) so it never imports manager/registry.mjs.
    assert.notStrictEqual(res.status, 2, '`forge registry ls` must be a known sub-verb');
    assert.match(log, /\/manager\/registry\.mjs/, '`registry ls` must import forge/manager/registry.mjs');
  } finally {
    rmrf(proj);
    rmrf(trace);
  }
});

// ===========================================================================
// EVAL-CLI-007 — Print/compute split: a module returns data and emits no stdout
// ===========================================================================

test('EVAL-CLI-007 — print/compute split: a manager module returns data and emits no stdout', async () => {
  // The registry manager module must export run(subcmd,args,ctx) that RETURNS
  // { ok, data, findings, summary } (findings = C2 shape) and prints nothing on
  // stdout/stderr. RED: forge/manager/registry.mjs does not exist yet.
  const REG_MOD = path.join(FORGE_ROOT, 'manager', 'registry.mjs');
  let mod = null;
  try {
    mod = await import(REG_MOD);
  } catch {
    mod = null;
  }
  assert.ok(mod, 'forge/manager/registry.mjs must exist and import cleanly (RED until built)');
  assert.strictEqual(typeof mod.run, 'function', 'manager/registry.mjs must export run(subcmd, args, ctx)');

  // Capture stdout/stderr while the module computes.
  const stdoutChunks = [];
  const stderrChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line no-param-reassign
  process.stdout.write = (c) => (stdoutChunks.push(String(c)), true);
  process.stderr.write = (c) => (stderrChunks.push(String(c)), true);
  let result;
  try {
    result = await mod.run('ls', [], { forgeRoot: FORGE_ROOT });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  assert.ok(result && typeof result === 'object', 'run(...) returns a result object');
  for (const k of ['ok', 'data', 'findings', 'summary']) {
    assert.ok(k in result, `run(...) result has "${k}"`);
  }
  assert.ok(Array.isArray(result.findings), 'result.findings is an array');
  for (const f of result.findings) {
    assert.deepStrictEqual(validateSchema(FINDING, f), [], `result finding matches C2 shape: ${JSON.stringify(f)}`);
  }
  assert.strictEqual(stdoutChunks.join(''), '', 'the module printed NOTHING to stdout');
  assert.strictEqual(stderrChunks.join(''), '', 'the module printed NOTHING to stderr');

  // Rendering the same result through the envelope is consistent.
  const { envelope } = await import(LIB_JSON_OUT);
  const env = envelope({ command: 'registry', ok: result.ok, data: result.data, findings: result.findings, summary: result.summary, forgeVersion: '0.1.0-design' });
  assert.deepStrictEqual(env.findings, result.findings, 'json render preserves the module findings');
  assert.deepStrictEqual(env.data, result.data, 'json render preserves the module data');
});

// ===========================================================================
// EVAL-CLI-008 — `--strict` is the only dial that makes advisory WARNs fail
// ===========================================================================

test('EVAL-CLI-008 — --strict is the only dial that makes advisory WARNs fail the exit', () => {
  // A WARN-only tree: `forge validate` exits 0; `forge validate --strict` exits non-zero.
  const ok = runForge(['validate', CLI001_TREE]);
  assert.strictEqual(ok.status, 0, '`forge validate` on a WARN-only tree exits 0');

  const strict = runForge(['validate', '--strict', CLI001_TREE]);
  assert.notStrictEqual(
    strict.status,
    0,
    '`forge validate --strict` must fail (non-zero) on advisory WARNs (RED until the strict dial promotes WARN→fail)',
  );

  // --json honors the same suppression behavior across two groups (validate & registry ls).
  const jval = runForge(['validate', '--json', CLI001_TREE]);
  assert.ok(firstJsonObject(jval.stdout || '') !== null, '`validate --json` emits an envelope');
  const jreg = runForge(['registry', 'ls', '--json']);
  assert.notStrictEqual(jreg.status, 2, '`registry ls --json` must be a known sub-verb');
  assert.ok(firstJsonObject(jreg.stdout || '') !== null, '`registry ls --json` emits an envelope');
});

// ===========================================================================
// EVAL-CLI-009 — `forge --help` lists the manager surface; unknown sub-verb fail-soft
// ===========================================================================

test('EVAL-CLI-009 — forge --help lists the manager surface; unknown sub-verb is fail-soft', () => {
  const help = runForge(['--help']);
  assert.strictEqual(help.status, 0, '`forge --help` exits 0');
  const text = (help.stdout || '') + (help.stderr || '');
  assert.match(text, /MANAGER/, '`--help` contains a MANAGER section (RED until added)');
  for (const verb of ['registry', 'fleet', 'telemetry', 'analyze', 'optimize', 'eval-harness', 'status', 'monitor']) {
    assert.match(text, new RegExp(`\\b${verb}\\b`), `MANAGER section names "${verb}"`);
  }

  // Unknown sub-verb under a known group: usage + exit 2.
  const bogus = runForge(['registry', 'bogus']);
  assert.strictEqual(bogus.status, 2, '`forge registry bogus` exits 2 (mirrors top-level default:)');
  const bogusText = (bogus.stdout || '') + (bogus.stderr || '');
  assert.match(bogusText, /registry/i, 'unknown sub-verb prints registry usage');
});

// ===========================================================================
// EVAL-CLI-010 — Overlap resolution: no `forge stat`; analyze is read-only
// ===========================================================================

test('EVAL-CLI-010 — overlap resolution: stat is the promoted telemetry-rollup alias; analyze is read-only; distinct paths', () => {
  // v0.4 PROMOTION (ROADMAP §v0.4; EVAL-TEL-013; SPEC-05): `forge stat` is the
  // top-level alias for `forge telemetry stat` — the rollup reader. As a telemetry
  // reader it is FAIL-OPEN: off/empty ⇒ an actionable message + exit 0, NEVER a
  // block (BR-TEL-013). It is therefore NOT exit-2-unknown; the overlap rule that
  // matters is that `stat` resolves to the telemetry rollup, NOT to the composed
  // `status` dashboard nor to the `monitor` snapshot (three DISTINCT paths below).
  const stat = runForge(['stat']);
  assert.notStrictEqual(stat.status, 2, '`forge stat` is the promoted telemetry-rollup alias (a known reader, not exit-2)');
  assert.strictEqual(stat.status, 0, '`forge stat` is a fail-open reader: off/empty ⇒ exit 0 (never blocks)');

  // telemetry status · status · monitor must dispatch to three DISTINCT code paths,
  // each known AND behaving distinctly (subsystem state · composed dashboard · live tail).
  const telem = runForge(['telemetry', 'status']);
  const status = runForge(['status']);
  const monitor = runForge(['monitor']);
  assert.notStrictEqual(telem.status, 2, '`forge telemetry status` must be a known sub-verb (distinct path)');
  assert.notStrictEqual(status.status, 2, '`forge status` must be a known command (distinct path)');
  assert.notStrictEqual(monitor.status, 2, '`forge monitor` must be a known command (distinct path)');

  // The promoted `stat` alias is the telemetry rollup, NOT the composed `status`
  // dashboard — distinct outputs (the overlap-resolution invariant this case pins).
  assert.notStrictEqual(
    (stat.stdout || '').trim(),
    (status.stdout || '').trim(),
    '`stat` (telemetry rollup) and `status` (composed dashboard) are distinct outputs',
  );
  // status (composed dashboard) and telemetry status (subsystem) are not the same output.
  assert.notStrictEqual(
    (status.stdout || '').trim(),
    (telem.stdout || '').trim(),
    '`status` (composed dashboard) and `telemetry status` (subsystem) are distinct outputs',
  );

  // `forge analyze --apply` is rejected: analyze is read-only and accepts no mutation flag.
  const analyze = runForge(['analyze', '--apply']);
  assert.notStrictEqual(analyze.status, 0, '`forge analyze --apply` is rejected (analyze is read-only)');
  const aText = (analyze.stdout || '') + (analyze.stderr || '');
  assert.match(aText, /analyze|usage|read-only|apply/i, '`analyze --apply` prints a usage/rejection message');
});
