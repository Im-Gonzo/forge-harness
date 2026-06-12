#!/usr/bin/env node
/**
 * Forge — secret-scan (PreToolUse: Write|Edit|MultiEdit and Bash)
 *
 * GLOBAL SAFETY hook (runs everywhere, no project gate; security module). Flags
 * OBVIOUS hard-coded secrets before they are written to a file or echoed in a
 * shell command, and blocks the operation so the agent uses an env var / secret
 * store instead.
 *
 * Scope (deliberately conservative — high-signal patterns only, to avoid noise):
 *   - well-known provider key shapes (AWS access key, GitHub PAT, OpenAI/Anthropic
 *     keys, Slack token, Google API key, Stripe live key, private-key PEM headers,
 *     JWT-ish triples)
 *   - assignment-style `secret/token/password/api_key = "<long high-entropy value>"`
 * Placeholders (`xxx`, `<...>`, `your-...`, `changeme`, `example`, env refs like
 * `${VAR}` / `process.env.X` / `os.environ[...]`) are NOT flagged.
 *
 * HOOK CONTRACT (METHOD.md §9 — guardrails enforced, fail-open):
 *   - Reads the Claude Code PreToolUse hook payload as JSON on stdin.
 *   - FAILS OPEN: any parse/IO error → log `[forge:secret-scan]` to stderr, exit 0.
 *   - Intentional block uses the PreToolUse deny mechanism (printed to stdout, exit 0).
 *
 * Conventions: Node ESM, single file, ZERO dependencies (only node: builtins).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { emit } from './lib/telemetry.mjs';

const HOOK = 'secret-scan';
const MAX_STDIN = 4 * 1024 * 1024; // file writes can be large

// High-signal secret patterns: [label, regex]. Regexes are intentionally specific.
const SECRET_PATTERNS = [
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['AWS secret access key', /\baws_secret_access_key\b\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}['"]?/i],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['GitHub fine-grained PAT', /\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe live secret key', /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/],
  ['Twilio account SID + key', /\bSK[0-9a-fA-F]{32}\b/],
  ['Private key PEM', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

// Assignment of a credential-named field to a long literal value.
// e.g.  password = "S3cr3tP@ssw0rdValue123"   API_KEY: 'abcd...'
const ASSIGNMENT_RE =
  /\b(?:api[_-]?key|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|db[_-]?password)\b\s*[:=]\s*['"]([^'"\n]{12,})['"]/gi;

// Values that look like placeholders, not real secrets — never flag these.
const PLACEHOLDER_RE =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{?[a-z_][\w]*\}?|%[a-z_]+%|(?:your[_-]?|my[_-]?|some[_-]?|dummy[_-]?|fake[_-]?|test[_-]?|sample[_-]?|example[_-]?)\S*|change[_-]?me|changeme|placeholder|redacted|todo|tbd|null|none|undefined)$/i;

// Env-reference forms anywhere in the value → treat as not-a-literal-secret.
const ENV_REF_RE = /\$\{?[A-Za-z_]\w*\}?|process\.env\.[A-Za-z_]\w*|os\.environ(?:\.get)?[([]/;

function isPlaceholder(value) {
  const v = String(value || '').trim();
  if (!v) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (ENV_REF_RE.test(v)) return true;
  // Obvious doc/example fillers.
  if (/example\.com|localhost|127\.0\.0\.1/i.test(v) && v.length < 40) return true;
  return false;
}

/**
 * Scan a blob; return the first finding {label, snippet, raw} or null. `raw` is the
 * matched token kept IN-PROCESS only so the telemetry emit can record its sha256 +
 * length — it is NEVER serialized anywhere (BR-TEL-006).
 */
function scan(text) {
  const s = String(text || '');
  if (!s) return null;

  for (const [label, re] of SECRET_PATTERNS) {
    const m = re.exec(s);
    if (m) return { label, snippet: redact(m[0]), raw: m[0] };
  }

  ASSIGNMENT_RE.lastIndex = 0;
  let m;
  while ((m = ASSIGNMENT_RE.exec(s)) !== null) {
    const value = m[1];
    if (isPlaceholder(value)) continue;
    // Require some entropy/length so a short obvious non-secret (e.g. a word) is skipped.
    if (value.length < 12) continue;
    if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
      // Letters-only or digits-only literals of moderate length are usually not
      // real credentials (e.g. "description here"); require mixed character classes.
      if (value.length < 20) continue;
    }
    return { label: 'hard-coded credential assignment', snippet: redact(m[0]), raw: value };
  }

  return null;
}

/** Mask the middle of a matched token so the deny reason never leaks the secret. */
function redact(token) {
  const t = String(token || '');
  if (t.length <= 12) return `${t.slice(0, 2)}…`;
  return `${t.slice(0, 6)}…${t.slice(-2)} (${t.length} chars)`;
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

/** Gather every text blob this tool call would introduce. */
function collectBlobs(input) {
  const blobs = [];
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  if (!ti || typeof ti !== 'object') return blobs;

  // Bash: the command line itself.
  if (typeof ti.command === 'string') blobs.push(ti.command);

  // Write: full file content.
  if (typeof ti.content === 'string') blobs.push(ti.content);

  // Edit: the replacement text (don't scan old_string — it may already be on disk).
  if (typeof ti.new_string === 'string') blobs.push(ti.new_string);

  // MultiEdit: each edit's new_string.
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (e && typeof e.new_string === 'string') blobs.push(e.new_string);
    }
  }

  // Mark Bash so the message can say "command" vs "file".
  return blobs.map((b) => ({ tool, text: b }));
}

function deny(finding, tool) {
  const where = tool === 'Bash' ? 'this command' : 'this file content';
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `BLOCKED: a possible secret (${finding.label}: ${finding.snippet}) was detected in ${where}. ` +
          `Do not hard-code credentials. Use an environment variable, a secret manager, or a ` +
          `gitignored .env file referenced at runtime. If this is a false positive (e.g. a fixture ` +
          `or example value), make the change manually outside the agent or use a clear placeholder.`,
      },
    })
  );
}

function main() {
  const input = parseInput(readStdin());
  const blobs = collectBlobs(input);
  for (const { tool, text } of blobs) {
    const finding = scan(text);
    if (finding) {
      deny(finding, tool);
      // POST-DECISION telemetry (additive, fail-open). The deny is already on
      // stdout above; this emit cannot change it. Records ONLY the secret's
      // sha256 + length, NEVER the value (BR-TEL-006/008). emit() is a no-op
      // when telemetry is off.
      emit({
        event_type: 'secret.catch',
        tool: input.tool_name || tool,
        rule: HOOK,
        decision: 'deny',
        session_id: input.session_id || input.sessionId,
        project: input.cwd || input.project_dir || process.env.CLAUDE_PROJECT_DIR,
        payload: {
          label: finding.label,
          value_sha256: createHash('sha256').update(String(finding.raw || ''), 'utf8').digest('hex'),
          value_len: String(finding.raw || '').length,
        },
      });
      return; // first finding blocks; exit 0
    }
  }
  // No secret detected — allow. POST-DECISION telemetry (additive, fail-open).
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
  process.stderr.write(
    `[forge:${HOOK}] error (allowing): ${err && err.message ? err.message : err}\n`
  );
}

process.exit(0);
