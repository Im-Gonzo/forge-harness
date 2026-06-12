#!/usr/bin/env node
/**
 * Forge — config-protection (PreToolUse: Write|Edit|MultiEdit)
 *
 * GLOBAL SAFETY hook (runs everywhere, no project gate). Blocks edits that would
 * MODIFY an existing linter/formatter/tsconfig config file. Agents reach for the
 * config to silence a check instead of fixing the source; this steers them back to
 * the code. Creating a brand-new config (none exists yet) is allowed.
 *
 * Ported from an earlier config-protection hook to
 * zero-dependency Node ESM.
 *
 * HOOK CONTRACT (METHOD.md §9 — guardrails enforced, fail-open):
 *   - Reads the Claude Code PreToolUse hook payload as JSON on stdin.
 *   - FAILS OPEN: any parse/IO error → log `[forge:config-protection]` to stderr, exit 0.
 *   - Intentional block uses the PreToolUse deny mechanism:
 *       { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *         "permissionDecision": "deny", "permissionDecisionReason": "..." } }
 *     printed to stdout, exit 0.
 *
 * Conventions: Node ESM, single file, ZERO dependencies (only node: builtins).
 */

import { lstatSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { emit } from './lib/telemetry.mjs';

const HOOK = 'config-protection';
const MAX_STDIN = 1024 * 1024;

// Config files whose MODIFICATION is steered back to fixing the source.
// tsconfig.json IS included (METHOD.md §9 names tsconfig as a protected config).
// pyproject.toml is intentionally EXCLUDED — it mixes project metadata with linter
// config, so blocking it would prevent legitimate dependency edits.
const PROTECTED_FILES = new Set([
  // ESLint (legacy + v9 flat config, JS/TS/MJS/CJS)
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  // Prettier (all config variants including ESM)
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  // Biome
  'biome.json',
  'biome.jsonc',
  // TypeScript compiler config (tsconfig + common variants)
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.build.json',
  'jsconfig.json',
  // Ruff (Python)
  '.ruff.toml',
  'ruff.toml',
  // mypy / type config (standalone, NOT pyproject.toml)
  'mypy.ini',
  '.mypy.ini',
  // Shell / Style / Markdown
  '.shellcheckrc',
  '.stylelintrc',
  '.stylelintrc.json',
  '.stylelintrc.yml',
  '.markdownlint.json',
  '.markdownlint.yaml',
  '.markdownlintrc',
]);

/** Read all of stdin synchronously (best-effort). Never throws. */
function readStdin() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.length > MAX_STDIN ? raw.slice(0, MAX_STDIN) : raw;
  } catch {
    return '';
  }
}

/** Parse the hook payload. Returns {} on any error. */
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

/** Emit a PreToolUse deny decision on stdout. */
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

/**
 * Collect every file_path targeted by this tool call (Edit/Write: one;
 * MultiEdit: the top-level file_path and/or each edit's file_path).
 */
function targetPaths(toolInput) {
  const out = [];
  if (!toolInput || typeof toolInput !== 'object') return out;
  const top = toolInput.file_path || toolInput.file;
  if (typeof top === 'string' && top) out.push(top);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      const fp = e && (e.file_path || e.file);
      if (typeof fp === 'string' && fp) out.push(fp);
    }
  }
  return out;
}

/**
 * Whether a path currently exists. Uses lstatSync so a (possibly dangling)
 * symlink still counts as present. Only genuine ENOENT means absent; any other
 * error (EACCES/EPERM/ELOOP/…) is treated as present so the guard never weakens.
 */
function pathExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    return true;
  }
}

function main() {
  const input = parseInput(readStdin());
  const toolInput = input.tool_input || {};

  for (const filePath of targetPaths(toolInput)) {
    const base = basename(filePath);
    if (!PROTECTED_FILES.has(base)) continue;
    // Allow first-time creation — there is no existing config to weaken.
    if (!pathExists(filePath)) continue;

    deny(
      `BLOCKED: Modifying ${base} is not allowed. Fix the source code to satisfy the ` +
        `linter/formatter/type-checker instead of weakening the config. If this is a ` +
        `legitimate, intended config change, make it manually (outside the agent) or ` +
        `temporarily disable the config-protection hook.`
    );
    // POST-DECISION telemetry (additive, fail-open). `config_kind` is the protected
    // config's basename — a value from the CLOSED PROTECTED_FILES set, never a raw
    // user path (BR-TEL-006/008). emit() is a no-op when telemetry is off.
    emit({
      event_type: 'config.protect',
      tool: input.tool_name || null,
      rule: HOOK,
      decision: 'deny',
      session_id: input.session_id || input.sessionId,
      project: input.cwd || input.project_dir || process.env.CLAUDE_PROJECT_DIR,
      payload: { config_kind: base },
    });
    return; // first protected match wins; deny + exit 0
  }
  // No protected file modification — allow. POST-DECISION telemetry (fail-open).
  emit({
    event_type: 'hook.allow',
    tool: input.tool_name || null,
    rule: HOOK,
    decision: 'allow',
    session_id: input.session_id || input.sessionId,
    project: input.cwd || input.project_dir || process.env.CLAUDE_PROJECT_DIR,
    payload: { matcher: input.tool_name || null },
  });
}

try {
  main();
} catch (err) {
  // FAIL OPEN: never block on an internal error.
  process.stderr.write(
    `[forge:${HOOK}] error (allowing): ${err && err.message ? err.message : err}\n`
  );
}

process.exit(0);
