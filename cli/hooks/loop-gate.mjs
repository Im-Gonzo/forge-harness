#!/usr/bin/env node
/**
 * Forge — loop-gate (PreToolUse: Bash)
 *
 * PROJECT-GATED hook (LOOPS-MODULE-DESIGN.md D6). No-op unless the project is a
 * Forge-tailored harness — i.e. `<projectDir>/.claude/.forge.json` exists. In a
 * tailored project it watches for UNATTENDED-EXECUTION shapes on Bash — a headless
 * `claude -p`, a `nohup claude ...`, a `crontab -e`, a `gh workflow run` — and steers
 * the agent to author a registered loop (maker/checker split + bounded exit) instead
 * of running an unbounded automation by hand (loop-discipline.md, rule of three).
 *
 * REPORT-ONLY by DEFAULT (D6, PLAN §7 open question 4). On a match it prints the steer
 * message to STDERR as advisory context and EXITS 0 (allow) — it does NOT deny. This is
 * the safe rollout posture until a false-positive-free week. Set the env var
 *
 *     FORGE_LOOP_GATE=enforce
 *
 * to flip it into actual DENY mode (the PreToolUse deny JSON on stdout). Any other
 * value (or unset) keeps report-only.
 *
 * ALLOW (never reports/denies) when ANY of:
 *   - the command substring-matches a registered loop's `runtime_invocation`
 *     (read from `<project>/.claude/loops/*.md` frontmatter), OR
 *   - the command carries a `FORGE_LOOP=<name>` env prefix naming a registered loop, OR
 *   - `<project>/.claude/loops/` does not exist (module not adopted), OR
 *   - the project is not Forge-tailored (no .claude/.forge.json).
 *
 * HOOK CONTRACT (mirrors hooks/edit-citation-gate.mjs — fail-open):
 *   - Reads the Claude Code PreToolUse hook payload as JSON on stdin.
 *   - FAILS OPEN: any parse/IO error → log `[forge:loop-gate]` to stderr, exit 0.
 *   - Intentional block (enforce mode) uses the PreToolUse deny mechanism (stdout, exit 0).
 *   - Telemetry via hooks/lib/telemetry.mjs emit(): one `loop.gate` event per report/deny,
 *     recording ONLY the sha256 of the command (BR-TEL-006) — never the raw command.
 *
 * Conventions: Node ESM, single file, ZERO dependencies (only node: builtins).
 *
 * NOTE: registered in hooks/hooks.json (forge:loop-gate). Ships REPORT-ONLY by default
 * and PROJECT-GATED; FORGE_LOOP_GATE=enforce flips to deny after a false-positive-free week.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { emit } from './lib/telemetry.mjs';

const HOOK = 'loop-gate';
const MAX_STDIN = 1024 * 1024;

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

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Project gate (mirrors edit-citation-gate.mjs)
// ---------------------------------------------------------------------------

/** Resolve the project dir from payload → env → cwd. */
function resolveProjectDir(input) {
  for (const key of ['cwd', 'project_dir', 'projectDir', 'workspace']) {
    const v = input && input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const envDir = process.env.CLAUDE_PROJECT_DIR;
  if (typeof envDir === 'string' && envDir.trim()) return envDir.trim();
  return process.cwd();
}

/** True only when this project carries a tailored Forge harness marker. */
function isForgeTailored(projectDir) {
  return existsSync(join(projectDir, '.claude', '.forge.json'));
}

// ---------------------------------------------------------------------------
// Unattended-execution pattern match (D6)
// ---------------------------------------------------------------------------

const UNATTENDED_PATTERNS = [
  /\bclaude\s+(-p|--print)\b/,
  /\bnohup\b.*\bclaude\b/,
  /\bcrontab\s+-e\b/,
  /\bgh\s+workflow\s+run\b/,
];

function matchesUnattended(command) {
  return UNATTENDED_PATTERNS.some((re) => re.test(command));
}

// ---------------------------------------------------------------------------
// Registered loops (read `<project>/.claude/loops/*.md` frontmatter)
// ---------------------------------------------------------------------------

/**
 * The loops dir for this project. Returns null if it does not exist (module not
 * adopted) — the caller treats that as ALLOW.
 */
function loopsDir(projectDir) {
  const dir = join(projectDir, '.claude', 'loops');
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  } catch {
    /* fall through */
  }
  return null;
}

/** Pull a single top-level frontmatter scalar by key, unquoted. Best-effort. */
function frontmatterScalar(content, key) {
  const fm = content.replace(/^\uFEFF/, '');
  if (!fm.startsWith('---')) return null;
  const lines = fm.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break; // end of frontmatter
    const m = lines[i].match(new RegExp(`^${key}\\s*:\\s*(.*)$`));
    if (m) {
      let v = m[1].trim();
      // Strip a trailing unquoted `# comment`.
      if (v[0] !== '"' && v[0] !== "'") v = v.replace(/\s+#.*$/, '').trim();
      if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  return null;
}

/**
 * Read every registered loop in the project. Returns [{ name, runtime_invocation }].
 * Fail-open to [] on any IO error.
 */
function readRegisteredLoops(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of entries) {
    if (!f.endsWith('.md') || f.toLowerCase() === 'readme.md') continue;
    try {
      const content = readFileSync(join(dir, f), 'utf8');
      const name = frontmatterScalar(content, 'name');
      const invocation = frontmatterScalar(content, 'runtime_invocation');
      out.push({ name: name || f.replace(/\.md$/, ''), runtime_invocation: invocation || '' });
    } catch {
      /* skip an unreadable loop file */
    }
  }
  return out;
}

/** Normalize whitespace for substring matching (D6: substring-normalized match). */
function normalizeWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * ALLOW if a registered loop authorizes this command. Authorized when either:
 *   - a `FORGE_LOOP=<name>` env prefix names a registered loop AND the command
 *     contains that loop's declared runtime_invocation, OR
 *   - a registered loop's runtime_invocation is a substring (whitespace-normalized)
 *     of the command.
 * The name alone is NOT authorization — otherwise any registered name becomes a
 * skeleton key that self-exempts arbitrary commands (security review 2026-06-10).
 * @returns {string|null} the matched loop name, or null if none.
 */
function authorizingLoop(command, loops) {
  const cmd = normalizeWs(command);

  // FORGE_LOOP=<name> env prefix → named loop must exist AND its invocation must match.
  const envMatch = command.match(/\bFORGE_LOOP=("?)([A-Za-z0-9_-]+)\1/);
  if (envMatch) {
    const named = envMatch[2];
    const loop = loops.find((l) => l.name === named);
    if (loop) {
      const inv = normalizeWs(loop.runtime_invocation);
      if (inv && cmd.includes(inv)) return named;
    }
  }

  // runtime_invocation substring match.
  for (const l of loops) {
    const inv = normalizeWs(l.runtime_invocation);
    if (inv && cmd.includes(inv)) return l.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Steer message
// ---------------------------------------------------------------------------

function steerMessage() {
  return [
    '[forge:loop-gate]',
    '',
    'Unattended execution without a registered loop.',
    '',
    'A headless/scheduled run (claude -p, nohup claude, crontab, gh workflow run) should be',
    'a checked-in loop with a maker/checker split and a bounded exit condition — not a',
    'hand-run one-off (loop-discipline.md). Author it via the write-loop skill, or, if a',
    'registered loop already covers this, prefix the command with FORGE_LOOP=<name>.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const input = parseInput(readStdin());

  // PROJECT GATE: only act in a Forge-tailored project.
  const projectDir = resolveProjectDir(input);
  if (!isForgeTailored(projectDir)) return; // no-op (allow)

  // Only Bash.
  const rawTool = String(input.tool_name || '');
  if (rawTool.toLowerCase() !== 'bash') return;

  const ti = input.tool_input || {};
  const command = typeof ti.command === 'string' ? ti.command : '';
  if (!command) return;

  // Not an unattended-execution shape → allow.
  if (!matchesUnattended(command)) return;

  // Module not adopted (no .claude/loops/) → allow.
  const dir = loopsDir(projectDir);
  if (!dir) return;

  // A registered loop authorizes this command → allow.
  const loops = readRegisteredLoops(dir);
  if (authorizingLoop(command, loops)) return;

  // Unattended + no authorizing loop. enforce → deny; otherwise report-only (default).
  const enforce = String(process.env.FORGE_LOOP_GATE || '').toLowerCase() === 'enforce';
  const decision = enforce ? 'deny' : 'report';

  if (enforce) {
    deny(steerMessage());
  } else {
    process.stderr.write(steerMessage() + '\n');
  }

  // POST-DECISION telemetry (additive, fail-open). Records ONLY the command's sha256
  // (BR-TEL-006/008) and the report/enforce mode — NEVER the raw command. The closed
  // allow-list for 'loop.gate' is {command_sha256, mode}. emit() is a no-op when
  // telemetry is off, and is called AFTER the decision so it can never alter it.
  emit({
    event_type: 'loop.gate',
    tool: 'Bash',
    rule: HOOK,
    decision: enforce ? 'deny' : 'allow',
    session_id: input.session_id || input.sessionId,
    project: projectDir,
    payload: {
      command_sha256: createHash('sha256').update(command, 'utf8').digest('hex'),
      mode: decision, // 'report' (default) | 'deny' (enforce)
    },
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `[forge:${HOOK}] error (allowing): ${err && err.message ? err.message : err}\n`
  );
}

process.exit(0);
