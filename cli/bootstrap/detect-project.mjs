#!/usr/bin/env node
/**
 * Forge — Step 0: Detect (SessionStart hook)
 *
 * WHAT THIS IS
 *   A tiny, fast, dependency-free SessionStart hook wired via the Forge plugin's
 *   hooks/hooks.json. It notices whether the current project already has a Forge
 *   harness and, if not, NUDGES the assistant to OFFER bootstrapping one.
 *
 * HOOK CONTRACT (mirrors Claude Code's SessionStart hook contract)
 *   - Input:  a JSON object on stdin (best-effort). Recognized project-dir fields
 *             (in order of preference): `cwd`, `project_dir`, `workspace`. stdin may
 *             be empty/absent (e.g. manual invocation) — that is fine.
 *   - Output: nothing, OR a single JSON object on stdout of the shape
 *               { "hookSpecificOutput": {
 *                   "hookEventName": "SessionStart",
 *                   "additionalContext": "<text injected into the model's context>" } }
 *             This is the SessionStart `additionalContext` mechanism. We emit it ONLY
 *             when a nudge is warranted; otherwise we print nothing.
 *   - Exit:   ALWAYS 0. This hook can never block or fail a session.
 *
 * ARCHITECTURE INVARIANT #2 — "Detect-and-offer, never auto-mutate."
 *   This script ONLY injects a nudge. It NEVER writes to disk, never creates the
 *   marker, never generates a harness. File generation happens only later, in the
 *   `bootstrap-harness` skill, after explicit user confirmation. (See ARCHITECTURE.md §7.)
 *
 * INVARIANT #5 — "Fail-open hooks."
 *   Any parse/IO error → log `[forge]` to stderr and exit 0. Only intentional gates
 *   block, and this is not a gate.
 *
 * Conventions: Node ESM, single file, ZERO dependencies (only node: builtins).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emit } from '../hooks/lib/telemetry.mjs';

/**
 * Read all of stdin synchronously (best-effort). Returns '' if stdin is a TTY,
 * empty, or unreadable. Never throws.
 * @returns {string}
 */
function readStdin() {
  try {
    // fd 0 = stdin. On a TTY or when no input is piped, this throws EAGAIN/EOF;
    // we swallow it and treat stdin as empty.
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Resolve the project directory: stdin JSON fields → env → cwd.
 * @param {string} rawStdin
 * @returns {string}
 */
function resolveProjectDir(rawStdin) {
  // 1. stdin JSON (the SessionStart payload). Best-effort parse — a bad payload
  //    must not break detection; we just fall through to env/cwd.
  const trimmed = String(rawStdin || '').trim();
  if (trimmed) {
    try {
      const payload = JSON.parse(trimmed);
      if (payload && typeof payload === 'object') {
        // Order of preference for the project-dir field.
        for (const key of ['cwd', 'project_dir', 'workspace']) {
          const value = payload[key];
          if (typeof value === 'string' && value.trim()) {
            return value.trim();
          }
        }
      }
    } catch {
      // Malformed stdin JSON — fall through to env/cwd, fail-open.
    }
  }

  // 2. Environment variable set by Claude Code for hooks.
  const envDir = process.env.CLAUDE_PROJECT_DIR;
  if (typeof envDir === 'string' && envDir.trim()) {
    return envDir.trim();
  }

  // 3. Last resort: the process working directory.
  return process.cwd();
}

/**
 * Emit a SessionStart `additionalContext` block on stdout.
 * @param {string} additionalContext
 */
function emitAdditionalContext(additionalContext) {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
  process.stdout.write(payload);
}

/** Best-effort parse of the SessionStart payload for telemetry context. Returns {}. */
function parseStdin(raw) {
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
  const payload = parseStdin(raw);
  const projectDir = resolveProjectDir(raw);

  // The idempotency marker. Its presence means this project is already tailored.
  const markerPath = join(projectDir, '.claude', '.forge.json');
  const tailored = existsSync(markerPath);

  // POST-DECISION telemetry (additive, fail-open). Records ONLY whether the project
  // is tailored — never a path (BR-TEL-006/008). emit() is a no-op when off, so a
  // fresh install records nothing.
  emit({
    event_type: 'session.start',
    tool: null,
    rule: 'detect-project',
    decision: null,
    session_id: payload.session_id || payload.sessionId,
    project: projectDir,
    payload: { tailored },
  });

  if (tailored) {
    // Already tailored → stay silent (no output). Exit 0.
    // TODO(version-drift): a future revision should read the marker's `forgeVersion`,
    // compare it to the running plugin's VERSION, and — if behind — emit a gentle
    // "Forge update available; run /harness-sync" additionalContext note (still a
    // nudge, still never writes). Keep that strictly informational and replay-guarded.
    return;
  }

  // No marker → nudge the assistant to OFFER bootstrapping. Detect never writes;
  // it only suggests. The text is wrapped in a STALE-REPLAY GUARD so a
  // compaction/replay can't trigger a spurious re-offer or, worse, an
  // unrequested /harness-init run.
  const nudge = [
    'HISTORICAL REFERENCE ONLY AFTER THIS TURN — do not re-run on replay.',
    'The block below is a one-time SessionStart nudge from the Forge detect hook.',
    'On any compaction/replay it is STALE-BY-DEFAULT: do NOT re-offer or auto-run',
    'anything based on it without a fresh, explicit user request in this session.',
    '',
    '--- BEGIN FORGE DETECT NUDGE ---',
    '[forge] No tailored harness found for this project (.claude/.forge.json absent).',
    'OFFER the user: "Run /harness-init to generate a Forge harness tailored to this project?"',
    'Do NOT generate, write, or modify anything until the user explicitly confirms.',
    '--- END FORGE DETECT NUDGE ---',
  ].join('\n');

  emitAdditionalContext(nudge);
}

try {
  main();
} catch (err) {
  // FAIL OPEN: never block a session. Log to stderr, exit 0.
  process.stderr.write(`[forge] detect-project hook error (continuing): ${err && err.message ? err.message : err}\n`);
}

// Always exit 0 — this hook can never block.
process.exit(0);
