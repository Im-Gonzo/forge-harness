// @ts-check
/**
 * eval-eff.test.mjs — executable acceptance specs for Efficiency & Optimization
 * (SPEC-06, BR-EFF-001..012). Covers the **Phase-v0.3 STATIC** EVAL-EFF cases from
 * docs/manager/evals/EVAL-EFF.md:
 *
 *   EVAL-EFF-001  token estimator matches pinned fixtures + constants from one place
 *   EVAL-EFF-002  residency classes (hook ≠ its .mjs size; validator = 0)
 *   EVAL-EFF-003  always-on itemized total + per-profile budget via resolveModules
 *   EVAL-EFF-004  static dead-detection D1–D4 with check-ids
 *   EVAL-EFF-005  D5 vacuous path-scoped rule in a --project
 *   EVAL-EFF-006  CRITICAL REGRESSION — a 0-fire secret-scan never reaches the prune-plan
 *   EVAL-EFF-007  thin window downgrades a never-fired normal artifact to watch, not prune
 *   EVAL-EFF-009  analyze degrades to static-only when telemetry is off/empty
 *
 * The v0.6 DYNAMIC / value-density cases (EVAL-EFF-008, -010, -011, -012, -013) are
 * added as **RED placeholders only** (clearly tagged, NOT part of the v0.3 gate) so
 * the corpus stays complete; they are skipped from execution via `test(..., {skip})`
 * with a deferral reason so they neither pass-by-accident nor crash the runner.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HONEST RED — none of the v0.3 efficiency feature exists yet:
 *   - manager/efficiency.mjs            (the run/summarize C4 module + analyze/optimize)
 *   - manager/analyze/constants.mjs     (CHARS_PER_TOKEN, CODE_DENSITY, MIN_SESSIONS, MIN_DAYS)
 *   - manager/analyze/estimate.mjs      (the token estimator)
 *   - manager/analyze/residency.mjs     (residency classification)
 *   - manager/analyze/dead-static.mjs   (D1–D5)
 *   - manager/analyze/criticality.json  (the seeded safety allowlist)
 *   - bin/forge.mjs `analyze` body      (today: a "planned for v0.3" notice, exit 0)
 *
 * For an unbuilt MODULE we dynamic-import INSIDE the test body wrapped in try/catch,
 * then assert the module + the named export exist — a missing module becomes an
 * assertion FAILURE (RED), never a crash that aborts the node:test runner. For CLI
 * behavior we spawnSync `node bin/forge.mjs analyze … --json` and assert on the
 * STRUCTURED report `data` (residency/deadStatic/lowActivitySafety/…). Today the
 * `analyze` verb emits a planned-notice and exits 0 WITHOUT that structured data, so
 * those assertions fail (RED) rather than crash. We NEVER import/spawn a module that
 * calls process.exit() at import time (that would silently kill the runner — the v0.2
 * defect this file is forbidden from re-introducing).
 *
 * Zero runtime deps (node: builtins only). Each test is deterministic and
 * self-cleaning: every fixture is SYNTHESIZED into an os.tmpdir() sandbox via
 * fs.mkdtempSync (the real repo and the frozen tests/manager/fixtures/* are NEVER
 * mutated). Run model: `node --test tests/manager/`.
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
const FORGE_BIN = path.join(FORGE_ROOT, 'bin', 'forge.mjs');

// The v0.3 efficiency surface this file targets (all RED today).
const EFFICIENCY_MODULE = path.join(FORGE_ROOT, 'manager', 'efficiency.mjs');
const CONSTANTS_MODULE = path.join(FORGE_ROOT, 'manager', 'analyze', 'constants.mjs');
const ESTIMATE_MODULE = path.join(FORGE_ROOT, 'manager', 'analyze', 'estimate.mjs');
const CRITICALITY_JSON = path.join(FORGE_ROOT, 'manager', 'analyze', 'criticality.json');

// The five seed-tagged safety controls (SPEC-06 §Criticality, BR-EFF-006).
const SEED_SAFETY = [
  'secret-scan',
  'block-no-verify',
  'config-protection',
  'prompt-defense-baseline',
  'security-baseline',
];

// ---------------------------------------------------------------------------
// Sandbox helpers — synthesize a tiny harness under os.tmpdir(). Nothing here
// touches the real repo or the frozen fixtures.
// ---------------------------------------------------------------------------

/** Make a fresh tmp sandbox dir and return its absolute root. @param {string} tag */
function mkSandbox(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-eff-${tag}-`));
}

/** Remove a sandbox dir best-effort (fail-open in teardown). @param {string} root */
function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Write a file, creating parent dirs. @param {string} root @param {string} rel @param {string} body */
function writeFile(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

/** Write a JSON file. @param {string} root @param {string} rel @param {any} obj */
function writeJson(root, rel, obj) {
  return writeFile(root, rel, JSON.stringify(obj, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Dynamic-import helpers — turn "module not built" into an assertion failure
// (HONEST RED), never a thrown crash that aborts the runner.
// ---------------------------------------------------------------------------

/**
 * Import an as-yet-unbuilt module by absolute path; resolves to its namespace or
 * `null` if it does not exist / fails to load.
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
 * Resolve a callable export from a module namespace, tolerant of the eventual
 * export name. Returns the function or null.
 * @param {any|null} mod
 * @param {string[]} names candidate export names, in priority order
 * @returns {Function|null}
 */
function resolveExport(mod, names) {
  if (!mod || typeof mod !== 'object') return null;
  for (const n of names) {
    if (typeof mod[n] === 'function') return mod[n];
    if (mod.default && typeof mod.default[n] === 'function') return mod.default[n];
  }
  if (typeof mod.default === 'function') return mod.default;
  return null;
}

/**
 * Resolve the efficiency module's `run(subcmd,args,ctx)` C4 entry, tolerant of the
 * eventual export name. Returns the function or null.
 * @param {any|null} mod
 * @returns {Function|null}
 */
function resolveRun(mod) {
  return resolveExport(mod, ['run']);
}

/**
 * Call the efficiency module's analyze and coerce its returned report `data`.
 * Returns `{ ok, data }` or null if the module/entry is unbuilt (→ caller asserts RED).
 * @param {string} rootDir
 * @param {string[]} [args] extra argv after `analyze` (e.g. ['--project', dir])
 * @returns {Promise<{ok:boolean,data:any}|null>}
 */
async function analyzeVia(rootDir, args = []) {
  const mod = await tryImport(EFFICIENCY_MODULE);
  const run = resolveRun(mod);
  if (!run) return null;
  let res;
  try {
    res = await run('analyze', args, { FORGE_ROOT: rootDir, root: rootDir, cwd: rootDir });
  } catch {
    return null;
  }
  if (!res || typeof res !== 'object') return null;
  const data = res.data && typeof res.data === 'object' ? res.data : res;
  return { ok: !!res.ok, data };
}

/**
 * Run `node bin/forge.mjs <args…> --json` and parse the envelope. Used as the CLI
 * surface so today's planned-notice (no structured `data`) registers as RED.
 * @param {string[]} args argv after `forge`
 * @param {string} cwd
 * @returns {{status:number|null, stdout:string, stderr:string, env:any|null}}
 */
function runForgeJson(args, cwd) {
  const res = spawnSync('node', [FORGE_BIN, ...args, '--json'], { cwd, encoding: 'utf8' });
  let env = null;
  try {
    env = JSON.parse(res.stdout || '');
  } catch {
    env = null;
  }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', env };
}

/** Coerce an analyze report's artifact list. @param {any} data @returns {any[]} */
function artifactsOf(data) {
  return data && Array.isArray(data.artifacts) ? data.artifacts : [];
}

/** Find an artifact record by uid in a report. @param {any} data @param {string} uid */
function findArtifact(data, uid) {
  return artifactsOf(data).find((a) => a && a.uid === uid) || null;
}

/** Coerce the static-dead list. @param {any} data @returns {any[]} */
function deadStaticOf(data) {
  return data && Array.isArray(data.deadStatic) ? data.deadStatic : [];
}

/** True if a deadStatic entry with the given checkId names the uid. */
function hasDead(data, checkId, uid) {
  return deadStaticOf(data).some(
    (d) => d && d.checkId === checkId && (d.uid === uid || d.uid === undefined || d.uid === null ? d.uid === uid : false),
  );
}

// ---------------------------------------------------------------------------
// Fixture synthesizers — minimal harness trees written into a sandbox.
// ---------------------------------------------------------------------------

/**
 * A path-scoped TS/React rule (mirrors the real rules/typescript/react-patterns.md
 * frontmatter: `paths: ["**\/*.ts", "**\/*.tsx"]`).
 */
function reactPatternsRule() {
  return [
    '---',
    'name: react-patterns',
    'description: React / Next.js patterns. Rules of Hooks, RSC boundary, stable keys.',
    'paths: ["**/*.ts", "**/*.tsx"]',
    '---',
    '# React Patterns',
    '',
    'Scoped to TypeScript/TSX files only.',
    '',
  ].join('\n');
}

/** An always-on rule (no `paths:` — mirrors prompt-defense-baseline). */
function alwaysOnRule(name) {
  return [
    '---',
    `name: ${name}`,
    `description: Always-on ${name}. No paths scope — applies every turn.`,
    '---',
    `# ${name}`,
    '',
    'This rule has no paths scope.',
    '',
  ].join('\n');
}

// ===========================================================================
// EVAL-EFF-001 — token estimator matches pinned fixtures and reads its
// constants from one place (BR-EFF-001). Phase v0.3. Grader: code, pass^k=1.00.
// ===========================================================================
test('EVAL-EFF-001 — token estimator matches pinned fixtures; constants from one place', async () => {
  // The two estimator constants MUST live in exactly one place: analyze/constants.mjs.
  const constants = await tryImport(CONSTANTS_MODULE);
  assert.ok(constants, `manager/analyze/constants.mjs must exist and load (got ${constants})`);
  const CHARS_PER_TOKEN =
    constants && (constants.CHARS_PER_TOKEN ?? (constants.default && constants.default.CHARS_PER_TOKEN));
  const CODE_DENSITY =
    constants && (constants.CODE_DENSITY ?? (constants.default && constants.default.CODE_DENSITY));
  assert.strictEqual(CHARS_PER_TOKEN, 4, 'CHARS_PER_TOKEN is the seeded 4');
  assert.strictEqual(CODE_DENSITY, 1.15, 'CODE_DENSITY is the seeded 1.15');

  // The estimator MUST exist and apply the SPEC-06 formula:
  //   base = round(0.5*ceil(chars/CHARS_PER_TOKEN) + 0.5*ceil(words*1.33))
  //   dense ? round(base*CODE_DENSITY) : base
  const estMod = await tryImport(ESTIMATE_MODULE);
  const estimate = resolveExport(estMod, ['estimate', 'estimateTokens']);
  assert.ok(estimate, 'manager/analyze/estimate.mjs must export an estimate() function');

  // Three pinned fixtures (a plain rule, a code-dense validator body, a JSON
  // manifest). Bodies are chosen so chars + whitespace-word counts are unambiguous,
  // and the expected ~N is pre-computed from the formula with the seeded constants.
  /** @param {string} t @returns {number} */
  const chars = (t) => t.length;
  /** @param {string} t @returns {number} */
  const words = (t) => (t.trim().length ? t.trim().split(/\s+/).length : 0);
  /** @param {string} t @param {boolean} dense @returns {number} */
  const expected = (t, dense) => {
    const base = Math.round(0.5 * Math.ceil(chars(t) / CHARS_PER_TOKEN) + 0.5 * Math.ceil(words(t) * 1.33));
    return dense ? Math.round(base * CODE_DENSITY) : base;
  };

  const plainRule = 'This rule has no paths scope. Keep claims backed by fresh evidence, not memory.';
  const denseValidator = 'function main(){ const x = JSON.parse(read()); return x.ok ? 0 : 1; }\nmain();\n';
  const jsonManifest = JSON.stringify({ version: 1, modules: { review: { components: { agents: ['code-reviewer'] } } } });

  for (const [label, text, dense] of /** @type {Array<[string,string,boolean]>} */ ([
    ['plainRule', plainRule, false],
    ['denseValidator', denseValidator, true],
    ['jsonManifest', jsonManifest, true],
  ])) {
    const got = estimate(text, dense);
    assert.strictEqual(
      got,
      expected(text, dense),
      `${label}: estimate(${dense ? 'dense' : 'plain'}) equals the pinned formula value`,
    );
    assert.ok(Number.isInteger(got) && got >= 0, `${label}: estimate is a non-negative integer`);
  }

  // The constants are read from ONE place, not inlined: the dense multiplier MUST be
  // exactly CODE_DENSITY over the non-dense base for the SAME text (proving the
  // estimator consumes CODE_DENSITY from constants.mjs rather than a hard-coded 1.15).
  const base = estimate(denseValidator, false);
  const dense = estimate(denseValidator, true);
  assert.strictEqual(
    dense,
    Math.round(base * CODE_DENSITY),
    'dense estimate = round(base * CODE_DENSITY) — CODE_DENSITY is applied from the constants module',
  );

  // Every figure rendered to a human MUST carry a leading `~` (estimate, not exact).
  // The analyze report's per-artifact line is the human surface; assert the renderer
  // tags figures with `~` (via the human CLI render, which is the leading-`~` surface).
  const root = mkSandbox('eff001');
  try {
    writeJson(root, 'manifests/modules.json', { version: 1, modules: {} });
    writeFile(root, 'rules/plain.md', alwaysOnRule('plain'));
    const human = spawnSync('node', [FORGE_BIN, 'analyze', root], { cwd: root, encoding: 'utf8' });
    const out = (human.stdout || '') + (human.stderr || '');
    // RED today: `analyze` emits the planned-notice, which contains NO `~N` token
    // figure. GREEN once analyze renders estimates with a leading `~`.
    assert.match(out, /~\d/, 'analyze renders token figures with a leading `~` (estimate, never exact)');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// EVAL-EFF-002 — residency classes: hook ≠ its .mjs size; validator = 0
// (BR-EFF-002). Phase v0.3. Grader: code, pass^k=1.00.
// ===========================================================================
test('EVAL-EFF-002 — residency classes (hook = desc+injection, validator = 0)', async () => {
  const root = mkSandbox('eff002');
  try {
    // A harness with: an always-on rule (no paths:), a path-scoped rule (paths:),
    // an agent, a validator, and a hook with a permissionDecisionReason literal.
    writeFile(root, 'rules/security-baseline.md', alwaysOnRule('security-baseline'));
    writeFile(root, 'rules/react-patterns.md', reactPatternsRule());
    writeFile(
      root,
      'agents/code-reviewer.md',
      ['---', 'name: code-reviewer', 'description: Reviews diffs for correctness.', '---', '# Code Reviewer', '', 'A long agent body that should NOT be counted as always-on; only the description is.', ''].join('\n'),
    );
    writeFile(
      root,
      'lint/validate-sample.mjs',
      ['#!/usr/bin/env node', '// a validator — runs in a child process, never in model context', 'function main(){ return 0; }', 'main();', ''].join('\n'),
    );
    // A hook whose ONLY injection is its BLOCKED reason literal. The .mjs source is
    // padded with bulk so estimate(whole source) >> description + injection.
    const bulk = '// padding line that inflates the .mjs source size\n'.repeat(40);
    writeFile(
      root,
      'hooks/secret-scan.mjs',
      [
        '#!/usr/bin/env node',
        bulk,
        'const out = {',
        '  hookSpecificOutput: {',
        '    permissionDecision: "deny",',
        '    permissionDecisionReason: "BLOCKED: a possible secret was detected; use env vars or a secret store.",',
        '  },',
        '};',
        'process.stdout.write(JSON.stringify(out));',
        '',
      ].join('\n'),
    );
    writeJson(root, 'hooks/hooks.json', {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/secret-scan.mjs"' }],
            description: 'GLOBAL SAFETY: flag obvious hard-coded secrets and block the write.',
            id: 'forge:secret-scan',
          },
        ],
      },
    });
    writeJson(root, 'manifests/modules.json', { version: 1, modules: {} });
    writeFile(root, 'manager/analyze/criticality.json', '{}'); // placeholder; real one is in repo

    const report = await analyzeVia(root);
    assert.ok(report, 'manager/efficiency.mjs analyze must be built and return a report');
    const data = report.data;

    // No-paths rule → always-on; path-scoped rule → conditional.
    const secBaseline = findArtifact(data, 'rule:security-baseline');
    assert.ok(secBaseline, 'security-baseline rule is in the report');
    assert.strictEqual(secBaseline.residency, 'always-on', 'no-paths rule is always-on');
    const react = findArtifact(data, 'rule:react-patterns');
    assert.ok(react, 'react-patterns rule is in the report');
    assert.strictEqual(react.residency, 'conditional', 'path-scoped rule is conditional');

    // Validator → on-demand, estTokens === 0 (its source never enters model context).
    const validator = findArtifact(data, 'validator:validate-sample');
    assert.ok(validator, 'validator is in the report');
    assert.strictEqual(validator.residency, 'on-demand', 'validator residency is on-demand');
    assert.strictEqual(validator.estTokens, 0, 'validator estTokens is exactly 0');

    // Hook cost = description + injection-literal, STRICTLY LESS than estimate(whole .mjs).
    const hook = findArtifact(data, 'hook:forge:secret-scan');
    assert.ok(hook, 'hook is in the report');
    assert.strictEqual(hook.residency, 'always-on', 'hook residency is always-on (desc+injection are resident)');
    assert.ok(
      hook.costBreakdown && typeof hook.costBreakdown === 'object',
      'hook carries a costBreakdown {description, injection}',
    );
    assert.ok(Number.isInteger(hook.costBreakdown.description) && hook.costBreakdown.description > 0, 'hook description cost > 0');
    assert.ok(Number.isInteger(hook.costBreakdown.injection) && hook.costBreakdown.injection > 0, 'hook injection cost > 0 (the BLOCKED literal)');
    assert.strictEqual(
      hook.estTokens,
      hook.costBreakdown.description + hook.costBreakdown.injection,
      'hook estTokens = description + injection',
    );

    // The whole .mjs source is NEVER counted: estimate(source) must dwarf the hook cost.
    const estMod = await tryImport(ESTIMATE_MODULE);
    const estimate = resolveExport(estMod, ['estimate', 'estimateTokens']);
    assert.ok(estimate, 'estimate() available to bound the hook source cost');
    const srcText = fs.readFileSync(path.join(root, 'hooks', 'secret-scan.mjs'), 'utf8');
    const wholeSourceEst = estimate(srcText, true);
    assert.ok(
      hook.estTokens < wholeSourceEst,
      `hook cost (${hook.estTokens}) is strictly less than estimate(whole .mjs source) (${wholeSourceEst}) — source is never counted`,
    );
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// EVAL-EFF-003 — always-on total is an itemized sum and per-profile budget uses
// resolveModules (BR-EFF-003). Phase v0.3. Grader: code, pass^k=1.00.
// ===========================================================================
test('EVAL-EFF-003 — always-on total is an itemized sum; per-profile via resolveModules', async () => {
  const root = mkSandbox('eff003');
  try {
    // Two always-on rules + one path-scoped rule. The always-on TOTAL must be the
    // exact itemized sum (no hard-coded constant), and removing one always-on item
    // must lower the total by that item's own estimate.
    writeFile(root, 'rules/prompt-defense-baseline.md', alwaysOnRule('prompt-defense-baseline'));
    writeFile(root, 'rules/security-baseline.md', alwaysOnRule('security-baseline'));
    writeFile(root, 'rules/react-patterns.md', reactPatternsRule());
    writeJson(root, 'manifests/modules.json', {
      version: 1,
      modules: {
        'rules-common': { components: { rules: ['prompt-defense-baseline', 'security-baseline'] } },
        typescript: { components: { rules: ['react-patterns'] } },
      },
    });
    // A `generic` profile whose module set is resolved by the SAME resolveModules the
    // composer uses; a moduleSelectionRules.add delta adds `typescript` on a fact.
    writeJson(root, 'manifests/profiles.json', {
      version: 1,
      defaultProfile: 'generic',
      profiles: {
        generic: { modules: ['rules-common'] },
      },
      moduleSelectionRules: {
        add: [{ when: "facts.languages includes 'typescript'", module: 'typescript' }],
      },
    });

    const report = await analyzeVia(root);
    assert.ok(report, 'manager/efficiency.mjs analyze must be built and return a report');
    const data = report.data;

    // (a) alwaysOnTotal equals the exact sum of the itemized ALWAYS-ON members.
    const alwaysOnItems = artifactsOf(data).filter((a) => a && a.residency === 'always-on');
    assert.ok(alwaysOnItems.length >= 2, 'at least the two always-on rules are itemized');
    const itemizedSum = alwaysOnItems.reduce((n, a) => n + (Number.isInteger(a.estTokens) ? a.estTokens : 0), 0);
    assert.strictEqual(
      data.alwaysOnTotal,
      itemizedSum,
      'alwaysOnTotal is the exact itemized sum of the ALWAYS-ON list (not a hard-coded constant)',
    );

    // Removing one always-on item lowers the total by that item's estimate.
    const removed = findArtifact(data, 'rule:security-baseline');
    assert.ok(removed && Number.isInteger(removed.estTokens) && removed.estTokens > 0, 'security-baseline has a positive estimate');
    fs.rmSync(path.join(root, 'rules', 'security-baseline.md'));
    writeJson(root, 'manifests/modules.json', {
      version: 1,
      modules: {
        'rules-common': { components: { rules: ['prompt-defense-baseline'] } },
        typescript: { components: { rules: ['react-patterns'] } },
      },
    });
    const report2 = await analyzeVia(root);
    assert.ok(report2, 'analyze re-runs after the removal');
    assert.strictEqual(
      report2.data.alwaysOnTotal,
      data.alwaysOnTotal - removed.estTokens,
      'removing one always-on item lowers alwaysOnTotal by exactly that item estimate',
    );

    // (b) perProfile[generic] is computed via resolveModules and reflects the
    //     moduleSelectionRules.add delta (adding `typescript` brings react-patterns
    //     into the conditional ceiling but not the always-on figure).
    const generic = data.perProfile && data.perProfile.generic;
    assert.ok(generic, 'report has perProfile.generic');
    assert.ok(Number.isInteger(generic.alwaysOn), 'perProfile.generic.alwaysOn is an integer');
    assert.ok(Number.isInteger(generic.conditionalCeiling), 'perProfile.generic.conditionalCeiling is an integer');
    // generic resolves rules-common (always-on rules) → alwaysOn equals their sum.
    assert.strictEqual(
      generic.alwaysOn,
      itemizedSum,
      'perProfile.generic.alwaysOn equals the resolved always-on members of the generic profile',
    );
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// EVAL-EFF-004 — static dead-detection reports D1–D4 with their check-ids
// (BR-EFF-004). Phase v0.3. Grader: code, pass^k=1.00.
// ===========================================================================
test('EVAL-EFF-004 — static dead-detection D1–D4 with check-ids', async () => {
  const root = mkSandbox('eff004');
  try {
    // Planted instances:
    //   D1 orphan module     — module "orphan-mod" in ZERO profiles, not always:true.
    //   D2 orphan component  — agent "lonely" in NO module.
    //   D3 orphan file       — rules/orphan-file.md on disk, in no module.
    //   D4 dangling ref      — module "review" names agent "ghost" with no backing file.
    writeFile(root, 'agents/code-reviewer.md', ['---', 'name: code-reviewer', 'description: in a module.', '---', '# CR', ''].join('\n'));
    writeFile(root, 'agents/lonely.md', ['---', 'name: lonely', 'description: in no module (D2).', '---', '# Lonely', ''].join('\n'));
    writeFile(root, 'rules/in-module.md', alwaysOnRule('in-module'));
    writeFile(root, 'rules/orphan-file.md', alwaysOnRule('orphan-file')); // on disk, no module (D3)

    writeJson(root, 'manifests/modules.json', {
      version: 1,
      modules: {
        review: {
          components: {
            agents: ['code-reviewer', 'ghost'], // ghost has no backing file → D4 dangling ref
            rules: ['in-module'],
          },
        },
        'orphan-mod': {
          // present in modules.json but in zero profiles, not always:true → D1
          components: { rules: ['in-module'] },
        },
      },
    });
    writeJson(root, 'manifests/profiles.json', {
      version: 1,
      defaultProfile: 'generic',
      profiles: { generic: { modules: ['review'] } }, // orphan-mod is referenced by no profile
    });

    const report = await analyzeVia(root);
    assert.ok(report, 'manager/efficiency.mjs analyze must be built and return a report');
    const data = report.data;
    const dead = deadStaticOf(data);
    assert.ok(dead.length > 0, 'analyze reports static-dead findings');

    /** @param {string} id @param {(d:any)=>boolean} pred @param {string} why */
    const assertDead = (id, pred, why) => {
      const hit = dead.find((d) => d && d.checkId === id && pred(d));
      assert.ok(hit, `${id} reported against the correct artifact (${why})`);
    };

    // D1 orphan module.
    assertDead('D1', (d) => typeof d.uid === 'string' && d.uid.includes('orphan-mod'), 'module orphan-mod in zero profiles');
    // D2 orphan component.
    assertDead('D2', (d) => d.uid === 'agent:lonely', 'agent lonely in no module');
    // D3 orphan file.
    assertDead('D3', (d) => d.uid === 'rule:orphan-file', 'rules/orphan-file.md on disk, in no module');
    // D4 dangling ref — and it MUST cite the dependency-graph resolution (BR-DEP / SPEC-03),
    // not re-derive it: the evidence references the dep graph / dangling-ref source.
    const d4 = dead.find((d) => d && d.checkId === 'D4' && typeof d.uid === 'string' && d.uid.includes('ghost'));
    assert.ok(d4, 'D4 dangling ref reported for the ghost component');
    assert.match(
      String(d4.evidence || d4.source || ''),
      /dep|dangling|graph|SPEC-03|BR-DEP/i,
      'D4 cites the dependency-graph / dangling-ref resolution rather than re-deriving it',
    );
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// EVAL-EFF-005 — D5 detects a vacuous path-scoped rule in a --project
// (BR-EFF-004). Phase v0.3. Grader: code, pass^k=1.00.
// ===========================================================================
test('EVAL-EFF-005 — D5 vacuous path-scoped rule (inert here, not everywhere)', async () => {
  const harness = mkSandbox('eff005-harness');
  const pyProject = mkSandbox('eff005-python');
  const tsProject = mkSandbox('eff005-tsx');
  try {
    // A harness carrying react-patterns (paths: **/*.ts, **/*.tsx).
    writeFile(harness, 'rules/react-patterns.md', reactPatternsRule());
    writeJson(harness, 'manifests/modules.json', { version: 1, modules: { typescript: { components: { rules: ['react-patterns'] } } } });

    // A pure-Python project: no .ts/.tsx files anywhere.
    writeFile(pyProject, 'app/main.py', 'def main():\n    return 0\n');
    writeFile(pyProject, 'app/util.py', 'X = 1\n');

    // A project that DOES contain .tsx — react-patterns is NOT vacuous here.
    writeFile(tsProject, 'src/App.tsx', 'export default function App(){ return null; }\n');
    writeFile(tsProject, 'src/util.ts', 'export const x = 1;\n');

    // analyze --project <pyproj> → react-patterns is a D5 vacuous rule.
    const reportPy = await analyzeVia(harness, ['--project', pyProject]);
    assert.ok(reportPy, 'manager/efficiency.mjs analyze --project must be built');
    const d5 = deadStaticOf(reportPy.data).find(
      (d) => d && d.checkId === 'D5' && typeof d.uid === 'string' && d.uid.includes('react-patterns'),
    );
    assert.ok(d5, 'react-patterns reported as D5 vacuous in the pure-Python project');
    assert.match(
      String(d5.evidence || ''),
      /0 files|matched 0|\bzero\b/i,
      'D5 evidence states the globs matched 0 files',
    );

    // The SAME analyze on a project WITH .tsx files does NOT flag react-patterns (it is
    // inert only HERE, not everywhere).
    const reportTs = await analyzeVia(harness, ['--project', tsProject]);
    assert.ok(reportTs, 'analyze --project <tsproj> runs');
    const d5OnTs = deadStaticOf(reportTs.data).filter(
      (d) => d && d.checkId === 'D5' && typeof d.uid === 'string' && d.uid.includes('react-patterns'),
    );
    assert.deepStrictEqual(d5OnTs, [], 'react-patterns is NOT D5-flagged in a project that has .tsx files');
  } finally {
    cleanup(harness);
    cleanup(pyProject);
    cleanup(tsProject);
  }
});

// ===========================================================================
// EVAL-EFF-006 — CRITICAL REGRESSION: a 0-fire secret-scan never reaches the
// prune-plan (BR-EFF-006, -007, -012). Phase v0.3 (lock). Grader: code, pass^k=1.00.
//
// This is the load-bearing case. The lock is asserted at the DATA layer (the
// structured analyze report AND the optimize plan), not in prose.
// ===========================================================================
test('EVAL-EFF-006 — CRITICAL: a 0-fire secret-scan never reaches the prune-plan', async () => {
  const root = mkSandbox('eff006');
  try {
    // Seed the five safety controls + a normal artifact. The criticality.json seed
    // tags the five as `safety`.
    writeJson(root, 'manager/analyze/criticality.json', {
      safety: SEED_SAFETY.map((n) => (n.endsWith('-baseline') ? `rule:${n}` : `hook:forge:${n}`)),
    });
    // Safety rules (no paths → always-on).
    writeFile(root, 'rules/prompt-defense-baseline.md', alwaysOnRule('prompt-defense-baseline'));
    writeFile(root, 'rules/security-baseline.md', alwaysOnRule('security-baseline'));
    // Safety hooks + a normal hook. Each hook injects a BLOCKED reason.
    for (const h of ['secret-scan', 'block-no-verify', 'config-protection']) {
      writeFile(
        root,
        `hooks/${h}.mjs`,
        ['#!/usr/bin/env node', `// ${h}`, 'const out = { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "BLOCKED: safety." } };', 'process.stdout.write(JSON.stringify(out));', ''].join('\n'),
      );
    }
    writeJson(root, 'hooks/hooks.json', {
      hooks: {
        PreToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node x' }], description: 'flag secrets', id: 'forge:secret-scan' },
          { matcher: '*', hooks: [{ type: 'command', command: 'node y' }], description: 'block --no-verify', id: 'forge:block-no-verify' },
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'node z' }], description: 'protect config', id: 'forge:config-protection' },
        ],
      },
    });
    writeJson(root, 'manifests/modules.json', {
      version: 1,
      modules: {
        security: { components: { rules: ['prompt-defense-baseline', 'security-baseline'], hooks: ['secret-scan', 'block-no-verify', 'config-protection'] } },
      },
    });
    writeJson(root, 'manifests/profiles.json', { version: 1, defaultProfile: 'generic', profiles: { generic: { modules: ['security'] } } });

    // A synthetic 0-fire telemetry window that is ADEQUATE (sessions=50, windowDays=30
    // — so the adequacy gate would NOT shield secret-scan; only the lock can).
    writeJson(root, '.forge/telemetry.json', {
      available: true,
      sessions: 50,
      windowDays: 30,
      events: [], // ZERO fires for every artifact, including secret-scan
    });

    // analyze: the lock must hold at the data layer.
    const report = await analyzeVia(root);
    assert.ok(report, 'manager/efficiency.mjs analyze must be built');
    const data = report.data;

    /** Every dead/waste/prune surface a report can carry. */
    const deadSurfaces = []
      .concat(deadStaticOf(data))
      .concat(Array.isArray(data.deadDynamic) ? data.deadDynamic : [])
      .concat(Array.isArray(data.waste) ? data.waste : [])
      .concat(Array.isArray(data.pruneCandidates) ? data.pruneCandidates : []);

    const safetyUids = new Set([
      'hook:forge:secret-scan',
      'hook:forge:block-no-verify',
      'hook:forge:config-protection',
      'rule:prompt-defense-baseline',
      'rule:security-baseline',
    ]);
    for (const entry of deadSurfaces) {
      assert.ok(
        !(entry && typeof entry.uid === 'string' && safetyUids.has(entry.uid)),
        `no safety artifact appears in any dead/waste/prune surface (offender: ${entry && entry.uid})`,
      );
    }

    // secret-scan (and the others) appear ONLY under "low-activity safety (expected)",
    // with the success framing ("0 fires = no secrets leaked").
    const lowActivity = Array.isArray(data.lowActivitySafety) ? data.lowActivitySafety : [];
    const ss = lowActivity.find((x) => x && x.uid === 'hook:forge:secret-scan');
    assert.ok(ss, 'secret-scan appears under lowActivitySafety');
    assert.strictEqual(ss.fires, 0, 'secret-scan fires = 0');
    assert.match(
      String(ss.note || ss.framing || ''),
      /no secrets leaked|working|expected|success/i,
      'secret-scan carries the success framing (0 fires = no secrets leaked = working)',
    );
    for (const uid of safetyUids) {
      assert.ok(lowActivity.some((x) => x && x.uid === uid), `${uid} is surfaced as low-activity safety, not waste`);
    }

    // optimize --emit-plan: the structured plan must contain NO safety recommendation.
    const planDir = path.join(root, '.forge');
    const mod = await tryImport(EFFICIENCY_MODULE);
    const run = resolveRun(mod);
    assert.ok(run, 'manager/efficiency.mjs run() must be built for optimize');
    let planRes = null;
    try {
      planRes = await run('optimize', ['--emit-plan'], { FORGE_ROOT: root, root, cwd: root });
    } catch {
      planRes = null;
    }
    assert.ok(planRes, 'optimize --emit-plan returns a result');
    // Read the structured plan from whichever surface it exposes: the returned data
    // or the emitted optimize.plan.json.
    let plan = planRes && planRes.data && typeof planRes.data === 'object' ? planRes.data : null;
    const planFile = path.join(planDir, 'optimize.plan.json');
    if (fs.existsSync(planFile)) {
      try {
        plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      } catch {
        /* keep the in-memory plan */
      }
    }
    assert.ok(plan, 'optimize produced a structured plan (returned or optimize.plan.json)');
    const recs = Array.isArray(plan.recommendations) ? plan.recommendations : [];
    for (const r of recs) {
      assert.ok(
        !(r && typeof r.uid === 'string' && safetyUids.has(r.uid)),
        `optimize.plan.json carries NO safety recommendation (offender: ${r && r.uid})`,
      );
      assert.notStrictEqual(r && r.safetyLocked, true, 'no recommendation is safetyLocked:true');
    }
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// EVAL-EFF-007 — thin window downgrades a never-fired normal artifact to watch,
// not prune (BR-EFF-008). Phase v0.3. Grader: code, pass^k=1.00.
// ===========================================================================
test('EVAL-EFF-007 — thin window downgrades never-fired normal to watch, not prune', async () => {
  const base = mkSandbox('eff007');
  try {
    // A normal rule that never fired + a planted STATIC orphan (D2: agent in no module).
    writeFile(base, 'rules/quiet-normal.md', alwaysOnRule('quiet-normal'));
    writeFile(base, 'agents/static-orphan.md', ['---', 'name: static-orphan', 'description: in no module (D2).', '---', '# Orphan', ''].join('\n'));
    writeJson(base, 'manifests/modules.json', { version: 1, modules: { 'rules-common': { components: { rules: ['quiet-normal'] } } } });
    writeJson(base, 'manifests/profiles.json', { version: 1, defaultProfile: 'generic', profiles: { generic: { modules: ['rules-common'] } } });

    /** Verdict for the never-fired normal rule from a report. */
    const verdictFor = (data, uid) => {
      const surfaces = []
        .concat(Array.isArray(data.deadDynamic) ? data.deadDynamic : [])
        .concat(Array.isArray(data.pruneCandidates) ? data.pruneCandidates : [])
        .concat(Array.isArray(data.watch) ? data.watch : []);
      const hit = surfaces.find((e) => e && e.uid === uid);
      return hit ? hit.verdict || (Array.isArray(data.watch) && data.watch.includes(hit) ? 'watch' : hit.verdict) : null;
    };

    // (1) Thin window: sessions=3 (< MIN_SESSIONS=20) → verdict `watch`, NOT `prune`.
    writeJson(base, '.forge/telemetry.json', { available: true, sessions: 3, windowDays: 30, events: [] });
    const thin = await analyzeVia(base);
    assert.ok(thin, 'manager/efficiency.mjs analyze must be built');
    const thinVerdict = verdictFor(thin.data, 'rule:quiet-normal');
    assert.strictEqual(thinVerdict, 'watch', 'never-fired normal in a thin window is `watch`, not `prune`');
    // The never-fired normal is NOT a prune candidate in the thin window.
    const thinPrune = Array.isArray(thin.data.pruneCandidates) ? thin.data.pruneCandidates : [];
    assert.ok(!thinPrune.some((e) => e && e.uid === 'rule:quiet-normal'), 'thin-window normal is not a prune candidate');

    // The planted STATIC orphan (D2) IS still recommended (static checks are exempt
    // from the adequacy gate).
    const d2 = deadStaticOf(thin.data).find((d) => d && d.checkId === 'D2' && d.uid === 'agent:static-orphan');
    assert.ok(d2, 'static orphan (D2) is still reported under a thin telemetry window');
    assert.notStrictEqual(d2.recommend, false, 'static orphan is still recommended (exempt from the adequacy gate)');

    // (2) Raise to sessions=50 → the SAME artifact flips to prune-eligible dynamic-dead.
    writeJson(base, '.forge/telemetry.json', { available: true, sessions: 50, windowDays: 30, events: [] });
    const adequate = await analyzeVia(base);
    assert.ok(adequate, 'analyze re-runs on the adequate window');
    const adequateVerdict = verdictFor(adequate.data, 'rule:quiet-normal');
    assert.notStrictEqual(adequateVerdict, 'watch', 'with sessions=50 the verdict is no longer downgraded to watch');
    assert.strictEqual(adequateVerdict, 'prune', 'adequate window flips the never-fired normal to a prune-eligible dynamic-dead');
  } finally {
    cleanup(base);
  }
});

// ===========================================================================
// EVAL-EFF-009 — analyze degrades to static-only when telemetry is off/empty
// (BR-EFF-005). Phase v0.3. Grader: code, pass^k=1.00.
// ===========================================================================
test('EVAL-EFF-009 — analyze degrades to static-only when telemetry is off/empty', async () => {
  const root = mkSandbox('eff009');
  try {
    // A harness with telemetry OFF (no telemetry file) + a planted static orphan so
    // the static half has something to report.
    writeFile(root, 'rules/always.md', alwaysOnRule('always'));
    writeFile(root, 'agents/orphan.md', ['---', 'name: orphan', 'description: in no module.', '---', '# Orphan', ''].join('\n'));
    writeJson(root, 'manifests/modules.json', { version: 1, modules: { 'rules-common': { components: { rules: ['always'] } } } });
    writeJson(root, 'manifests/profiles.json', { version: 1, defaultProfile: 'generic', profiles: { generic: { modules: ['rules-common'] } } });
    // NO .forge/telemetry.json → telemetry off.

    const report = await analyzeVia(root);
    assert.ok(report, 'manager/efficiency.mjs analyze must be built');
    const data = report.data;

    // It returns D1–D5 static results (here at least the D2 orphan agent).
    assert.ok(deadStaticOf(data).some((d) => d && d.checkId === 'D2' && d.uid === 'agent:orphan'), 'static D2 still reported with telemetry off');

    // telemetry.available is false — degraded, not "everything alive".
    assert.ok(data.telemetry && typeof data.telemetry === 'object', 'report carries a telemetry block');
    assert.strictEqual(data.telemetry.available, false, 'telemetry.available is false when telemetry is off');

    // An empty deadDynamic MUST be accompanied by telemetry.available:false, never
    // presented as "all alive": no U1–U4 verdicts are emitted.
    const deadDynamic = Array.isArray(data.deadDynamic) ? data.deadDynamic : [];
    assert.deepStrictEqual(deadDynamic, [], 'no U1–U4 dynamic verdicts when telemetry is off');

    // A clear "dynamic unavailable (telemetry off)" notice is present.
    const notices = []
      .concat(Array.isArray(data.notices) ? data.notices : [])
      .concat(typeof data.notice === 'string' ? [data.notice] : []);
    const noticeText = notices.join(' ');
    assert.match(
      noticeText,
      /telemetry off|dynamic.*unavailable|unavailable.*telemetry/i,
      'analyze states "dynamic checks unavailable (telemetry off)"',
    );

    // It exits successfully (fail-open): ok is truthy.
    assert.ok(report.ok, 'analyze exits successfully (fail-open) with telemetry off');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// DEFERRED v0.6 — DYNAMIC / value-density cases. RED placeholders ONLY; NOT part
// of the v0.3 gate. Skipped from execution (with a deferral reason) so they neither
// pass-by-accident nor crash the runner. They are authored as RED so that when the
// v0.6 slice lands, the `skip` is removed and the assertions become live.
// ===========================================================================
const DEFER = 'v0.6 DYNAMIC/value-density — DEFERRED per SPEC-06 (not in the v0.3 gate)';

test('EVAL-EFF-008 — unknown effectiveness routes to needs-eval (U ≠ 0), never prune [DEFERRED v0.6]', { skip: DEFER }, async () => {
  // Given a `normal` artifact with grade U / coverage 0 and a high estimated costTok,
  // its value-density is `null` (not 0), it routes to needs-eval, and it is NOT a
  // prune-candidate; an otherwise-identical artifact with a real low effScore IS.
  const mod = await tryImport(EFFICIENCY_MODULE);
  assert.ok(mod, 'efficiency module (value-density) — v0.6');
});

test('EVAL-EFF-010 — dynamic dead-detection (U1) flags reachable-but-never-fired normal [DEFERRED v0.6]', { skip: DEFER }, async () => {
  // Adequate window, a never-cited normal rule is U1; a safety hook in the same
  // 0-event state is NOT (lock holds inside the dynamic path); an active rule is not flagged.
  const mod = await tryImport(EFFICIENCY_MODULE);
  assert.ok(mod, 'efficiency module (dynamic dead U1) — v0.6');
});

test('EVAL-EFF-011 — redundancy flags near-dupes, de-flags intentional layering [DEFERRED v0.6]', { skip: DEFER }, async () => {
  // Near-duplicate pair flagged `strong` (body k=5, J≥0.6); security-baseline /
  // common/security pair carries the layering de-flag hint, not a prune-worthy redundancy.
  const mod = await tryImport(EFFICIENCY_MODULE);
  assert.ok(mod, 'efficiency module (redundancy/layering) — v0.6');
});

test('EVAL-EFF-012 — value-density quadrants; safety forced keeper [DEFERRED v0.6]', { skip: DEFER }, async () => {
  // High-eff/low-cost → keeper; low-eff/high-cost normal → prune-candidate; poor-ratio
  // safety → forced keeper; report labels value-density low-confidence.
  const mod = await tryImport(EFFICIENCY_MODULE);
  assert.ok(mod, 'efficiency module (value-density quadrants) — v0.6');
});

test('EVAL-EFF-013 — forge optimize is a dry-run plan that writes only optimize.plan.json [DEFERRED v0.6]', { skip: DEFER }, async () => {
  // optimize --emit-plan deletes/modifies nothing on disk; the only write is
  // optimize.plan.json; each rec carries {check-id,confidence,recoverableTokens,
  // evidence,safetyLocked:false}; safety/compliance appear only in "considered & excluded".
  const mod = await tryImport(EFFICIENCY_MODULE);
  assert.ok(mod, 'efficiency module (optimize dry-run plan) — v0.6');
});
