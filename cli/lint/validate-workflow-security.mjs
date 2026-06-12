#!/usr/bin/env node
/**
 * validate-workflow-security — security lint for Forge's reusable-workflow assets.
 *
 * Complements `validate-workflows` (which checks the `.md` SHAPE: frontmatter, phases).
 * That validator deliberately does NOT inspect the OPTIONAL sibling Workflow-tool
 * script `workflows/<name>.js` — the only EXECUTABLE asset a workflow ships. This
 * validator closes that gap and adds a static secret sweep, so a workflow asset can
 * never smuggle a credential or an exfiltration/RCE sink past review.
 *
 * Threat model (from rules/security.md + rules/prompt-defense-baseline.md):
 *   - hard-coded secrets in a shipped asset (a leak the moment it is committed);
 *   - a Workflow `.js` reaching for the network (an exfiltration channel) or for
 *     dynamic-exec / shell (an RCE sink) — the Workflow runtime grants scripts NO
 *     filesystem, network, or child_process access, so any such call is anomalous.
 *
 * Checks (all ERROR — every check is high-confidence; no speculative WARNs):
 *   - workflows/*.md  AND  workflows/*.js : hard-coded secrets (provider key shapes +
 *     credential-assignment), reusing the conservative pattern set + placeholder/
 *     env-ref guards from hooks/secret-scan.mjs (the source of truth).
 *   - workflows/*.js ONLY (after string-aware comment masking): dynamic-exec / shell
 *     sinks (eval, new Function, child_process, vm, worker_threads, process.binding) and
 *     raw network identifiers (fetch, node:http(s)/net/dgram/dns/tls, Socket/connect,
 *     WebSocket, XMLHttpRequest) — extends the FORBIDDEN_NET shape proven in
 *     tests/meta/telemetry-no-network.mjs.
 *   - workflows/*.js ONLY: any `node:` builtin import / require (incl. `fs`) — a Workflow
 *     script is sandboxed with NO filesystem/builtin surface, so ANY node-builtin reach
 *     is anomalous (broader than the network/exec list, which named only specific
 *     modules); and DETERMINISM sinks — `Date.now()`, `Math.random()`, and a no-arg
 *     `new Date()` — because a Workflow script must be reproducible (wall-clock /
 *     randomness make two runs of an unchanged input diverge).
 *
 * The `.md` is prose and naturally describes things like "fetch the sources", so the
 * exec/network scan is scoped to `.js` only to stay anti-noise (rules/code-review.md).
 * Hidden-unicode smuggling is already covered for every file by check-unicode-safety.
 *
 * Absence of the workflows/ dir (or no files) is NOT an error.
 *
 * Invocation: node lint/validate-workflow-security.mjs [--strict] [rootDir]
 * Zero dependencies; self-contained. Mirrors lint/validate-workflows.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- argument parsing ------------------------------------------------------

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const positional = args.filter((a) => !a.startsWith('--'));
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = positional[0] ? path.resolve(positional[0]) : path.resolve(SELF_DIR, '..');

const WORKFLOWS_DIR = path.join(ROOT, 'workflows');

// ---- secret patterns (source of truth: hooks/secret-scan.mjs) --------------
// Kept self-contained (the validators are zero-dep, no shared lib by convention).
// If hooks/secret-scan.mjs gains a pattern, mirror it here.

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

const ASSIGNMENT_RE =
  /\b(?:api[_-]?key|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|db[_-]?password)\b\s*[:=]\s*['"]([^'"\n]{12,})['"]/gi;

const PLACEHOLDER_RE =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{?[a-z_][\w]*\}?|%[a-z_]+%|(?:your[_-]?|my[_-]?|some[_-]?|dummy[_-]?|fake[_-]?|test[_-]?|sample[_-]?|example[_-]?)\S*|change[_-]?me|changeme|placeholder|redacted|todo|tbd|null|none|undefined)$/i;

const ENV_REF_RE = /\$\{?[A-Za-z_]\w*\}?|process\.env\.[A-Za-z_]\w*|os\.environ(?:\.get)?[([]/;

function isPlaceholder(value) {
  const v = String(value || '').trim();
  if (!v) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (ENV_REF_RE.test(v)) return true;
  if (/example\.com|localhost|127\.0\.0\.1/i.test(v) && v.length < 40) return true;
  return false;
}

/** Mask the middle of a matched token so a finding never echoes the secret. */
function redact(token) {
  const t = String(token || '');
  if (t.length <= 12) return `${t.slice(0, 2)}…`;
  return `${t.slice(0, 6)}…${t.slice(-2)} (${t.length} chars)`;
}

/** First secret finding in a single line, or null. Mirrors secret-scan.mjs#scan. */
function scanLineForSecret(line) {
  for (const [label, re] of SECRET_PATTERNS) {
    const m = re.exec(line);
    if (m) return { label, snippet: redact(m[0]) };
  }
  ASSIGNMENT_RE.lastIndex = 0;
  let m;
  while ((m = ASSIGNMENT_RE.exec(line)) !== null) {
    const value = m[1];
    if (isPlaceholder(value)) continue;
    if (value.length < 12) continue;
    if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
      if (value.length < 20) continue;
    }
    return { label: 'hard-coded credential assignment', snippet: redact(m[0]) };
  }
  return null;
}

// ---- executable-asset (.js) sink patterns ----------------------------------
// Same FORBIDDEN_NET shape as tests/meta/telemetry-no-network.mjs, plus dynamic-exec
// sinks. Specific regexes so a benign identifier is not matched after comment-strip.

const NETWORK_SINKS = [
  ['fetch()', /\bfetch\s*\(/],
  ['node:http(s)', /['"]node:https?['"]|require\(\s*['"]https?['"]\s*\)|from\s+['"]node:https?['"]/],
  ['node:net', /['"]node:net['"]|from\s+['"]node:net['"]/],
  ['node:dgram', /['"]node:dgram['"]/],
  ['node:dns', /['"]node:dns['"]/],
  ['node:tls', /['"]node:tls['"]/],
  // `.connect(` kept for parity with telemetry-no-network's FORBIDDEN_NET: a socket
  // obtained via an alias/return value still betrays itself at the .connect() call.
  ['Socket/connect', /\bnew\s+(?:net\.)?Socket\b|\.createConnection\b|\.connect\s*\(/],
  ['WebSocket', /\bWebSocket\b/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
];

// Any `node:` builtin import/require is anomalous in a sandboxed Workflow script — it
// has NO filesystem/builtin surface. Broader than the named network/exec modules above
// (this also catches `node:fs`, `node:os`, `node:path`, …). The bare-`fs`/`child_process`
// specifier forms are already covered by EXEC_SINKS / NETWORK_SINKS; this adds the
// `node:`-prefixed catch-all and the bare `fs` reach.
const BUILTIN_SINKS = [
  [
    'node: builtin import',
    /from\s+['"]node:[a-z_/]+['"]|require\(\s*['"]node:[a-z_/]+['"]\s*\)|import\(\s*['"]node:[a-z_/]+['"]\s*\)/,
  ],
  ['fs module', /from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/],
];

// Determinism sinks — a Workflow script must be reproducible. Wall-clock and randomness
// make two runs of an unchanged input diverge. `new Date(<arg>)` (parsing a fixed string)
// is fine; only the NO-ARG `new Date()` reads the wall clock, so the regex requires the
// empty-paren form.
const DETERMINISM_SINKS = [
  ['Date.now()', /\bDate\.now\s*\(/],
  ['Math.random()', /\bMath\.random\s*\(/],
  ['new Date() [no-arg wall-clock]', /\bnew\s+Date\s*\(\s*\)/],
];

const EXEC_SINKS = [
  ['eval()', /\beval\s*\(/],
  ['new Function()', /\bnew\s+Function\s*\(/],
  [
    'child_process',
    /node:child_process|require\(\s*['"]child_process['"]\s*\)|from\s+['"](?:node:)?child_process['"]|import\(\s*['"](?:node:)?child_process['"]\s*\)/,
  ],
  ['vm module', /['"]node:vm['"]|require\(\s*['"]vm['"]\s*\)|from\s+['"](?:node:)?vm['"]/],
  // worker_threads spawns a sibling thread running a script with full network/exec —
  // a code-execution primitive, so flagged alongside the other exec sinks.
  [
    'worker_threads',
    /['"]node:worker_threads['"]|from\s+['"]node:worker_threads['"]|require\(\s*['"]node:worker_threads['"]\s*\)|\bnew\s+Worker\s*\(/,
  ],
  ['process.binding()', /\bprocess\.binding\s*\(/],
];

/**
 * Mask comments to spaces with a tiny string-aware scanner, PRESERVING line count and
 * string-literal contents. Unlike a regex strip, a `//` or `/*` INSIDE a string does
 * not start a comment — closing the `const x = '//'; fetch()` evasion — and newlines
 * are kept so a sink's reported line number is exact. String BODIES are left intact so
 * import specifiers like "node:child_process" still match. An escaped `\/` is kept as
 * code so a `/\//` regex literal cannot fake a line comment and hide a same-line sink.
 * Best-effort: it still does not fully disambiguate regex literals from division (rare
 * in orchestration scripts).
 */
function maskComments(src) {
  const s = String(src);
  let out = '';
  let state = 'code'; // code | line | block | str
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = i + 1 < s.length ? s[i + 1] : '';
    if (state === 'code') {
      // `\/` (escaped slash, e.g. the body of a `/\//` regex) is NOT a comment start.
      if (c === '/' && next === '/' && out.slice(-1) !== '\\') { state = 'line'; out += '  '; i++; continue; }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i++; continue; }
      if (c === "'" || c === '"' || c === '`') { state = 'str'; quote = c; out += c; continue; }
      out += c;
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; } else out += ' ';
    } else if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
    } else { // str
      if (c === '\\') { out += s.slice(i, i + 2); i++; continue; } // keep the escape pair
      if (c === quote) { state = 'code'; out += c; continue; }
      out += c;
    }
  }
  return out;
}

// ---- validation ------------------------------------------------------------

const errors = [];
const warnings = [];

function err(loc, msg) {
  errors.push(`ERROR  ${loc}  ${msg}`);
}

/** Secret sweep over RAW content (a secret in a comment is still a leak). */
function scanSecrets(rel, content) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const finding = scanLineForSecret(lines[i]);
    if (finding) {
      err(
        `${rel}:${i + 1}`,
        `possible hard-coded secret (${finding.label}: ${finding.snippet}) — use an env var or secret store`
      );
    }
  }
}

/**
 * Sink sweep over a `.js` Workflow script. Masks comments first (a sink named only in
 * a comment is ignored) and scans the masked source LINE-BY-LINE, so detection and the
 * reported line number come from the same text — the location is always exact.
 */
function scanScriptSinks(rel, content) {
  const lines = maskComments(content.replace(/^\uFEFF/, '')).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [groups, kind] of [
      [NETWORK_SINKS, 'raw network'],
      [EXEC_SINKS, 'dynamic-exec/shell'],
      [BUILTIN_SINKS, 'node-builtin'],
      [DETERMINISM_SINKS, 'non-deterministic'],
    ]) {
      for (const [label, re] of groups) {
        if (!re.test(line)) continue;
        const why =
          kind === 'non-deterministic'
            ? 'scripts must be reproducible; wall-clock/randomness makes runs diverge'
            : kind === 'node-builtin'
              ? 'scripts have no filesystem/builtin surface'
              : 'scripts have no network/exec surface; this is an exfiltration/RCE risk';
        err(`${rel}:${i + 1}`, `${kind} sink "${label}" in a Workflow script — ${why}`);
      }
    }
  }
}

function validateFile(file) {
  const rel = path.join('workflows', file);
  const filePath = path.join(WORKFLOWS_DIR, file);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    err(rel, `unreadable: ${e.message}`);
    return;
  }
  if (content.trim().length === 0) return; // empty file: shape, not security

  scanSecrets(rel, content);
  if (file.endsWith('.js')) scanScriptSinks(rel, content);
}

function main() {
  if (!fs.existsSync(WORKFLOWS_DIR) || !fs.statSync(WORKFLOWS_DIR).isDirectory()) {
    console.log('no workflows found (workflows/ absent) — nothing to validate');
    process.exit(0);
  }

  const files = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.md') || f.endsWith('.js'))
    .sort();
  if (files.length === 0) {
    console.log('no workflow assets found (workflows/ has no .md/.js) — nothing to validate');
    process.exit(0);
  }

  for (const file of files) validateFile(file);

  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `validate-workflow-security: ${files.length} workflow asset(s), ${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'PASS'}`
  );
  process.exit(failed ? 1 : 0);
}

main();
