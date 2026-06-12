#!/usr/bin/env node
/**
 * Forge — stop-typecheck (Stop)
 *
 * PROJECT-GATED hook (METHOD.md §9 "Stop-typecheck"). No-op unless the project is a
 * Forge-tailored harness — i.e. `<projectDir>/.claude/.forge.json` exists. In a
 * tailored project, once per turn at Stop it runs the project's typecheck command
 * (mypy / tsc / etc.) a SINGLE time and surfaces any failure to the agent, so a
 * "done" claim is backed by a fresh check (evidence-before-claims, METHOD.md §4).
 *
 * The typecheck command is resolved, in order:
 *   1. `.claude/.forge.json`            → `commands.typecheck` / `commands.fe_typecheck` /
 *                                         `commands.be_typecheck` (if present)
 *   2. `.claude/profile-project.json`   → same `commands.*` keys (the profiler output)
 *   3. lightweight detection from on-disk signals (tsconfig.json → tsc; mypy/ruff
 *      config or pyproject → mypy). If none resolve, NO-OP.
 *
 * This Stop hook NEVER blocks (Stop has no deny mechanism). It reports failures on
 * stderr and ALWAYS exits 0. It is a reporting gate, not a hard gate.
 *
 * Batched-Stop pattern adapted from an earlier stop-format-typecheck hook
 * (run once, proportional budget) to zero-dependency
 * Node ESM, driven by the project's recorded command rather than an edit accumulator.
 *
 * HOOK CONTRACT (METHOD.md §9 — fail-open):
 *   - Reads the Claude Code Stop hook payload as JSON on stdin (best-effort).
 *   - FAILS OPEN: any parse/IO/spawn error → log `[forge:stop-typecheck]` to stderr,
 *     exit 0.
 *
 * Conventions: Node ESM, single file, ZERO dependencies (only node: builtins).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { emit } from './lib/telemetry.mjs';

const HOOK = 'stop-typecheck';
const MAX_STDIN = 1024 * 1024;
const TIMEOUT_MS = 240_000; // stay under the Stop wall-clock budget

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.length > MAX_STDIN ? raw.slice(0, MAX_STDIN) : raw;
  } catch {
    return '';
  }
}

function parseInput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return {};
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Project resolution
// ---------------------------------------------------------------------------

function resolveProjectDir(input) {
  for (const key of ['cwd', 'project_dir', 'projectDir', 'workspace']) {
    const v = input && input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const envDir = process.env.CLAUDE_PROJECT_DIR;
  if (typeof envDir === 'string' && envDir.trim()) return envDir.trim();
  return process.cwd();
}

/** Pull a typecheck command out of a `commands` object, if any. */
function pickTypecheck(commands) {
  if (!commands || typeof commands !== 'object') return [];
  const out = [];
  for (const k of ['typecheck', 'be_typecheck', 'fe_typecheck']) {
    const v = commands[k];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  // Dedup while preserving order.
  return Array.from(new Set(out));
}

/**
 * Resolve the typecheck command(s) for this project.
 * Returns { commands: string[], source: string } — commands may be empty (=no-op).
 */
function resolveTypecheckCommands(projectDir) {
  const claudeDir = join(projectDir, '.claude');

  // 1. .forge.json (marker may carry commands in tailored harnesses)
  const marker = readJson(join(claudeDir, '.forge.json'));
  if (marker) {
    const fromMarker = pickTypecheck(marker.commands);
    if (fromMarker.length) return { commands: fromMarker, source: '.claude/.forge.json' };
  }

  // 2. profile-project.json (the profiler's recorded real invocations)
  const profile = readJson(join(claudeDir, 'profile-project.json'));
  if (profile) {
    const fromProfile = pickTypecheck(profile.commands);
    if (fromProfile.length) return { commands: fromProfile, source: '.claude/profile-project.json' };
  }

  // 3. Lightweight detection.
  const detected = detectTypecheck(projectDir);
  if (detected.length) return { commands: detected, source: 'detected' };

  return { commands: [], source: 'none' };
}

/** Best-effort detection from on-disk signals. Conservative — prefer no-op over wrong. */
function detectTypecheck(projectDir) {
  const cmds = [];

  // TypeScript: a tsconfig.json present → tsc --noEmit via the project's pkg manager.
  if (existsSync(join(projectDir, 'tsconfig.json'))) {
    const tsc = tsTypecheckCommand(projectDir);
    if (tsc) cmds.push(tsc);
  }

  // Python: a standalone mypy config or pyproject with [tool.mypy].
  if (
    existsSync(join(projectDir, 'mypy.ini')) ||
    existsSync(join(projectDir, '.mypy.ini')) ||
    hasMypyInPyproject(projectDir)
  ) {
    cmds.push(pyTypecheckCommand(projectDir));
  }

  return Array.from(new Set(cmds.filter(Boolean)));
}

function tsTypecheckCommand(projectDir) {
  // Prefer a `typecheck` script if package.json defines one.
  const pkg = readJson(join(projectDir, 'package.json'));
  const pm = detectNodePM(projectDir);
  if (pkg && pkg.scripts && typeof pkg.scripts.typecheck === 'string') {
    return `${pm} run typecheck`;
  }
  // Otherwise call tsc directly via the package runner.
  const runner = pm === 'npm' ? 'npx' : pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bunx' : 'npx';
  return `${runner} tsc --noEmit`;
}

function pyTypecheckCommand(projectDir) {
  if (existsSync(join(projectDir, 'uv.lock'))) return 'uv run mypy .';
  if (existsSync(join(projectDir, 'poetry.lock'))) return 'poetry run mypy .';
  return 'mypy .';
}

function detectNodePM(projectDir) {
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectDir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(projectDir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function hasMypyInPyproject(projectDir) {
  const p = join(projectDir, 'pyproject.toml');
  if (!existsSync(p)) return false;
  try {
    return /\[tool\.mypy\]/.test(readFileSync(p, 'utf8'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Run one shell command in projectDir. Returns { ok, status, output }. */
function runCommand(command, projectDir, budgetMs) {
  // Run through the shell so the project's recorded command string (which may
  // include pipes/flags/sub-runners) executes verbatim.
  const res = spawnSync(command, {
    cwd: projectDir,
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: budgetMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error) {
    // Spawn failed (not found / timeout) — fail open, don't claim a typecheck failure.
    return { ok: true, status: null, output: '', skipped: true, err: res.error };
  }
  const status = typeof res.status === 'number' ? res.status : 1;
  return { ok: status === 0, status, output: `${res.stdout || ''}${res.stderr || ''}` };
}

/**
 * Emit one `typecheck.run` telemetry event (additive, fail-open). Records only
 * duration/exit_code/fail_count — never the typecheck output (BR-TEL-006/008/009).
 * @param {any} input the Stop payload (for session/project context)
 * @param {string} projectDir
 * @param {{decision:string, durationMs:number, exitCode:number|null, failCount:number}} r
 */
function emitTypecheck(input, projectDir, r) {
  emit({
    event_type: 'typecheck.run',
    tool: null,
    rule: HOOK,
    decision: r.decision,
    session_id: input && (input.session_id || input.sessionId),
    project: projectDir,
    duration_ms: r.durationMs,
    payload: { duration_ms: r.durationMs, exit_code: r.exitCode, fail_count: r.failCount },
  });
}

function main() {
  const input = parseInput(readStdin());
  const projectDir = resolve(resolveProjectDir(input));

  // PROJECT GATE: only enforce in a Forge-tailored project.
  if (!existsSync(join(projectDir, '.claude', '.forge.json'))) return; // no-op

  const { commands, source } = resolveTypecheckCommands(projectDir);
  if (commands.length === 0) {
    // No typecheck command resolved → no-op (do not block the Stop). Record a
    // 'skip' so the rollup can distinguish "ran, no command" from "never fired".
    emitTypecheck(input, projectDir, { decision: 'skip', durationMs: 0, exitCode: null, failCount: 0 });
    return;
  }

  const budget = Math.floor(TIMEOUT_MS / commands.length);
  const failures = [];
  let ran = 0;
  let lastStatus = 0;
  const t0 = Date.now();

  for (const command of commands) {
    const r = runCommand(command, projectDir, budget);
    if (r.skipped) {
      process.stderr.write(
        `[forge:${HOOK}] could not run typecheck '${command}' (${r.err && r.err.message ? r.err.message : 'unavailable'}); skipping\n`
      );
      continue;
    }
    ran++;
    if (typeof r.status === 'number') lastStatus = r.status;
    if (!r.ok) {
      const tail = String(r.output || '').trim().split('\n').slice(-40).join('\n');
      failures.push({ command, status: r.status, tail });
    }
  }

  // POST-DECISION telemetry (additive, fail-open). Real measured wall-clock
  // duration (BR-TEL-009). 'skip' when every command was unavailable; else
  // pass/fail. exit_code is the last command's status; no raw output is stored.
  const durationMs = Date.now() - t0;
  emitTypecheck(input, projectDir, {
    decision: ran === 0 ? 'skip' : failures.length > 0 ? 'fail' : 'pass',
    durationMs,
    exitCode: ran === 0 ? null : failures.length > 0 ? lastStatus : 0,
    failCount: failures.length,
  });

  if (failures.length > 0) {
    process.stderr.write(
      `[forge:${HOOK}] typecheck FAILED (source: ${source}). ` +
        `Do not claim the work is done until this passes:\n`
    );
    for (const f of failures) {
      process.stderr.write(`\n  $ ${f.command}  (exit ${f.status})\n`);
      if (f.tail) {
        for (const line of f.tail.split('\n')) process.stderr.write(`  ${line}\n`);
      }
    }
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `[forge:${HOOK}] error (continuing): ${err && err.message ? err.message : err}\n`
  );
}

// Stop hooks never block: always exit 0.
process.exit(0);
