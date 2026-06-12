#!/usr/bin/env node
// @ts-check
/**
 * Forge — invoke-telemetry (PreToolUse: Task|Skill)
 *
 * A telemetry-ONLY PreToolUse hook (SPEC-05 §"The new hook", BR-TEL-008/009). It
 * exists solely to observe agent/skill STARTS — there is no reliable end event from
 * a PreToolUse matcher, so this is start-only (duration_ms:null, BR-TEL-009). It:
 *   - emits one `agent.invoke` (Task) or `skill.invoke` (Skill) event carrying ONLY
 *     `prompt_len` + `prompt_sha256` — NEVER the prompt text (BR-TEL-006);
 *   - computes nothing security-relevant and NEVER denies (emit-only);
 *   - is a no-op when telemetry is off (the emit() gate makes it free, BR-TEL-001);
 *   - ALWAYS exits 0 and writes nothing to stdout (no permissionDecision).
 *
 * HOOK CONTRACT (METHOD.md §9 — fail-open):
 *   - Reads the Claude Code PreToolUse hook payload as JSON on stdin (best-effort).
 *   - FAILS OPEN: any parse/IO error → log `[forge:invoke-telemetry]` to stderr,
 *     exit 0. Never blocks.
 *
 * Conventions: Node ESM, single file, ZERO dependencies (only node: builtins +
 * the relative telemetry emitter).
 */

import { readFileSync } from 'node:fs';
import { emit, sha256hex } from './lib/telemetry.mjs';

const HOOK = 'invoke-telemetry';
const MAX_STDIN = 4 * 1024 * 1024;

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

function main() {
  const input = parseInput(readStdin());

  // Resolve the tool (tolerant of case). Only Task / Skill are observed.
  const rawTool = String(input.tool_name || '');
  const TOOL_MAP = { task: 'Task', skill: 'Skill' };
  const tool = TOOL_MAP[rawTool.toLowerCase()] || rawTool;
  if (tool !== 'Task' && tool !== 'Skill') return; // not an invoke we observe

  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';

  // POST-"decision": there is no decision here (emit-only). We record ONLY the
  // prompt length + hash — never the prompt text (BR-TEL-006). duration_ms is null
  // (start-only; there is no end event — BR-TEL-009).
  emit({
    event_type: tool === 'Task' ? 'agent.invoke' : 'skill.invoke',
    tool,
    decision: null,
    session_id: input.session_id || input.sessionId,
    project: input.cwd || input.project_dir || process.env.CLAUDE_PROJECT_DIR,
    duration_ms: null,
    payload: { prompt_len: prompt.length, prompt_sha256: sha256hex(prompt) },
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `[forge:${HOOK}] error (continuing): ${err && err.message ? err.message : err}\n`
  );
}

// Telemetry-only hook: never blocks. Always exit 0.
process.exit(0);
