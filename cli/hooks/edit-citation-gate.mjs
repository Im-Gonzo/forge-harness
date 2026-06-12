#!/usr/bin/env node
/**
 * Forge — edit-citation-gate (PreToolUse: Edit|Write|MultiEdit)
 *
 * PROJECT-GATED hook (METHOD.md §9 "edit-citation gate"). No-op unless the project
 * is a Forge-tailored harness — i.e. `<projectDir>/.claude/.forge.json` exists.
 * In a tailored project, before the FIRST edit/write to a given file this session,
 * it makes the agent STOP and state the rule / spec section / business-rule ID the
 * change implements. The act of citing forces the agent to ground the edit in the
 * project's normative source (Evidence-before-claims, METHOD.md §4) instead of
 * editing blind. Allowed on retry once cited (the first-touch is recorded).
 *
 * Pattern ported from an earlier fact-force gate hook
 * (per-file first-touch + session state + PreToolUse deny) to zero-dependency
 * Node ESM, refocused on citing the governing rule rather than listing importers.
 *
 * HOOK CONTRACT (METHOD.md §9 — guardrails enforced, fail-open):
 *   - Reads the Claude Code PreToolUse hook payload as JSON on stdin.
 *   - FAILS OPEN: any parse/IO/state error → log `[forge:edit-citation-gate]` to
 *     stderr, exit 0. If state cannot be persisted, ALLOW (never trap the agent in a
 *     permanent retry loop).
 *   - Intentional block uses the PreToolUse deny mechanism (printed to stdout, exit 0).
 *
 * Conventions: Node ESM, single file, ZERO dependencies (only node: builtins).
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { emit } from './lib/telemetry.mjs';

const HOOK = 'edit-citation-gate';
const MAX_STDIN = 1024 * 1024;
const STATE_TTL_MS = 30 * 60 * 1000; // 30 min inactivity window
const MAX_TRACKED = 500;

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
// Project gate
// ---------------------------------------------------------------------------

/** Resolve the project dir from payload → env → cwd (mirrors detect-project.mjs). */
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
// Session-scoped first-touch state
// ---------------------------------------------------------------------------

function sanitize(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const s = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return s.length <= 64 ? s : createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function sessionKey(input) {
  for (const c of [input.session_id, input.sessionId, process.env.CLAUDE_SESSION_ID]) {
    const s = sanitize(c);
    if (s) return s;
  }
  const fp = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return `proj-${createHash('sha256').update(resolve(fp)).digest('hex').slice(0, 24)}`;
}

function stateFile(key) {
  return join(tmpdir(), `forge-citation-${key}.json`);
}

function loadState(file) {
  try {
    if (!existsSync(file)) return { checked: [], lastActive: Date.now() };
    const st = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() - (st.lastActive || 0) > STATE_TTL_MS) {
      try { unlinkSync(file); } catch { /* ignore */ }
      return { checked: [], lastActive: Date.now() };
    }
    return { checked: Array.isArray(st.checked) ? st.checked : [], lastActive: st.lastActive || Date.now() };
  } catch {
    return { checked: [], lastActive: Date.now() };
  }
}

/** Persist atomically. Returns false on any failure (caller then ALLOWS). */
function saveState(file, state) {
  let tmp = null;
  try {
    let checked = Array.isArray(state.checked) ? state.checked : [];
    // Merge with any concurrent writer.
    try {
      if (existsSync(file)) {
        const disk = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(disk.checked)) checked = Array.from(new Set([...disk.checked, ...checked]));
      }
    } catch { /* ignore malformed disk state */ }
    if (checked.length > MAX_TRACKED) checked = checked.slice(-MAX_TRACKED);

    tmp = `${file}.tmp.${process.pid}.${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 8)}`;
    writeFileSync(tmp, JSON.stringify({ checked, lastActive: Date.now() }), 'utf8');
    renameSync(tmp, file);
    tmp = null;
    return true;
  } catch {
    if (tmp) { try { unlinkSync(tmp); } catch { /* ignore */ } }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gate message
// ---------------------------------------------------------------------------

function gateMessage(filePath, isCreate) {
  const verb = isCreate ? 'creating' : 'editing';
  return [
    '[forge:edit-citation-gate]',
    '',
    `Before ${verb} ${filePath} (first touch this session), cite what authorizes this change:`,
    '',
    '1. The rule / spec section / business-rule ID (e.g. BR-0123, ADR-0007, a rules/ entry) the change implements.',
    '2. One sentence: what this edit does and why that source requires it.',
    '',
    'State the citation, then retry the same edit. (Forge-tailored project: this gate enforces evidence-before-claims.)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const input = parseInput(readStdin());

  // PROJECT GATE: only enforce in a Forge-tailored project.
  const projectDir = resolveProjectDir(input);
  if (!isForgeTailored(projectDir)) return; // no-op (allow)

  const rawTool = String(input.tool_name || '');
  const TOOL_MAP = { edit: 'Edit', write: 'Write', multiedit: 'MultiEdit' };
  const tool = TOOL_MAP[rawTool.toLowerCase()] || rawTool;
  if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return;

  const ti = input.tool_input || {};

  // Subagents: the parent session already passed the first-touch gate. Allow.
  if (input.parent_tool_use_id || input.parentToolUseId || input.agent_id || input.agentId) return;

  // Collect target file paths.
  const targets = [];
  if (tool === 'MultiEdit') {
    if (typeof ti.file_path === 'string' && ti.file_path) targets.push(ti.file_path);
    if (Array.isArray(ti.edits)) {
      for (const e of ti.edits) {
        if (e && typeof e.file_path === 'string' && e.file_path) targets.push(e.file_path);
      }
    }
  } else {
    const fp = ti.file_path || ti.file;
    if (typeof fp === 'string' && fp) targets.push(fp);
  }
  if (targets.length === 0) return;

  const key = sessionKey(input);
  const file = stateFile(key);
  const state = loadState(file);
  const checked = new Set(state.checked);

  for (const filePath of targets) {
    const norm = resolve(projectDir, filePath);
    if (checked.has(norm)) continue; // already cited this session

    // First touch: record it, then deny so the agent must cite before retrying.
    checked.add(norm);
    const ok = saveState(file, { checked: Array.from(checked) });
    if (!ok) {
      // Could not persist → allow (avoid a permanent block loop), but warn.
      process.stderr.write(
        `[forge:${HOOK}] state not persisted; allowing to avoid a retry loop\n`
      );
      return;
    }
    const isCreate = tool === 'Write' && !existsSync(norm);
    deny(gateMessage(filePath, isCreate));
    // POST-DECISION telemetry (additive, fail-open). Records ONLY the target's
    // sha256 + the first_touch flag — never the raw path (BR-TEL-006/008). emit()
    // is a no-op when telemetry is off.
    emit({
      event_type: 'citation.gate',
      tool,
      rule: HOOK,
      decision: 'deny',
      session_id: input.session_id || input.sessionId,
      project: projectDir,
      payload: {
        target_sha256: createHash('sha256').update(norm, 'utf8').digest('hex'),
        first_touch: true,
      },
    });
    return;
  }
  // All targets already cited — allow.
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `[forge:${HOOK}] error (allowing): ${err && err.message ? err.message : err}\n`
  );
}

process.exit(0);
