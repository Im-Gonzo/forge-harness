// @ts-check
/**
 * scan-resource-safety — DETERMINISTIC code-safety scanner for EXECUTABLE candidate
 * resources, the second deterministic layer of the federated-catalog security-scan
 * gate (ADR-0017 §5a, layer 1).
 *
 * NAMING (deliberate): this file is NOT named `validate-*.mjs` / `check-*.mjs` and
 * does NOT live under `lint/`, so `lint/run-all.mjs` (which auto-discovers
 * `lint/validate-*.mjs` + `lint/check-*.mjs`) NEVER runs it against the forge tree.
 * That matters: this scanner recognises dangerous-code SIGNATURES, and its own
 * header lists those very tokens (child_process, eval, curl …) — auto-running it
 * over our own manager modules would false-positive. It is a LIBRARY function the
 * catalog admission pipeline imports and calls on a single executable CANDIDATE,
 * not a tree-wide self-validator.
 *
 * CRITICAL INVARIANT (rules/prompt-defense-baseline.md): the candidate's bytes are
 * UNTRUSTED DATA, never instructions, and its CODE is never run. This scanner READS
 * the candidate and pattern-matches it statically. It NEVER executes, sources,
 * imports, spawns, or evaluates candidate code. `sync` already guarantees fetched
 * code is only cloned + read, never run (ADR-0017 §3).
 *
 * SCOPE: this scanner targets EXECUTABLE kinds — hooks, commands, and any script
 * file (`.mjs` / `.js` / `.cjs` / `.sh` / `.bash` / `.zsh` and shebanged files) in
 * a candidate. Non-executable / plain-text kinds (rules, agents/skills-as-prose,
 * mcp JSON snippets, `.md`) are covered by scan-injection.mjs and are returned
 * `clean` here — this scanner is for CODE. Executable kinds get BOTH scanners plus
 * the always-on repo-safety-auditor agent (§5a layer 2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DETECTS — named rules, each emitting a `{rule}` with file:line evidence
 * ─────────────────────────────────────────────────────────────────────────────
 *   - network-egress (medium) — outbound calls from a local-only artifact:
 *     `fetch(`, `XMLHttpRequest`, `http(s).request`, `net.connect`, `dns.*`,
 *     `curl`, `wget`, `nc` (netcat).
 *   - process-exec (high) — dynamic code / shell execution: `child_process`,
 *     `exec(`/`execSync(`/`spawn(`/`fork(`, `eval(`, `new Function(`,
 *     `vm.runIn*`.
 *   - fs-danger (medium) — destructive / out-of-scope filesystem ops:
 *     `fs.writeFile`/`appendFile`/`rm`/`unlink`/`rmdir` targeting an absolute or
 *     `~` path, `rimraf`, and shell `>` redirection to an absolute path.
 *   - secret-access (high when token/key-shaped or credential store; low for a
 *     bare `process.env` read) — `process.env` (esp. names matching
 *     TOKEN|KEY|SECRET|PASSWORD), `~/.ssh`, `~/.aws`, `.npmrc`, `/etc/passwd`,
 *     `keychain` / `security find-generic-password`.
 *   - obfuscation (high) — payload hiding feeding execution: `Buffer.from(…,
 *     'base64')` whose output flows to eval/exec, `atob(…)` /
 *     `decodeURIComponent(…)` feeding exec, `String.fromCharCode(...)` chains,
 *     escaped-`\xNN` hex strings feeding exec.
 *   - computed-exec (high) — bracket member access whose CONCATENATED string spells
 *     a dangerous identifier (`globalThis['ev'+'al']`, `window['fet'+'ch']`,
 *     `String['from'+'CharCode']`) — string-split execution to dodge token matching.
 *   - obfuscated-member-access (medium) — any `obj['..'+'..'](…)` computed member
 *     access built from string concatenation that then feeds a call (general
 *     concat-to-call obfuscation, even when the spelled name is not in the danger
 *     list).
 *   - forge-bypass (medium) — detection-evasion / hook tampering: `--no-verify`,
 *     `core.hooksPath`, disabling hooks, `chmod +x` followed by running the file.
 *
 * COMMENT HANDLING (cut false-positives): before signature matching, line comments
 * (`// ...`), block comments (slash-star ... star-slash), and `#` shell comments
 * are STRIPPED (blanked, length-preserving so line numbers stay exact). STRING /
 * TEMPLATE LITERAL interiors are deliberately KEPT — payloads hide in strings — so
 * a commented `// Do NOT use eval()` or a block-commented `await fetch(url)` no longer flags,
 * while `const u = 'http://evil/c2'` still does.
 *
 * SEVERITY MODEL: high = dynamic execution, secret harvest, exfil, obfuscation→exec
 * (the directly-weaponisable signatures). medium = network egress, fs-danger,
 * forge-bypass (dangerous capability, context-dependent intent). low = a bare
 * `process.env` read with no sensitive name (informational). VERDICT: `flagged` if
 * ANY finding is high OR medium; otherwise `clean` (low-only or no findings).
 *
 *   - mcp-command (high) — a candidate JSON MCP config (`mcpServers`, or a top-level
 *     `command`/`args`) whose server command or args spell a dangerous shell payload
 *     (sh/bash/python -c, curl|wget|nc, pipe-to-shell, base64-decode-then-exec,
 *     eval/child_process). A benign config (command "node", args ["server.js"]) is
 *     clean. JSON is otherwise prose (out of CODE_EXT scope) — only MCP command/args
 *     strings are pattern-matched here.
 *   - needs-review (medium) — FAIL-CLOSED sentinel: the candidate could NOT be scanned
 *     (no/empty path, stat failure, non-file/non-dir, top-level error, or a torn code
 *     file). An unscannable UNTRUSTED candidate must not pass → `flagged` (not clean).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT (consumed verbatim by manager/catalog.mjs's security-scan step)
 * ─────────────────────────────────────────────────────────────────────────────
 *   scanResourceSafety(candidatePath: string) -> {
 *     verdict: "clean" | "flagged",
 *     findings: Array<{ rule, severity, path, line, evidence, message }>
 *   }
 *
 * HARD INVARIANTS: zero runtime deps (node: builtins + relative imports only —
 * lint/validate-manager-zerodep.mjs enforces this); FAIL-CLOSED (any error that
 * prevents scanning the candidate degrades to a SAFE `{ verdict:'flagged',
 * findings:[<needs-review note>] }`, never a throw — an unscannable untrusted
 * candidate must not pass the gate); STATIC read only (the candidate is never
 * executed, sourced, imported, or evaluated).
 *
 * @module manager/lib/scan-resource-safety
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} SafetyFinding
 * @property {string} rule      Signature id that matched (e.g. "network-egress").
 * @property {'low'|'medium'|'high'} severity
 * @property {string} path      Candidate-relative path of the matched file.
 * @property {number|null} line 1-based line of the match (null when file-level).
 * @property {string} evidence  The quoted offending code (truncated).
 * @property {string} message   Human-readable explanation of the signature.
 *
 * @typedef {Object} SafetyResult
 * @property {'clean'|'flagged'} verdict
 * @property {SafetyFinding[]} findings
 */

/** Max evidence length kept per finding (avoid echoing a whole minified blob). */
const EVIDENCE_MAX = 200;

/**
 * File extensions treated as EXECUTABLE script code (the only files we scan).
 * Includes JS/TS-family + shell, AND common standalone-interpreter source kinds
 * (`.py` `.rb` `.pl` `.php` `.lua` `.ps1`). The interpreter kinds matter for the
 * source-wide walk: such a file is real executable code whether or not it carries a
 * `#!` shebang (it is usually run as `python evil.py`, with no shebang), so it MUST be
 * code-scanned by extension — the existing rules (network-egress, process-exec,
 * secret-access, obfuscation) already match python urllib / os.system / socket etc.
 * textually. Shebang-peeking ({@link isCodeFile}) still covers EXTENSION-LESS files.
 */
const CODE_EXT = new Set([
  '.mjs', '.js', '.cjs', '.sh', '.bash', '.zsh', '.ts', '.mts', '.cts',
  '.py', '.rb', '.pl', '.php', '.lua', '.ps1',
]);

/** Plain-text / prose kinds explicitly OUT of scope (this scanner is for code). */
const TEXT_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml']);

/**
 * Directory basenames pruned wherever they appear (mirrors walk.mjs). Avoids
 * scanning vendored/VCS noise inside a staging dir.
 * @type {Set<string>}
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.forge']);

/**
 * A single line-level rule. `re` is matched per line; `severity` may be a function
 * `(matchText, fullLine) => 'low'|'medium'|'high'` for context-sensitive scoring.
 * @typedef {Object} LineRule
 * @property {string} rule
 * @property {RegExp} re
 * @property {'low'|'medium'|'high'|((m:string,line:string)=>'low'|'medium'|'high')} severity
 * @property {string} message
 */

/**
 * Token / regex signatures evaluated against each (non-comment-stripped) line of a
 * code file. Each `re` carries the `g` flag so a line can yield multiple distinct
 * findings, and we read the actual matched substring as evidence. Patterns are kept
 * deliberately literal/anchored to the documented tokens to stay deterministic.
 * @type {LineRule[]}
 */
const RULES = [
  // ── network-egress (medium) ──────────────────────────────────────────────
  {
    rule: 'network-egress',
    re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bhttps?\b\s*\.\s*request\s*\(|\bnet\s*\.\s*connect\s*\(|\bdns\s*\.\s*\w+\s*\(|(?:^|[\s;&|`$(])(?:curl|wget|nc|ncat|socat|telnet)\b/g,
    severity: 'medium',
    message:
      'network egress from a local-only artifact (fetch / XMLHttpRequest / http(s).request / net.connect / dns / curl / wget / nc / ncat / socat / telnet) — possible data exfiltration or C2 callback.',
  },

  // ── network-egress (medium): interpreter / reverse-shell egress ────────────
  // python/python3/perl/ruby/node invoked with -c/-e/-mhttp.server running network
  // code, bash /dev/tcp/ reverse shells, and `import socket`/`urllib`/`requests`
  // network use inside an embedded interpreter string.
  {
    rule: 'network-egress',
    re: /(?:^|[\s;&|`$(])(?:python3?|perl|ruby|node)\b[^\n]*?(?:-c|-e|-m)\b[^\n]*?(?:socket|urllib|urllib2|requests|httplib|http\.client|http\.server|Net::|Socket|net\/http|require\s*\(\s*[`'"](?:http|https|net|dgram)[`'"]|fetch\s*\()/g,
    severity: 'medium',
    message:
      'interpreter network egress (python/perl/ruby/node -c|-e|-m running socket/urllib/requests/http network code) — embedded exfiltration or callback.',
  },
  {
    rule: 'network-egress',
    re: /\/dev\/tcp\/[^\s/]+\/\d+|\/dev\/udp\/[^\s/]+\/\d+|\bexec\s+\d*\s*<>\s*\/dev\/(?:tcp|udp)\//g,
    severity: 'medium',
    message:
      'bash /dev/tcp or /dev/udp network socket (reverse shell / bind shell) — direct C2 channel.',
  },
  // python/perl/ruby/node *source* that opens a network connection (not only via -c):
  // import socket / socket.socket(...) / urllib.request / requests.get|post / TCPSocket.
  {
    rule: 'network-egress',
    re: /\bsocket\s*\.\s*socket\s*\(|\bimport\s+socket\b|\burllib\s*\.\s*request\b|\burllib2\b|\brequests\s*\.\s*(?:get|post|put|patch|request)\s*\(|\bhttp\.client\b|\bTCPSocket\s*\.\s*(?:new|open)\b|\bNet::HTTP\b/g,
    severity: 'medium',
    message:
      'python/ruby network primitive (socket.socket / import socket / urllib.request / requests.get|post / http.client / TCPSocket / Net::HTTP) — outbound network egress.',
  },

  // ── process-exec (high) ──────────────────────────────────────────────────
  {
    rule: 'process-exec',
    re: /\bchild_process\b|\bexec(?:Sync|File|FileSync)?\s*\(|\bspawn(?:Sync)?\s*\(|\bfork\s*\(|\beval\s*\(|\bnew\s+Function\s*\(|\bvm\s*\.\s*runIn\w*/g,
    severity: 'high',
    message:
      'dynamic code / shell execution (child_process / exec / spawn / fork / eval / new Function / vm.runIn*) — arbitrary command execution.',
  },
  // ── process-exec (high): interpreter-language shell/exec primitives ────────
  // python os.system/os.popen/subprocess.*/Popen, ruby/perl backticks-via-system,
  // python eval()/exec(), php system/exec/shell_exec/passthru/proc_open, and
  // PowerShell Invoke-Expression/iex. These are the .py/.rb/.pl/.php/.ps1 analogues
  // of child_process — now reachable because interpreter sources are code-scanned.
  {
    rule: 'process-exec',
    re: /\bos\s*\.\s*(?:system|popen|execv?[lpe]*)\s*\(|\bsubprocess\s*\.\s*(?:run|call|check_call|check_output|Popen)\s*\(|\bPopen\s*\(|\bcommands\s*\.\s*getoutput\s*\(|\b(?:shell_exec|passthru|proc_open|popen|pcntl_exec)\s*\(|\bInvoke-Expression\b|(?:^|[\s;|&(])iex\b/g,
    severity: 'high',
    message:
      'interpreter shell/exec primitive (python os.system/os.popen/subprocess/Popen, php shell_exec/passthru/proc_open, PowerShell Invoke-Expression) — arbitrary command execution.',
  },

  // ── fs-danger (medium): destructive fs op with an absolute or ~ path ──────
  {
    rule: 'fs-danger',
    re: /\b(?:fs\s*\.\s*(?:promises\s*\.\s*)?)?(?:writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(\s*[`'"]\s*(?:\/|~)[^`'"]*/g,
    severity: 'medium',
    message:
      'destructive / out-of-scope filesystem write or delete targeting an absolute or ~ path (write/append/rm/unlink/rmdir).',
  },
  {
    rule: 'fs-danger',
    re: /\brimraf\b|>\s*(?:\/|~)[^\s;|&]+/g,
    severity: 'medium',
    message:
      'destructive filesystem operation (rimraf, or shell redirection > to an absolute/~ path) — possible out-of-scope overwrite/delete.',
  },

  // ── secret-access ────────────────────────────────────────────────────────
  {
    rule: 'secret-access',
    // process.env.<NAME> or process.env['NAME']; severity escalates on token-ish names.
    re: /\bprocess\s*\.\s*env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*[`'"]([^`'"]+)[`'"]\s*\])?/g,
    severity: (m) => (/(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|API)/i.test(m) ? 'high' : 'low'),
    message:
      'environment variable read (process.env) — credential / secret harvest when the name is token/key/secret/password-shaped; a bare read is informational.',
  },
  {
    rule: 'secret-access',
    // Interpreter env reads: python os.environ[..]/os.environ.get(..)/os.getenv(..),
    // ruby ENV[..], php getenv(..)/$_ENV[..]. Severity escalates on token-ish names
    // (mirrors the process.env rule); a bare read is informational (low).
    // Quote glyphs in the char-classes are written as hex escapes (\x60 backtick,
    // \x27 single, \x22 double) so the zerodep validator's regex-unaware string masker
    // sees no literal quote toggles here — matches the same three quote characters.
    re: /\bos\s*\.\s*environ\s*(?:\[\s*[\x60\x27\x22]([^\x60\x27\x22]+)[\x60\x27\x22]\s*\]|\.\s*get\s*\(\s*[\x60\x27\x22]([^\x60\x27\x22]+)[\x60\x27\x22])|\bos\s*\.\s*getenv\s*\(\s*[\x60\x27\x22]([^\x60\x27\x22]+)[\x60\x27\x22]|\bENV\s*\[\s*[\x60\x27\x22]([^\x60\x27\x22]+)[\x60\x27\x22]\s*\]|\bgetenv\s*\(\s*[\x60\x27\x22]([^\x60\x27\x22]+)[\x60\x27\x22]|\$_ENV\s*\[\s*[\x60\x27\x22]([^\x60\x27\x22]+)[\x60\x27\x22]\s*\]/g,
    severity: (m) => (/(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|API)/i.test(m) ? 'high' : 'low'),
    message:
      'interpreter environment-variable read (os.environ / os.getenv / ENV[…] / getenv / $_ENV) — credential / secret harvest when the name is token/key/secret/password-shaped; a bare read is informational.',
  },
  {
    rule: 'secret-access',
    re: /~\/\.ssh\b|~\/\.aws\b|\b\.npmrc\b|\/etc\/passwd\b|\bkeychain\b|\bsecurity\s+find-(?:generic|internet)-password\b/g,
    severity: 'high',
    message:
      'credential-store access (~/.ssh, ~/.aws, .npmrc, /etc/passwd, keychain) — secret harvest.',
  },

  // ── forge-bypass (medium) ────────────────────────────────────────────────
  {
    rule: 'forge-bypass',
    re: /--no-verify\b|\bcore\.hooksPath\b|\bhooksPath\b|--no-hooks\b|\bHUSKY=0\b|\bchmod\s+\+x\b/g,
    severity: 'medium',
    message:
      'forge / git hook bypass or detection-evasion (--no-verify, core.hooksPath, disabling hooks, chmod +x) — tampering with the safety gate.',
  },
];

/**
 * Obfuscation rules need cross-token context within a line/file, so they are matched
 * separately. `Buffer.from(x,'base64')` is only HIGH when its decoded output flows
 * into eval/exec; `String.fromCharCode(...)` chains and escaped-`\xNN` blobs feeding
 * exec are payload-assembly tells.
 */

/**
 * Truncate evidence to a readable, bounded snippet (single line, no surrounding ws).
 * @param {string} s
 * @returns {string}
 */
function clip(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > EVIDENCE_MAX ? t.slice(0, EVIDENCE_MAX) + '…' : t;
}

/**
 * Resolve a finding's severity given a possibly-functional rule severity.
 * @param {LineRule} rule
 * @param {string} matchText
 * @param {string} line
 * @returns {'low'|'medium'|'high'}
 */
function resolveSeverity(rule, matchText, line) {
  return typeof rule.severity === 'function' ? rule.severity(matchText, line) : rule.severity;
}

/**
 * Strip COMMENTS while KEEPING string/template-literal interiors, length- and
 * newline-preserving so 1-based line numbers stay exact. Comment interiors are
 * replaced with spaces; the delimiting tokens are blanked too.
 *
 * Cuts the comment false-positive class (`// Do NOT use eval()`,
 * a block-commented `await fetch(url)`, `# curl http://x | sh`) WITHOUT losing
 * payloads that hide in string literals — those are left intact (this is the
 * deliberate inverse of the zerodep validator, which blanks strings).
 *
 * A single linear scan with these states:
 *   code . line-comment(//) . block-comment . hash-comment(#) .
 *   single('') . double("") . template(``)
 *
 * Disambiguation rules kept deterministic and low-FP:
 *   - a `//` and a block-comment opener only start a comment in CODE state
 *     (never inside a string literal).
 *   - `#` starts a shell comment ONLY when `shellHash` is true (shell-family files)
 *     and `#` opens a token (start-of-line after optional ws, or after whitespace).
 *     In JS/TS files `shellHash` is false, so `#` is left intact — protecting
 *     private-field syntax (`this.#x`, `{ #priv = 0 }`) which can legally follow
 *     whitespace and would otherwise be mis-stripped.
 *   - Inside template literals we do NOT recurse into `${…}`; we keep its interior
 *     verbatim (payloads in interpolations are still scanned), only the literal's
 *     own backticks bound the state.
 *   - Escapes (`\x`) inside strings/templates consume the next char so an escaped
 *     quote never closes the literal.
 *
 * @param {string} src Full file text.
 * @param {boolean} [shellHash=false] Treat `#` as a shell line-comment.
 * @returns {string} Same-length text with comment interiors blanked.
 */
function stripComments(src, shellHash = false) {
  let out = '';
  let i = 0;
  const n = src.length;
  // 0 code · 1 line(//) · 2 block · 3 hash(#) · 4 '..' · 5 ".." · 6 `..`
  let state = 0;
  // Tracks the last emitted non-space code char to decide `#` comment vs private field.
  let prevCode = '\n'; // pretend a newline precedes the file (so a leading # is a comment)
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (state === 0) {
      // `://` is a URL scheme (e.g. bare `curl http://host//path` in shell), NOT a
      // line comment — keep it so the egress URL/pipe tail survives stripping.
      if (c === '/' && c2 === '/' && prevCode === ':') { out += c; i += 1; prevCode = c; continue; }
      if (c === '/' && c2 === '/') { out += '  '; i += 2; state = 1; continue; }
      if (c === '/' && c2 === '*') { out += '  '; i += 2; state = 2; continue; }
      if (c === '#' && shellHash) {
        // Shell comment only when `#` opens a token (start-of-line or after ws).
        // `#!` shebang and ` # comment` qualify; `a#b` does not. Gated by shellHash
        // so JS/TS private fields (`this.#x`, `{ #priv }`) are never stripped.
        const atLineStart = prevCode === '\n' || prevCode === '';
        const afterWs = prevCode === ' ' || prevCode === '\t';
        if (atLineStart || afterWs) { out += ' '; i += 1; state = 3; continue; }
        out += c; i += 1; prevCode = c; continue;
      }
      if (c === "'") { out += c; i += 1; state = 4; prevCode = c; continue; }
      if (c === '"') { out += c; i += 1; state = 5; prevCode = c; continue; }
      if (c === '`') { out += c; i += 1; state = 6; prevCode = c; continue; }
      out += c; i += 1;
      // Remember the last code char for the next `#` decision (newlines reset it).
      prevCode = c === '\r' ? prevCode : c;
      continue;
    }
    if (state === 1 || state === 3) { // line (//) or hash (#) comment
      if (c === '\n') { out += '\n'; i += 1; state = 0; prevCode = '\n'; continue; }
      out += ' '; i += 1; continue;
    }
    if (state === 2) { // block comment
      if (c === '*' && c2 === '/') { out += '  '; i += 2; state = 0; prevCode = ' '; continue; }
      out += (c === '\n' ? '\n' : ' '); i += 1; continue;
    }
    // string / template interiors (states 4,5,6) — KEPT verbatim
    const quote = state === 4 ? "'" : state === 5 ? '"' : '`';
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; } // keep escape pair
    if (c === quote) { out += c; i += 1; state = 0; prevCode = c; continue; }
    out += c; i += 1; // payload bytes inside the string are preserved
    continue;
  }
  return out;
}

/**
 * Scan obfuscation signatures over one file's full text. Emits HIGH findings only
 * when the decode/assembly actually feeds an executor (eval/exec/Function/spawn) —
 * otherwise a benign base64 decode would false-positive.
 *
 * @param {string} content Full file text.
 * @param {string[]} lines Pre-split lines (1-based via index+1).
 * @param {string} relPath Candidate-relative path.
 * @param {SafetyFinding[]} out Accumulator (mutated).
 */
function scanObfuscation(content, lines, relPath, out) {
  // Does this file execute anything at all? (gates the "→ exec" escalation)
  const EXEC_SINK = /\beval\s*\(|\bnew\s+Function\s*\(|\bexec(?:Sync|File|FileSync)?\s*\(|\bspawn(?:Sync)?\s*\(|\bvm\s*\.\s*runIn\w*|\|\s*(?:sh|bash|node)\b/;
  const fileHasSink = EXEC_SINK.test(content);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // base64 decode → only flag when an exec sink exists in the file.
    const b64 = /Buffer\s*\.\s*from\s*\([^)]*?[`'"]base64[`'"]\s*\)/g;
    let m;
    while ((m = b64.exec(line)) !== null) {
      // Escalate to HIGH when the decode flows to an executor (same line OR file sink).
      const sameLineSink = EXEC_SINK.test(line);
      out.push({
        rule: 'obfuscation',
        severity: sameLineSink || fileHasSink ? 'high' : 'medium',
        path: relPath,
        line: i + 1,
        evidence: clip(m[0]),
        message:
          'base64-decoded payload' +
          (sameLineSink || fileHasSink
            ? ' feeding an executor (eval/exec/Function/spawn/| sh) — hidden-payload execution.'
            : ' (Buffer.from(…,"base64")) — possible obfuscated payload.'),
      });
    }

    // atob(...) base64 decode & decodeURIComponent(...) — only flag as obfuscation
    // when an exec sink exists (otherwise a benign decode would false-positive).
    const decode = /\batob\s*\(|\bdecodeURIComponent\s*\(|\bunescape\s*\(/g;
    while ((m = decode.exec(line)) !== null) {
      const sameLineSink = EXEC_SINK.test(line);
      if (!sameLineSink && !fileHasSink) continue; // benign decode — do not flag
      out.push({
        rule: 'obfuscation',
        severity: 'high',
        path: relPath,
        line: i + 1,
        evidence: clip(m[0]),
        message:
          'decoded payload (atob / decodeURIComponent / unescape) feeding an executor (eval/exec/Function/spawn/| sh) — hidden-payload execution.',
      });
    }

    // String.fromCharCode(...) chains — character-code payload assembly.
    const fcc = /String\s*\.\s*fromCharCode\s*\(/g;
    while ((m = fcc.exec(line)) !== null) {
      const sameLineSink = EXEC_SINK.test(line);
      out.push({
        rule: 'obfuscation',
        severity: sameLineSink || fileHasSink ? 'high' : 'medium',
        path: relPath,
        line: i + 1,
        evidence: clip(line),
        message:
          'String.fromCharCode(...) character-code assembly' +
          (sameLineSink || fileHasSink ? ' feeding an executor — hidden-payload execution.' : ' — possible obfuscated string assembly.'),
      });
    }

    // Long escaped-\xNN hex string (>=4 escapes) — escaped-hex blob assembly.
    const hexBlob = /(?:\\x[0-9a-fA-F]{2}){4,}/g;
    while ((m = hexBlob.exec(line)) !== null) {
      const sameLineSink = EXEC_SINK.test(line);
      out.push({
        rule: 'obfuscation',
        severity: sameLineSink || fileHasSink ? 'high' : 'medium',
        path: relPath,
        line: i + 1,
        evidence: clip(m[0]),
        message:
          'escaped-\\xNN hex string blob' +
          (sameLineSink || fileHasSink ? ' feeding an executor — hidden-payload execution.' : ' — possible obfuscated payload.'),
      });
    }
  }
}

/** Dangerous identifiers that, when spelled by string-concat bracket access, escalate. */
const DANGEROUS_NAMES = new Set([
  'eval', 'exec', 'execsync', 'fetch', 'function', 'spawn', 'spawnsync', 'require',
  'xmlhttprequest', 'fromcharcode', 'child_process', 'import',
]);

/**
 * Detect computed-property / string-concatenation execution evasions on a per-line
 * basis. Two tiers:
 *
 *   computed-exec (HIGH): a bracket member access `X['a'+'b'+…]` whose concatenated
 *     STRING-LITERAL pieces spell a dangerous identifier (eval/exec/fetch/Function/
 *     spawn/require/XMLHttpRequest/fromCharCode/…). Catches `globalThis['ev'+'al']`,
 *     `window['fet'+'ch']`, `String['from'+'CharCode']`, `window['XML'+'HttpRequest']`.
 *
 *   obfuscated-member-access (MEDIUM): ANY `obj['..'+'..'](…)` computed access whose
 *     key is assembled by string concatenation and which is immediately CALLED — the
 *     general concat-to-call obfuscation tell, even when the spelled name is benign
 *     or not fully recoverable.
 *
 * Only string-literal fragments are concatenated when recovering the spelled name
 * (we cannot resolve runtime variables); a `+` joining a variable is ignored for the
 * HIGH tier but still counts toward the MEDIUM "computed + concat + call" shape.
 *
 * @param {string} _content Stripped full text (unused; per-line below).
 * @param {string[]} lines  Comment-stripped lines (1-based via index+1).
 * @param {string} relPath
 * @param {SafetyFinding[]} out
 */
function scanComputedExec(_content, lines, relPath, out) {
  // Matches a computed member access whose [...] contains at least one string concat
  // (a quoted fragment followed by `+`). Capture the whole bracket interior.
  // e.g.  globalThis['ev'+'al']   String['from'+'CharCode']   o['a'+x+'b']
  const BRACKET = /\[\s*((?:[`'"][^`'"]*[`'"]|[A-Za-z_$][\w$]*)\s*\+\s*(?:[`'"][^`'"]*[`'"]|[A-Za-z_$][\w$]*)(?:\s*\+\s*(?:[`'"][^`'"]*[`'"]|[A-Za-z_$][\w$]*))*)\s*\]/g;
  const FRAG = /[`'"]([^`'"]*)[`'"]/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('[') === -1 || line.indexOf('+') === -1) continue;
    BRACKET.lastIndex = 0;
    let m;
    while ((m = BRACKET.exec(line)) !== null) {
      const interior = m[1];
      // Recover the concatenated spelled name from STRING fragments only.
      FRAG.lastIndex = 0;
      let spelled = '';
      let f;
      while ((f = FRAG.exec(interior)) !== null) spelled += f[1];
      const spelledNorm = spelled.toLowerCase();

      // Is this computed access immediately CALLED?  X[...](  OR  X[...]`  (tagged)
      const after = line.slice(m.index + m[0].length);
      const isCalled = /^\s*[`(]/.test(after);

      if (spelledNorm && DANGEROUS_NAMES.has(spelledNorm)) {
        out.push({
          rule: 'computed-exec',
          severity: 'high',
          path: relPath,
          line: i + 1,
          evidence: clip(m[0]),
          message:
            `computed member access spelling a dangerous identifier ("${spelled}") via string concatenation — token-splitting execution evasion (eval/exec/fetch/Function/spawn/require/XMLHttpRequest/fromCharCode).`,
        });
        continue; // already the stronger finding; skip the medium tier for this match
      }

      if (isCalled) {
        out.push({
          rule: 'obfuscated-member-access',
          severity: 'medium',
          path: relPath,
          line: i + 1,
          evidence: clip(m[0] + after.slice(0, 1)),
          message:
            'obfuscated computed member access built from string concatenation feeding a call (obj["a"+"b"](…)) — possible token-splitting obfuscation.',
        });
      }
    }
  }
}

/**
 * Detect a curl/wget download whose pipe-to-shell lands on a LATER line — the
 * multi-line `curl …\n  | sh` evasion (line continuation `\` or a bare newline
 * before `| sh`). We look for a downloader line, then tolerate intervening blank /
 * whitespace / continuation lines until the next non-empty line; if that line
 * STARTS with a pipe into a shell interpreter, flag it.
 *
 * The single-line `curl … | sh` form is already caught (network-egress + obfuscation
 * sink); this covers only the split-across-lines variant that line-by-line matching
 * would otherwise miss.
 *
 * @param {string} _content Stripped full text (unused).
 * @param {string[]} lines  Comment-stripped lines.
 * @param {string} relPath
 * @param {SafetyFinding[]} out
 */
function scanMultilineShellEgress(_content, lines, relPath, out) {
  const DOWNLOADER = /(?:^|[\s;&|`$(])(?:curl|wget|fetch)\b/;
  const PIPE_TO_SHELL = /^\s*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python3?|perl|ruby|node)\b/;
  // A line already containing its own `| sh` is the single-line case (handled elsewhere).
  const HAS_INLINE_PIPE_SHELL = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python3?|perl|ruby|node)\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!DOWNLOADER.test(line)) continue;
    if (HAS_INLINE_PIPE_SHELL.test(line)) continue; // single-line form, not our case

    // Walk forward over continuation / blank / pure-whitespace lines to the next
    // line that carries content; if it opens with a pipe-to-shell, it's the split form.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      const trimmed = next.trim();
      // Skip the current downloader's trailing `\` continuation and empty lines.
      if (trimmed === '' || trimmed === '\\') continue;
      if (PIPE_TO_SHELL.test(next)) {
        out.push({
          rule: 'network-egress',
          severity: 'medium',
          path: relPath,
          line: i + 1,
          evidence: clip(line + ' ' + trimmed),
          message:
            'multi-line download-and-execute: a curl/wget/fetch download piped to a shell interpreter on a following line (curl …\\n | sh) — remote-code execution via split pipeline.',
        });
      }
      break; // only inspect the FIRST content line after the downloader
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// MCP / JSON COMMAND SCANNING
// ───────────────────────────────────────────────────────────────────────────
// A `.json` file is otherwise PROSE (out of CODE_EXT scope), but an MCP server
// config embeds an executable launch spec: `{ command, args }`. A malicious catalog
// resource can ship an `mcpServers` block whose command/args spell a download-and-
// execute, a base64-decode-then-shell, or a `child_process`/eval payload. We parse
// the JSON as UNTRUSTED DATA (JSON.parse only — never executed), pull out every
// server's command + args STRINGS, and run the same dangerous-shell patterns we use
// for code. A benign config (command "node", args ["server.js"]) stays clean.

/**
 * Dangerous-command signatures for MCP command/args strings. Each emits a HIGH
 * `mcp-command` finding. Mirrors the shell/exec danger classes used elsewhere
 * (sh/bash/python -c, curl|wget|nc egress, pipe-to-shell, base64-decode-then-exec,
 * eval / child_process-like execution).
 * @type {Array<{re: RegExp, why: string}>}
 */
const MCP_DANGER_PATTERNS = [
  {
    // sh/bash/zsh/python/perl/ruby/node invoked with an inline -c / -e program.
    re: /\b(?:sh|bash|zsh|dash|ksh|python3?|perl|ruby|node|deno|bun)\b[\s\S]*?(?:^|\s)-(?:c|e)\b/i,
    why: 'an interpreter run with an inline -c/-e program (sh/bash/python -c …) — arbitrary command execution',
  },
  {
    // network downloaders / netcat egress.
    re: /\b(?:curl|wget|nc|ncat|socat|telnet)\b/i,
    why: 'a network downloader / netcat (curl/wget/nc/…) — remote fetch or C2 egress',
  },
  {
    // pipe into a shell interpreter (download-and-execute primitive).
    re: /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python3?|perl|ruby|node)\b/i,
    why: 'a pipe into a shell interpreter (… | sh/bash) — download-and-execute',
  },
  {
    // base64 decode then execute (… | base64 -d | sh, base64 --decode | bash).
    re: /\bbase64\b[\s\S]*?(?:-d|--decode)\b|\b(?:atob)\s*\(/i,
    why: 'a base64 decode (base64 -d / atob) — typically decode-then-execute of a hidden payload',
  },
  {
    // eval / child_process / exec / spawn / new Function — dynamic execution.
    re: /\beval\s*\(|\bchild_process\b|\bexec(?:Sync|File|FileSync)?\s*\(|\bspawn(?:Sync)?\s*\(|\bnew\s+Function\s*\(/i,
    why: 'dynamic code / shell execution (eval / child_process / exec / spawn / new Function)',
  },
  {
    // bash /dev/tcp reverse shell.
    re: /\/dev\/(?:tcp|udp)\/[^\s/]+\/\d+/i,
    why: 'a bash /dev/tcp|udp socket — reverse/bind shell C2 channel',
  },
];

/**
 * If `content` is a JSON MCP config, scan each server's `command` + `args` strings
 * for dangerous-shell payloads and append HIGH `mcp-command` findings. No-op when
 * the JSON does not parse or carries no MCP/command shape (returns silently — the
 * caller handles the benign case). Treats the JSON purely as DATA (JSON.parse only).
 *
 * Recognised shapes:
 *   { "mcpServers": { "<name>": { "command": "...", "args": [ ... ] }, ... } }
 *   { "command": "...", "args": [ ... ] }            (top-level launch spec)
 *
 * @param {string} content  Full JSON file text.
 * @param {string} relPath  Candidate-relative path (for finding.path).
 * @param {SafetyFinding[]} out Accumulator (mutated).
 * @returns {boolean} true if the file was a recognised MCP/command JSON (handled).
 */
function scanMcpJson(content, relPath, out) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false; // not valid JSON — nothing MCP-shaped to scan
  }
  if (!parsed || typeof parsed !== 'object') return false;

  /** @type {Array<{name: string, command: unknown, args: unknown}>} */
  const servers = [];
  const mcp = /** @type {any} */ (parsed).mcpServers;
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
    for (const name of Object.keys(mcp)) {
      const s = mcp[name];
      if (s && typeof s === 'object') servers.push({ name, command: s.command, args: s.args });
    }
  }
  // Top-level launch spec (command/args at the root).
  const root = /** @type {any} */ (parsed);
  if ('command' in root || 'args' in root) {
    servers.push({ name: '<root>', command: root.command, args: root.args });
  }

  if (servers.length === 0) return false; // not an MCP/command config

  for (const { name, command, args } of servers) {
    // Collect every scannable string: the command + each string arg.
    /** @type {string[]} */
    const strings = [];
    if (typeof command === 'string') strings.push(command);
    if (Array.isArray(args)) {
      for (const a of args) if (typeof a === 'string') strings.push(a);
    }
    // Also scan the full command line (command + args joined) so a payload that is
    // split across args (e.g. ["-c", "curl … | base64 -d | bash"]) still matches a
    // pattern that spans the boundary.
    const joined = strings.join(' ');
    const haystacks = strings.length ? [...strings, joined] : [];

    const firedHere = new Set();
    for (const pat of MCP_DANGER_PATTERNS) {
      if (firedHere.has(pat.why)) continue;
      for (const h of haystacks) {
        pat.re.lastIndex = 0;
        if (pat.re.test(h)) {
          firedHere.add(pat.why);
          out.push({
            rule: 'mcp-command',
            severity: 'high',
            path: relPath,
            line: null,
            evidence: clip(`${typeof command === 'string' ? command : ''} ${Array.isArray(args) ? args.join(' ') : ''}`.trim()),
            message: `MCP server "${name}" launch command contains ${pat.why} — an executable payload in an MCP config.`,
          });
          break;
        }
      }
    }
  }
  return true;
}

/**
 * Scan a single CODE file's text and append every matched signature to `out`.
 * STATIC ONLY — the text is read, never executed (ADR-0017 §5a).
 *
 * @param {string} content Full file text.
 * @param {string} relPath Candidate-relative path (for finding.path).
 * @param {SafetyFinding[]} out Accumulator (mutated).
 * @param {boolean} shellHash Treat `#` as a shell line-comment (shell-family files).
 */
function scanCodeText(content, relPath, out, shellHash) {
  // Blank comment interiors (KEEP string literals) BEFORE any matching so that a
  // commented-out `// eval()` / a block-commented `fetch()` / `# curl | sh` no
  // longer flags. Length- and newline-preserving, so line numbers below stay exact.
  const stripped = stripComments(content, shellHash);
  const lines = stripped.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const matchText = m[0];
        out.push({
          rule: rule.rule,
          severity: resolveSeverity(rule, matchText, line),
          path: relPath,
          line: i + 1,
          evidence: clip(matchText),
          message: rule.message,
        });
        // Guard against zero-width matches looping forever.
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
      }
    }
  }

  scanComputedExec(stripped, lines, relPath, out);
  scanMultilineShellEgress(stripped, lines, relPath, out);
  scanObfuscation(stripped, lines, relPath, out);
}

/**
 * Decide whether a path is an executable CODE file we should scan. A file is code
 * if its extension is in {@link CODE_EXT} (JS/TS, shell, AND interpreter source kinds
 * like `.py/.rb/.pl/.php/.lua/.ps1` — these are scanned by EXTENSION so a NO-SHEBANG
 * interpreter source is still code-scanned in the source-wide walk), OR (when it has
 * no/unknown extension) it begins with a `#!` shebang. Known text/prose extensions
 * (`.md/.txt/.json/…`) are explicitly excluded — prose stays out of code-scanning.
 *
 * @param {string} absPath Absolute file path.
 * @returns {boolean}
 */
function isCodeFile(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (CODE_EXT.has(ext)) return true;
  if (TEXT_EXT.has(ext)) return false;
  // Unknown / no extension: peek at the first bytes for a shebang (static read).
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(2);
      const n = fs.readSync(fd, buf, 0, 2, 0);
      return n >= 2 && buf[0] === 0x23 && buf[1] === 0x21; // "#!"
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false; // unreadable — fail-open, treat as not-code
  }
}

/** JS/TS-family extensions where `#` is a private-field sigil, never a comment. */
const JS_FAMILY_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);

/**
 * Extensions whose language uses `#` as a line-comment start (so a `# dangerous`
 * comment is correctly stripped before matching, instead of false-positiving).
 * Shell family + the `#`-comment interpreter kinds (python/ruby/perl/php/powershell).
 * NOTE: `.lua` is intentionally NOT here — Lua comments are `--`, and `#` is the
 * length operator; treating it as a comment would wrongly blank line tails. A Lua
 * payload still scans because string interiors are kept.
 * @type {Set<string>}
 */
const HASH_COMMENT_EXT = new Set(['.sh', '.bash', '.zsh', '.py', '.rb', '.pl', '.php', '.ps1']);

/**
 * Decide whether `#` should be treated as a line-comment start for this file. TRUE
 * for shell-family files (`.sh/.bash/.zsh`) and `#`-comment interpreter kinds
 * (`.py/.rb/.pl/.php/.ps1`), and for no-/unknown-extension files whose shebang names
 * a non-node interpreter. FALSE for JS/TS-family files, where `#` is a private-field
 * sigil (`this.#x`) that must NOT be stripped.
 *
 * @param {string} absPath
 * @param {string} content Already-read file text (avoids a second read).
 * @returns {boolean}
 */
function usesHashComments(absPath, content) {
  const ext = path.extname(absPath).toLowerCase();
  if (JS_FAMILY_EXT.has(ext)) return false;
  if (HASH_COMMENT_EXT.has(ext)) return true;
  // No/unknown extension: a shell shebang means `#` comments; a node shebang means JS.
  const firstLine = content.slice(0, 200).split(/\r?\n/, 1)[0] || '';
  if (/^#!.*\b(?:node|deno|bun)\b/.test(firstLine)) return false;
  if (/^#!/.test(firstLine)) return true; // any other shebang (sh/bash/python/…) — # comments
  return false; // default: treat `#` literally (safer than over-stripping JS)
}

/**
 * Recursively collect candidate CODE files under a directory (absolute paths),
 * pruning {@link SKIP_DIRS}. Fail-open: an unreadable dir/stat is skipped.
 * @param {string} dir
 * @param {string[]} out
 */
function collectCode(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let isDir = false;
    let isFile = false;
    try {
      if (ent.isSymbolicLink()) {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } else {
        isDir = ent.isDirectory();
        isFile = ent.isFile();
      }
    } catch {
      continue;
    }
    if (isDir) {
      if (SKIP_DIRS.has(ent.name)) continue;
      collectCode(full, out);
    } else if (isFile) {
      out.push(full);
    }
  }
}

/**
 * Statically scan a single EXECUTABLE candidate resource for dangerous-code
 * signatures. The candidate is treated as UNTRUSTED DATA and its code is NEVER run
 * (ADR-0017 §5a; rules/prompt-defense-baseline.md) — only read + pattern-matched.
 *
 * `candidatePath` may be a single file OR a staging directory; a directory is walked
 * for code files. Plain-text / prose kinds (`.md`, agents/rules) are NOT scanned
 * here (this scanner is for CODE) and contribute no findings → `clean`.
 *
 * VERDICT: `flagged` if any finding is high OR medium; otherwise `clean`.
 * FAIL-CLOSED: any error that prevents scanning the candidate (no/empty path, stat
 * failure, non-file/non-dir, or a top-level throw) degrades to a SAFE
 * `{ verdict:'flagged', findings:[<needs-review note>] }` — an unscannable untrusted
 * candidate must not pass the gate. (A successfully-scanned, signature-free candidate
 * is still `clean`.)
 *
 * @param {string} candidatePath Absolute path to the candidate file or staging dir.
 * @returns {SafetyResult}
 */
export function scanResourceSafety(candidatePath) {
  try {
    if (typeof candidatePath !== 'string' || candidatePath.length === 0) {
      return {
        verdict: 'flagged',
        findings: [
          {
            rule: 'needs-review',
            severity: 'medium',
            path: '',
            line: null,
            evidence: '',
            message: 'scan-resource-safety received no candidate path — could not scan; an unscannable candidate is flagged for review (fail-closed).',
          },
        ],
      };
    }

    let stat;
    try {
      stat = fs.statSync(candidatePath);
    } catch (e) {
      // Non-existent / unstattable path — fail-CLOSED: cannot scan, flag for review.
      return {
        verdict: 'flagged',
        findings: [
          {
            rule: 'needs-review',
            severity: 'medium',
            path: candidatePath,
            line: null,
            evidence: '',
            message: `scan-resource-safety could not stat candidate (${e && e.message ? e.message : String(e)}) — could not scan; flagged for review (fail-closed).`,
          },
        ],
      };
    }

    /** @type {string[]} */
    const files = [];
    /** @type {string} */
    let base;
    if (stat.isDirectory()) {
      base = path.resolve(candidatePath);
      collectCode(base, files);
    } else if (stat.isFile()) {
      base = path.dirname(path.resolve(candidatePath));
      files.push(path.resolve(candidatePath));
    } else {
      // Neither a regular file nor a directory (socket/fifo/…) — fail-CLOSED.
      return {
        verdict: 'flagged',
        findings: [
          {
            rule: 'needs-review',
            severity: 'medium',
            path: candidatePath,
            line: null,
            evidence: '',
            message: 'scan-resource-safety candidate is neither a regular file nor a directory — could not scan; flagged for review (fail-closed).',
          },
        ],
      };
    }

    /** @type {SafetyFinding[]} */
    const findings = [];

    for (const abs of files) {
      const ext = path.extname(abs).toLowerCase();
      const isJson = ext === '.json';
      // Scan CODE files and `.json` (for an embedded MCP command/args launch spec);
      // other prose kinds (.md, .yaml, …) remain out of scope.
      if (!isJson && !isCodeFile(abs)) continue; // plain-text / prose kinds are out of scope
      let content;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        // FAIL-CLOSED: a code/JSON candidate file we cannot read is unscannable — an
        // untrusted file we could not inspect must not silently pass; flag for review.
        findings.push({
          rule: 'needs-review',
          severity: 'medium',
          path: toPosix(path.relative(base, abs)) || path.basename(abs),
          line: null,
          evidence: '',
          message: 'scan-resource-safety could not read a candidate file — could not scan it; flagged for review (fail-closed).',
        });
        continue;
      }
      content = content.replace(/^\uFEFF/, '');
      const relPath = toPosix(path.relative(base, abs)) || path.basename(abs);
      if (isJson) {
        // JSON is prose EXCEPT for an embedded MCP launch spec — scan its command/args
        // strings for dangerous-shell payloads. A non-MCP / benign JSON is a no-op.
        scanMcpJson(content, relPath, findings);
        continue;
      }
      // `#` is a COMMENT only in shell-family files; in JS/TS it is a private-field
      // sigil (`this.#x`, `{ #priv = 0 }`) and must NEVER be stripped.
      scanCodeText(content, relPath, findings, usesHashComments(abs, content));
    }

    // Deterministic order: by path, then line, then rule.
    findings.sort(
      (a, b) =>
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        (a.line || 0) - (b.line || 0) ||
        (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
    );

    const flagged = findings.some((f) => f.severity === 'high' || f.severity === 'medium');
    return { verdict: flagged ? 'flagged' : 'clean', findings };
  } catch (e) {
    // FAIL-CLOSED: a torn input never crashes the admission pipeline, but an
    // unscannable untrusted candidate must NOT pass — it is flagged for review.
    return {
      verdict: 'flagged',
      findings: [
        {
          rule: 'needs-review',
          severity: 'medium',
          path: typeof candidatePath === 'string' ? candidatePath : '',
          line: null,
          evidence: '',
          message: `scan-resource-safety failed (${e && e.message ? e.message : String(e)}) — could not scan; flagged for review (fail-closed); never throws.`,
        },
      ],
    };
  }
}

/**
 * Normalise a path to POSIX-style forward slashes for stable, OS-independent
 * `path` values on findings.
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

export default { scanResourceSafety };
