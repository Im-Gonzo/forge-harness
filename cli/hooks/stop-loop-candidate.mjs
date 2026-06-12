#!/usr/bin/env node
/**
 * Forge — stop-loop-candidate (Stop)
 *
 * PROJECT-GATED hook (LOOPS-MODULE-DESIGN.md D6). No-op unless the project is a
 * Forge-tailored harness — i.e. `<projectDir>/.claude/.forge.json` exists. In a
 * tailored project, once per turn at Stop it reads the turn's transcript, scans the
 * Bash commands the agent hand-ran, and — if the SAME gate-shaped command family
 * (test / lint / typecheck / build: npm test, pytest, tsc, mypy, ruff, eslint,
 * cargo test, go test, make test, …) ran >= 3 times this turn — emits ONE advisory
 * stderr line steering the agent to codify the ratchet (the rule-of-three from
 * loop-discipline.md). It is the Stop-side mirror of loop-gate's PreToolUse steer.
 *
 * This Stop hook NEVER blocks (Stop has no deny mechanism). It reports on stderr and
 * ALWAYS exits 0. Once per turn (a single Stop fires once). No state across turns —
 * the count is recomputed from the visible transcript tail each time (turn boundaries are
 * not reliably delimited in the JSONL, so repetitions accumulate session-wide — which
 * matches the rule-of-three intent in loop-discipline.md).
 *
 * HOOK CONTRACT (mirrors hooks/stop-typecheck.mjs — fail-open):
 *   - Reads the Claude Code Stop hook payload as JSON on stdin (best-effort). The
 *     payload carries `transcript_path` (a JSONL file, one transcript event per line);
 *     the turn's tool_use entries are read from there.
 *   - FAILS OPEN: any parse/IO error → log `[forge:stop-loop-candidate]` to stderr,
 *     exit 0. No transcript / no tool_use → silent no-op.
 *
 * Conventions: Node ESM, single file, ZERO dependencies (only node: builtins).
 *
 * NOTE: registered in hooks/hooks.json (forge:stop-loop-candidate). Advisory-only:
 * one stderr nudge per firing, never blocks, PROJECT-GATED.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HOOK = 'stop-loop-candidate';
const MAX_STDIN = 1024 * 1024;
const MAX_TRANSCRIPT = 16 * 1024 * 1024;
const RATCHET_THRESHOLD = 3; // rule of three (loop-discipline.md)

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

// ---------------------------------------------------------------------------
// Project resolution (mirrors stop-typecheck.mjs)
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

// ---------------------------------------------------------------------------
// Transcript reading
// ---------------------------------------------------------------------------

/** Resolve the transcript file from the Stop payload (several key spellings). */
function transcriptPath(input) {
  for (const key of ['transcript_path', 'transcriptPath', 'transcript']) {
    const v = input && input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Read the transcript JSONL and return every Bash tool_use command string seen this
 * turn. The Claude Code transcript is one JSON event per line; a tool_use lives inside
 * an assistant message's `content[]` as `{ type:'tool_use', name:'Bash', input:{ command } }`.
 * We walk defensively across the spellings the payload may use. Fail-open to [].
 */
function readTurnBashCommands(file) {
  let raw;
  try {
    if (!existsSync(file)) return [];
    if (statSync(file).size > MAX_TRANSCRIPT) {
      // Read only the tail to stay bounded; the current turn is at the end.
      const buf = readFileSync(file);
      raw = buf.slice(buf.length - MAX_TRANSCRIPT).toString('utf8');
    } else {
      raw = readFileSync(file, 'utf8');
    }
  } catch {
    return [];
  }

  const commands = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue; // partial/non-JSON line — skip
    }
    collectBashCommands(ev, commands);
  }
  return commands;
}

/** A tool_use node is Bash when its name/tool is 'Bash' (any case). */
function isBashToolUse(node) {
  if (!node || typeof node !== 'object') return false;
  const type = String(node.type || '').toLowerCase();
  if (type !== 'tool_use') return false;
  const name = String(node.name || node.tool_name || '').toLowerCase();
  return name === 'bash';
}

/** Pull the `command` string off a tool_use node's input (several spellings). */
function commandOf(node) {
  const input = node.input || node.tool_input || {};
  const cmd = input && typeof input.command === 'string' ? input.command : '';
  return cmd;
}

/**
 * Walk a transcript event and push any Bash tool_use command into `out`. Handles the
 * common shapes: a top-level tool_use event, or an assistant message whose
 * `message.content[]` (or `content[]`) holds tool_use blocks.
 */
function collectBashCommands(ev, out) {
  if (!ev || typeof ev !== 'object') return;

  // Direct tool_use event.
  if (isBashToolUse(ev)) {
    const c = commandOf(ev);
    if (c) out.push(c);
  }

  // Message-wrapped content blocks.
  const containers = [];
  if (ev.message && typeof ev.message === 'object') containers.push(ev.message);
  containers.push(ev);
  for (const c of containers) {
    const content = c && Array.isArray(c.content) ? c.content : null;
    if (!content) continue;
    for (const block of content) {
      if (isBashToolUse(block)) {
        const cmd = commandOf(block);
        if (cmd) out.push(cmd);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gate-shaped family normalization
// ---------------------------------------------------------------------------

/**
 * The gate-shaped command families a ratchet repeats (test / lint / typecheck /
 * build). Each entry is a matcher over a command's leading tokens that returns the
 * NORMALIZED family label (binary + first meaningful subcommand) when it matches.
 */
const FAMILY_MATCHERS = [
  // Node package-manager scripts: npm/pnpm/yarn/bun run? <test|lint|typecheck|build>
  (toks) => {
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(toks[0])) return null;
    const rest = toks.slice(1).filter((t) => t !== 'run');
    const sub = rest[0];
    if (['test', 'lint', 'typecheck', 'type-check', 'build'].includes(sub)) return `${toks[0]} ${sub}`;
    return null;
  },
  // npx/pnpm dlx/bunx <tsc|eslint|...>
  (toks) => {
    if (!['npx', 'bunx'].includes(toks[0])) return null;
    const sub = toks[1];
    if (['tsc', 'eslint', 'prettier', 'vitest', 'jest'].includes(sub)) return `${toks[0]} ${sub}`;
    return null;
  },
  // tsc / mypy / ruff / eslint / pytest / vitest / jest / pyright (bare or via a runner)
  (toks) => {
    const RUNNERS = new Set(['uv', 'poetry', 'pdm', 'pipenv', 'python', 'python3', 'rye']);
    let i = 0;
    while (i < toks.length && (RUNNERS.has(toks[i]) || toks[i] === 'run' || toks[i] === '-m')) i++;
    const bin = toks[i];
    const BINS = new Set(['tsc', 'mypy', 'ruff', 'eslint', 'pytest', 'vitest', 'jest', 'pyright', 'flake8', 'black']);
    if (BINS.has(bin)) return bin;
    return null;
  },
  // cargo test|check|clippy|build
  (toks) => {
    if (toks[0] !== 'cargo') return null;
    if (['test', 'check', 'clippy', 'build'].includes(toks[1])) return `cargo ${toks[1]}`;
    return null;
  },
  // go test|build|vet
  (toks) => {
    if (toks[0] !== 'go') return null;
    if (['test', 'build', 'vet'].includes(toks[1])) return `go ${toks[1]}`;
    return null;
  },
  // make <test|lint|build|check|typecheck>
  (toks) => {
    if (toks[0] !== 'make') return null;
    const sub = toks[1];
    if (['test', 'lint', 'build', 'check', 'typecheck'].includes(sub)) return `make ${sub}`;
    return null;
  },
];

/**
 * Normalize a raw command to its gate-shaped family label, or null if it is not a
 * recognized test/lint/typecheck/build ratchet. Strips a leading FORGE_LOOP=… or other
 * `VAR=val` env prefixes, then tokenizes the first segment (before any ; | && pipe).
 */
function normalizeFamily(command) {
  const firstSeg = String(command || '').split(/[;&|]/)[0].trim();
  if (!firstSeg) return null;
  let toks = firstSeg.split(/\s+/);
  // Drop leading `VAR=value` env assignments.
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1);
  if (toks.length === 0) return null;
  for (const matcher of FAMILY_MATCHERS) {
    const label = matcher(toks);
    if (label) return label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const input = parseInput(readStdin());
  const projectDir = resolve(resolveProjectDir(input));

  // PROJECT GATE: only act in a Forge-tailored project.
  if (!existsSync(join(projectDir, '.claude', '.forge.json'))) return; // no-op

  const tp = transcriptPath(input);
  if (!tp) return; // no transcript → nothing to scan

  const commands = readTurnBashCommands(tp);
  if (commands.length === 0) return;

  // Count gate-shaped families.
  const counts = new Map();
  for (const cmd of commands) {
    const fam = normalizeFamily(cmd);
    if (!fam) continue;
    counts.set(fam, (counts.get(fam) || 0) + 1);
  }

  // Find the most-repeated family at or over the rule-of-three threshold.
  let topFam = null;
  let topN = 0;
  for (const [fam, n] of counts) {
    if (n >= RATCHET_THRESHOLD && n > topN) {
      topFam = fam;
      topN = n;
    }
  }
  if (!topFam) return; // no ratchet hand-run this turn

  // ONE advisory line (never blocks). Rule of three → codify the ratchet.
  process.stderr.write(
    `[forge:${HOOK}] this turn hand-ran a ratchet (${topFam} x${topN}) — ` +
      `codify it: the ratchet or write-loop skill.\n`
  );
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
