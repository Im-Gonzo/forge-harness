#!/usr/bin/env node
/**
 * forge/eval/delta-runner.mjs — scaffolding-delta eval runner.
 *
 * Measures what each forge scaffold PAYS FOR on each model: every case runs with its
 * scaffold ON vs OFF (composed fixture variants), k trials per cell, via headless
 * `claude -p`, code-graded. Deterministic collection (docs/METHOD.md §7); resumable
 * (completed cells skip); evidence-before-claims (every record carries cost + duration
 * + transcript path).
 *
 * Usage:
 *   node delta-runner.mjs --plan                    # show the cell plan + cost estimate
 *   node delta-runner.mjs --smoke                   # cases[0] × on/off × smokeModel × k=1
 *   node delta-runner.mjs --yes                     # run the full matrix
 *   node delta-runner.mjs --cases a,b --models haiku,fable --k 1 --yes
 *   node delta-runner.mjs --report                  # aggregate results.jsonl -> summary
 *   node delta-runner.mjs --compose-only <case> <variant> <dest>   # debug: compose a fixture
 *
 * Flags: --keep-failures  --force (re-run completed cells)  --run-id <id>  --matrix <path>
 *
 * Zero-dep, Node 18+.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results');
const RESULTS_FILE = path.join(RESULTS_DIR, 'results.jsonl');

// ---------------------------------------------------------------- args / config

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--plan' || t === '--smoke' || t === '--yes' || t === '--report' ||
        t === '--force' || t === '--keep-failures' || t === '--compose-only') {
      a[t.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    } else if (t === '--cases' || t === '--models' || t === '--variants') {
      a[t.slice(2)] = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (t === '--k') {
      a.k = Number(argv[++i]);
    } else if (t === '--matrix' || t === '--run-id') {
      a[t.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else {
      a._.push(t);
    }
  }
  return a;
}

function loadMatrix(p) {
  const file = p ? path.resolve(p) : path.join(HERE, 'matrix.json');
  return { ...JSON.parse(fs.readFileSync(file, 'utf8')), _path: file };
}

// ---------------------------------------------------------------- case loading

function loadCase(name) {
  const dir = path.join(HERE, 'cases', name);
  const md = fs.readFileSync(path.join(dir, 'case.md'), 'utf8');
  const fm = {};
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  const taskMatch = md.match(/\n## Task\n([\s\S]*?)(?:\n## |$)/);
  if (!taskMatch) throw new Error(`case ${name}: no "## Task" section in case.md`);
  // `fixture:` frontmatter selects the base fixture under fixture/<name> (default 'base').
  // Round-1 cases omit the key and resolve to fixture/base unchanged.
  const fixture = fm.fixture || 'base';
  return { name, dir, frontmatter: fm, task: taskMatch[1].trim(), fixture };
}

// ---------------------------------------------------------------- fixture composition

/**
 * Recursively copy src into dest, substituting {{FORGE_ROOT}} in text files.
 * `_claude/` dirs are materialized as `.claude/` — overlays are stored under the
 * placeholder name so the eval tree never contains live agent config (and so the
 * fixture's settings/hooks can't be picked up when working inside forge/ itself).
 */
function overlay(src, dest) {
  if (!fs.existsSync(src)) return;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name === '_claude' ? '.claude' : entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      overlay(s, d);
    } else {
      const raw = fs.readFileSync(s);
      const text = raw.toString('utf8');
      if (text.includes('{{FORGE_ROOT}}')) {
        fs.writeFileSync(d, text.replaceAll('{{FORGE_ROOT}}', FORGE_ROOT));
      } else {
        fs.writeFileSync(d, raw);
      }
    }
  }
}

/** Compose base fixture + case common/ + case <variant>/ into destDir; git-init it. */
async function composeFixture(caseName, variant, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const fixture = loadCase(caseName).fixture; // 'base' unless the case sets fixture:
  overlay(path.join(HERE, 'fixture', fixture), destDir);
  overlay(path.join(HERE, 'cases', caseName, 'common'), destDir);
  overlay(path.join(HERE, 'cases', caseName, variant), destDir);
  // a git repo so the subject can diff/commit and graders can fingerprint
  try {
    await sh('git', ['init', '-q'], destDir);
    await sh('git', ['add', '-A'], destDir);
    await sh('git', ['-c', 'user.email=eval@forge', '-c', 'user.name=forge-eval',
      'commit', '-qm', 'fixture baseline'], destDir);
  } catch {
    // git unavailable: proceed without isolation fingerprint (recorded in trial row)
  }
}

// ---------------------------------------------------------------- subprocess helpers

function sh(bin, args, cwd, { timeoutMs = 120000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout: ${bin}`)); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** Env hygiene: a nested `claude` must not inherit session/model overrides. */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|MCP_)/.test(k)) delete env[k];
  }
  return env;
}

/** Run one headless claude trial; stream stdout to transcriptPath; parse the result event. */
function runClaude(matrix, modelId, task, cwd, transcriptPath) {
  const args = ['-p', task, '--model', modelId, '--output-format', 'stream-json', '--verbose',
    ...(matrix.claude.args ?? [])];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(matrix.claude.bin ?? 'claude', args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(transcriptPath);
    let err = '', resultEvent = null, buf = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), matrix.claude.timeoutMs ?? 600000);
    child.stdout.on('data', (d) => {
      out.write(d);
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result') resultEvent = ev;
        } catch { /* non-JSON line */ }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer); out.end();
      resolve({ ok: false, error: `spawn failed: ${e.message}`, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer); out.end();
      resolve({
        ok: code === 0 && resultEvent && !resultEvent.is_error,
        exitCode: code,
        costUSD: resultEvent?.total_cost_usd ?? null,
        durationMs: Date.now() - started,
        error: code !== 0 ? (err.slice(-2000) || `exit ${code}`) : null,
      });
    });
  });
}

/** Run the case's grader: exit 0 = PASS. Last stdout JSON line = {pass, reasons}. */
async function grade(caseName, trialDir, transcriptPath) {
  const grader = path.join(HERE, 'cases', caseName, 'grader.mjs');
  try {
    const { code, out } = await sh('node', [grader, trialDir, transcriptPath], HERE, { timeoutMs: 120000 });
    const lines = out.trim().split('\n').filter(Boolean);
    let verdict = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try { verdict = JSON.parse(lines[i]); break; } catch { /* keep looking */ }
    }
    return { pass: code === 0, reasons: verdict?.reasons ?? [out.slice(-500)] };
  } catch (e) {
    return { pass: false, reasons: [`grader error: ${e.message}`] };
  }
}

// ---------------------------------------------------------------- cells / results

function buildCells(matrix, opts) {
  const cases = opts.cases ?? matrix.cases;
  const models = opts.models ?? Object.keys(matrix.models);
  const variants = opts.variants ?? matrix.variants ?? ['on', 'off'];
  const k = opts.k ?? matrix.k ?? 3;
  const cells = [];
  for (const c of cases) for (const m of models) for (const v of variants) {
    cells.push({ case: c, model: m, modelId: matrix.models[m], variant: v, k });
  }
  return cells;
}

function loadResults() {
  if (!fs.existsSync(RESULTS_FILE)) return [];
  return fs.readFileSync(RESULTS_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const cellKey = (r) => `${r.case}|${r.variant}|${r.model}`;

// ---------------------------------------------------------------- main modes

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const matrix = loadMatrix(opts.matrix);

  if (opts.composeOnly) {
    const [c, v, dest] = opts._;
    if (!c || !v || !dest) { console.error('usage: --compose-only <case> <variant> <dest>'); process.exit(2); }
    await composeFixture(c, v, path.resolve(dest));
    console.log(`composed ${c}/${v} -> ${dest}`);
    return;
  }

  if (opts.report) return report(matrix);

  if (opts.smoke) {
    opts.cases = [matrix.cases[0]];
    opts.models = [matrix.smokeModel ?? Object.keys(matrix.models)[0]];
    opts.k = 1;
    opts.yes = true;
  }

  const cells = buildCells(matrix, opts);
  const done = loadResults();
  const doneCount = new Map();
  for (const r of done) doneCount.set(cellKey(r), (doneCount.get(cellKey(r)) ?? 0) + 1);

  const pending = [];
  for (const cell of cells) {
    const have = opts.force ? 0 : (doneCount.get(cellKey(cell)) ?? 0);
    for (let t = have; t < cell.k; t++) pending.push({ ...cell, trial: t + 1 });
  }

  const est = (pending.length * (matrix.estCostPerTrialUSD ?? 0.5)).toFixed(2);
  console.log(`plan: ${cells.length} cells, ${pending.length} pending trials, est ~$${est} (cap $${matrix.maxCostUSD})`);
  for (const c of cells) {
    console.log(`  ${c.case} × ${c.variant} × ${c.model} (k=${c.k}, have ${doneCount.get(cellKey(c)) ?? 0})`);
  }
  if (opts.plan) return;
  if (!opts.yes && pending.length > (matrix.confirmThresholdTrials ?? 8)) {
    console.error(`\n${pending.length} trials > confirm threshold — re-run with --yes to proceed.`);
    process.exit(2);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const gi = path.join(RESULTS_DIR, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n!.gitignore\n!summary.md\n');

  const runId = opts.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  let spent = done.reduce((s, r) => s + (r.costUSD ?? 0), 0);

  for (const [i, trial] of pending.entries()) {
    if (spent >= matrix.maxCostUSD) {
      console.error(`cost cap $${matrix.maxCostUSD} reached (spent $${spent.toFixed(2)}) — stopping. Resume later; completed trials are kept.`);
      break;
    }
    const tag = `${trial.case}.${trial.variant}.${trial.model}.t${trial.trial}`;
    const caseDef = loadCase(trial.case);
    const trialDir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-delta-${tag}-`));
    const transcript = path.join(RESULTS_DIR, `${runId}.${tag}.transcript.jsonl`);
    process.stdout.write(`[${i + 1}/${pending.length}] ${tag} ... `);

    await composeFixture(trial.case, trial.variant, trialDir);
    const run = await runClaude(matrix, trial.modelId, caseDef.task, trialDir, transcript);
    const verdict = run.ok || run.exitCode === 0
      ? await grade(trial.case, trialDir, transcript)
      : { pass: false, reasons: [run.error ?? 'claude run failed'] };

    spent += run.costUSD ?? 0;
    const row = {
      runId, ts: new Date().toISOString(),
      case: trial.case, variant: trial.variant, model: trial.model, modelId: trial.modelId,
      trial: trial.trial, pass: verdict.pass, reasons: verdict.reasons,
      costUSD: run.costUSD, durationMs: run.durationMs,
      transcript: path.relative(HERE, transcript), error: run.error ?? null,
    };
    fs.appendFileSync(RESULTS_FILE, JSON.stringify(row) + '\n');
    console.log(`${verdict.pass ? 'PASS' : 'FAIL'} (${(run.durationMs / 1000).toFixed(0)}s, $${(run.costUSD ?? 0).toFixed(3)})`);

    if (verdict.pass || !opts.keepFailures) fs.rmSync(trialDir, { recursive: true, force: true });
    else console.log(`    kept failing tree: ${trialDir}`);
  }

  report(matrix);
}

// ---------------------------------------------------------------- report

function rate(rows) {
  if (!rows.length) return null;
  return rows.filter((r) => r.pass).length / rows.length;
}

function report(matrix) {
  const rows = loadResults();
  if (!rows.length) { console.log('no results yet'); return; }
  const models = Object.keys(matrix.models);
  const cases = [...new Set(rows.map((r) => r.case))];
  const lines = [];
  lines.push(`# Scaffolding-delta report (${new Date().toISOString()})`);
  lines.push('');
  lines.push(`Total trials: ${rows.length} · total cost: $${rows.reduce((s, r) => s + (r.costUSD ?? 0), 0).toFixed(2)}`);
  lines.push('');
  lines.push('| case | model | pass(ON) | pass(OFF) | delta | n(on/off) |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of cases) {
    for (const m of models) {
      const on = rows.filter((r) => r.case === c && r.model === m && r.variant === 'on');
      const off = rows.filter((r) => r.case === c && r.model === m && r.variant === 'off');
      if (!on.length && !off.length) continue;
      const rOn = rate(on), rOff = rate(off);
      const delta = rOn != null && rOff != null ? (rOn - rOff).toFixed(2) : '—';
      lines.push(`| ${c} | ${m} | ${rOn?.toFixed(2) ?? '—'} | ${rOff?.toFixed(2) ?? '—'} | ${delta} | ${on.length}/${off.length} |`);
    }
  }
  lines.push('');
  lines.push('> delta = pass-rate(scaffold ON) − pass-rate(scaffold OFF). delta ≈ 0 on a model ⇒ the scaffold buys nothing there (candidate to tier off). Negative delta ⇒ the scaffold actively hurts that model.');
  const text = lines.join('\n');
  console.log('\n' + text);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'summary.md'), text + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
