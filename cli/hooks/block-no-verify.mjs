#!/usr/bin/env node
/**
 * Forge — block-no-verify (PreToolUse: Bash)
 *
 * GLOBAL SAFETY hook (runs everywhere, no project gate). Blocks git hook-bypass
 * flags so pre-commit / commit-msg / pre-push hooks cannot be skipped by the agent:
 *   - `--no-verify` (and `-n` on `git commit`) on commit/push/merge/cherry-pick/rebase/am
 *   - `-c core.hooksPath=...` overrides (config key is case-insensitive)
 *
 * Ported from an earlier block-no-verify hook to zero-dependency Node ESM
 * (logic preserved; tightened to its core scanners).
 *
 * HOOK CONTRACT (METHOD.md §9 — guardrails enforced, fail-open):
 *   - Reads the Claude Code PreToolUse hook payload as JSON on stdin.
 *   - FAILS OPEN: any parse/IO error → log `[forge:block-no-verify]` to stderr, exit 0.
 *   - Intentional block uses the PreToolUse deny mechanism (printed to stdout, exit 0).
 *
 * Conventions: Node ESM, single file, ZERO dependencies (only node: builtins).
 */

import { readFileSync } from 'node:fs';
import { emit } from './lib/telemetry.mjs';

const HOOK = 'block-no-verify';
const MAX_STDIN = 1024 * 1024;

// Git subcommands that honor --no-verify.
const GIT_COMMANDS_WITH_NO_VERIFY = ['commit', 'push', 'merge', 'cherry-pick', 'rebase', 'am'];

// Characters that may legitimately precede a `git` token in a command string.
const VALID_BEFORE_GIT = ' \t\n\r;&|$`(<{!"\']/.~\\';

// core.hooksPath= — variable names are case-insensitive per git-config docs.
const GIT_CONFIG_KEY_PREFIX = 'core.hookspath=';

// `git commit` options that take a value (so a following token is NOT a flag).
const COMMIT_OPTIONS_WITH_VALUE = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message',
  '--author', '--date', '--template', '--fixup', '--squash', '--pathspec-from-file',
]);
const COMMIT_OPTIONS_WITH_INLINE_VALUE = [
  '--message=', '--file=', '--reuse-message=', '--reedit-message=', '--author=',
  '--date=', '--template=', '--fixup=', '--squash=', '--pathspec-from-file=',
];
const COMMIT_SHORT_OPTIONS_WITH_VALUE = new Set(['m', 'F', 'C', 'c', 't']);

// ---------------------------------------------------------------------------
// Shell-ish tokenizer (quote/escape aware) and segment scanner
// ---------------------------------------------------------------------------

function tokenizeShellWords(input, start = 0, end = input.length) {
  const tokens = [];
  let value = '';
  let tokenStart = null;
  let quote = null;
  let escaped = false;

  const begin = (i) => { if (tokenStart === null) tokenStart = i; };
  const push = (i) => {
    if (tokenStart === null) return;
    tokens.push({ value, start: tokenStart, end: i });
    value = '';
    tokenStart = null;
  };

  for (let i = start; i < end; i++) {
    const ch = input.charAt(i);
    if (escaped) { begin(i - 1); value += ch; escaped = false; continue; }
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (quote === '"' && ch === '\\') { begin(i); escaped = true; continue; }
      begin(i); value += ch; continue;
    }
    if (ch === '"' || ch === "'") { begin(i); quote = ch; continue; }
    if (ch === '\\') { begin(i); escaped = true; continue; }
    if (/\s/.test(ch)) { push(i); continue; }
    begin(i); value += ch;
  }
  if (escaped) value += '\\';
  push(end);
  return tokens;
}

function findCommandSegmentEnd(input, start) {
  let quote = null;
  let escaped = false;
  for (let i = start; i < input.length; i++) {
    const ch = input.charAt(i);
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (quote === '"' && ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') return i;
  }
  return input.length;
}

function isInComment(input, idx) {
  const lineStart = input.lastIndexOf('\n', idx - 1) + 1;
  const before = input.slice(lineStart, idx);
  for (let i = 0; i < before.length; i++) {
    if (before.charAt(i) === '#') {
      const prev = i > 0 ? before.charAt(i - 1) : '';
      if (prev !== '$' && prev !== '\\') return true;
    }
  }
  return false;
}

function findGit(input, start) {
  let pos = start;
  while (pos < input.length) {
    const idx = input.indexOf('git', pos);
    if (idx === -1) return null;
    const isExe = input.slice(idx + 3, idx + 7).toLowerCase() === '.exe';
    const len = isExe ? 7 : 3;
    const after = input[idx + len] || ' ';
    if (!/[\s"']/.test(after)) { pos = idx + 1; continue; }
    const before = idx > 0 ? input[idx - 1] : ' ';
    if (VALID_BEFORE_GIT.includes(before)) return { idx, len };
    pos = idx + 1;
  }
  return null;
}

// Find the git subcommand nearest to `git`, skipping global flags (and `-c key=val`).
function detectGitCommand(input, start = 0) {
  while (start < input.length) {
    const git = findGit(input, start);
    if (!git) return null;
    if (isInComment(input, git.idx)) { start = git.idx + git.len; continue; }

    let bestCmd = null;
    let bestIdx = Infinity;

    for (const cmd of GIT_COMMANDS_WITH_NO_VERIFY) {
      let searchPos = git.idx + git.len;
      while (searchPos < input.length) {
        const cmdIdx = input.indexOf(cmd, searchPos);
        if (cmdIdx === -1) break;
        const before = cmdIdx > 0 ? input[cmdIdx - 1] : ' ';
        const after = input[cmdIdx + cmd.length] || ' ';
        if (!/\s/.test(before)) { searchPos = cmdIdx + 1; continue; }
        if (!/[\s;&#|>)\]}"']/.test(after) && after !== '') { searchPos = cmdIdx + 1; continue; }
        if (/[;|]/.test(input.slice(git.idx + git.len, cmdIdx))) break;
        if (isInComment(input, cmdIdx)) { searchPos = cmdIdx + 1; continue; }

        const gap = input.slice(git.idx + git.len, cmdIdx);
        const tokens = gap.trim().split(/\s+/).filter(Boolean);
        let onlyFlagsAndArgs = true;
        let expectFlagArg = false;
        for (const t of tokens) {
          if (expectFlagArg) { expectFlagArg = false; continue; }
          if (t.startsWith('-')) {
            if (t === '-c' || t === '-C' || t === '--work-tree' || t === '--git-dir' ||
                t === '--namespace' || t === '--super-prefix') {
              expectFlagArg = true;
            }
            continue;
          }
          onlyFlagsAndArgs = false;
          break;
        }
        if (!onlyFlagsAndArgs) { searchPos = cmdIdx + 1; continue; }

        if (cmdIdx < bestIdx) { bestIdx = cmdIdx; bestCmd = cmd; }
        break;
      }
    }

    if (bestCmd) {
      return {
        command: bestCmd,
        offset: bestIdx + bestCmd.length,
        gitStart: git.idx,
        gitEnd: git.idx + git.len,
        commandStart: bestIdx,
      };
    }
    start = git.idx + git.len;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flag detectors
// ---------------------------------------------------------------------------

function getCommitShortValueOption(value) {
  if (!value.startsWith('-') || value.startsWith('--') || value === '-') return null;
  const options = value.slice(1);
  for (let i = 0; i < options.length; i++) {
    if (COMMIT_SHORT_OPTIONS_WITH_VALUE.has(options.charAt(i))) {
      return { consumesNextValue: i === options.length - 1, containsInlineValue: i < options.length - 1 };
    }
  }
  return null;
}

function isCommitNoVerifyShortFlag(value) {
  return value === '-n' || /^-n[a-zA-Z]/.test(value);
}

function commitOptionConsumesNextValue(value) {
  if (isCommitNoVerifyShortFlag(value)) return false;
  if (COMMIT_OPTIONS_WITH_VALUE.has(value)) return true;
  const s = getCommitShortValueOption(value);
  return Boolean(s && s.consumesNextValue);
}

function commitOptionContainsInlineValue(value) {
  if (isCommitNoVerifyShortFlag(value)) return false;
  if (COMMIT_OPTIONS_WITH_INLINE_VALUE.some((p) => value.startsWith(p))) return true;
  const s = getCommitShortValueOption(value);
  return Boolean(s && s.containsInlineValue);
}

function hasNoVerifyFlag(input, command, offset) {
  const segmentEnd = findCommandSegmentEnd(input, offset);
  const tokens = tokenizeShellWords(input, offset, segmentEnd);
  let skipNext = false;
  for (const token of tokens) {
    const value = token.value;
    if (skipNext) { skipNext = false; continue; }
    if (value === '--') break;
    if (command === 'commit') {
      if (commitOptionConsumesNextValue(value)) { skipNext = true; continue; }
      if (commitOptionContainsInlineValue(value)) continue;
    }
    if (value === '--no-verify') return true;
    if (command === 'commit' && isCommitNoVerifyShortFlag(value)) return true;
  }
  return false;
}

function hasHooksPathOverride(input, detected) {
  const tokens = tokenizeShellWords(input, detected.gitEnd, detected.commandStart);
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    const lowered = value.toLowerCase();
    if (value === '-c') {
      const next = tokens[i + 1] && tokens[i + 1].value;
      if (typeof next === 'string' && next.toLowerCase().startsWith(GIT_CONFIG_KEY_PREFIX)) return true;
      i++;
      continue;
    }
    if (lowered.startsWith(`-c${GIT_CONFIG_KEY_PREFIX}`)) return true;
  }
  return false;
}

function checkCommand(input) {
  let start = 0;
  while (start < input.length) {
    const detected = detectGitCommand(input, start);
    if (!detected) return { blocked: false };
    const { command: gitCommand, offset } = detected;
    if (hasHooksPathOverride(input, detected)) {
      return {
        blocked: true,
        flag: 'core.hooksPath',
        reason: `BLOCKED: Overriding core.hooksPath is not allowed with git ${gitCommand}. Git hooks must not be bypassed.`,
      };
    }
    if (hasNoVerifyFlag(input, gitCommand, offset)) {
      return {
        blocked: true,
        flag: '--no-verify',
        reason: `BLOCKED: --no-verify is not allowed with git ${gitCommand}. Git/CI hooks must not be bypassed; fix the cause that the hook is flagging.`,
      };
    }
    start = findCommandSegmentEnd(input, offset) + 1;
  }
  return { blocked: false };
}

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

function extractCommand(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return trimmed;
    const cmd = parsed.tool_input && parsed.tool_input.command;
    if (typeof cmd === 'string') return cmd;
    for (const key of ['command', 'cmd', 'input', 'shell', 'script']) {
      if (typeof parsed[key] === 'string') return parsed[key];
    }
    return trimmed;
  } catch {
    return trimmed;
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

/** Parse the full payload (best-effort) for telemetry context only. Returns {}. */
function parseFullInput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function main() {
  const raw = readStdin();
  const command = extractCommand(raw);
  if (!command) return;
  const input = parseFullInput(raw);
  const result = checkCommand(command);
  if (result.blocked) {
    deny(result.reason);
    // POST-DECISION telemetry (additive, fail-open). `flag` is a fixed enum
    // (--no-verify | core.hooksPath), never the raw command (BR-TEL-006/008).
    emit({
      event_type: 'noverify.block',
      tool: input.tool_name || 'Bash',
      rule: HOOK,
      decision: 'deny',
      session_id: input.session_id || input.sessionId,
      project: input.cwd || input.project_dir || process.env.CLAUDE_PROJECT_DIR,
      payload: { flag: result.flag || '--no-verify' },
    });
    return;
  }
  // Allowed. POST-DECISION telemetry (fail-open).
  emit({
    event_type: 'hook.allow',
    tool: input.tool_name || 'Bash',
    rule: HOOK,
    decision: 'allow',
    session_id: input.session_id || input.sessionId,
    project: input.cwd || input.project_dir || process.env.CLAUDE_PROJECT_DIR,
    payload: { matcher: input.tool_name || 'Bash' },
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
