// @ts-check
/**
 * json-out — the single `--json` envelope writer (C3) for the manager
 * (ADR-0004, SPEC-09 §"The --json envelope"). Exactly ONE function shapes every
 * machine-readable command's output, so `validate`/`doctor`/`status`/`registry`/…
 * all emit byte-identical structure: one writer ⇒ one shape (BR-CLI-004).
 *
 * The envelope (C3):
 *   { forge:    '0.1.0-design',          // forgeVersion() — the raw VERSION string
 *     command:  'validate',              // the invoked command/group
 *     ok:       true,                    // computed by the caller (summary.errors===0
 *                                        //   AND no failed/errored child)
 *     ts:       '2026-06-05T12:00:00Z',  // ISO-8601, this runtime's clock
 *     data:     { ... },                 // the ONLY command-specific payload
 *     findings: [ ...Finding (C2)... ],
 *     summary:  { errors, warnings, info, ...command-specific counts } }
 *
 * `ok` is NEVER asserted by a child — it is passed in already-computed by the
 * dispatcher; `data` is the sole command-specific part; `findings`/`summary` are
 * uniform. When `summary` is omitted it is derived here by counting `findings`
 * by level into { errors, warnings, info }.
 *
 * Conventions: Node ESM, ZERO dependencies (node: builtins only). Fail-open at the
 * public boundary: bad inputs coerce to safe defaults; this never throws.
 */

import fs from 'node:fs';

/**
 * @typedef {import('./findings.mjs').Finding} Finding
 */

/**
 * @typedef {Object} Envelope
 * @property {string} forge The forge version (the raw VERSION string).
 * @property {string} command The invoked command/group.
 * @property {boolean} ok Computed success (passed in by the caller, never asserted by a child).
 * @property {string} ts ISO-8601 timestamp from the runtime clock.
 * @property {*} data Command-specific payload (the only non-uniform part).
 * @property {Finding[]} findings The C2 findings array.
 * @property {Object} summary Level counts (errors/warnings/info) plus any command-specific counts.
 */

/**
 * Wrap a module result (or a runner parse) in the C3 `--json` envelope.
 *
 * `summary` is optional: when omitted, it is computed by counting `findings` by
 * level into `{ errors, warnings, info }`. When provided, it is passed through
 * verbatim (so a command may add its own counts) — it is NOT recomputed.
 *
 * @param {Object} input
 * @param {string} [input.command] The invoked command/group (defaults to '').
 * @param {boolean} [input.ok] Computed success flag (defaults to false; never asserted here).
 * @param {*} [input.data] Command-specific payload (defaults to null).
 * @param {Finding[]} [input.findings] The C2 findings (defaults to []).
 * @param {Object} [input.summary] Pre-computed summary; when omitted it is derived from findings.
 * @param {string} [input.forgeVersion] The raw VERSION string to stamp as `forge` (defaults to '').
 * @returns {Envelope} The C3 envelope object.
 */
export function envelope({ command, ok, data, findings, summary, forgeVersion } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  return {
    forge: typeof forgeVersion === 'string' ? forgeVersion : '',
    command: typeof command === 'string' ? command : '',
    ok: ok === true,
    ts: new Date().toISOString(),
    data: data === undefined ? null : data,
    findings: list,
    summary: summary !== undefined && summary !== null ? summary : summarizeFindings(list),
  };
}

/**
 * Write `str` to stdout (fd 1) SYNCHRONOUSLY — the ONE safe way a dual-mode module's
 * `isMain()` block may emit its `--json` envelope right before `process.exit()`.
 *
 * WHY (pipe-flush truncation): `process.stdout.write` is ASYNCHRONOUS when stdout is a
 * PIPE (as it is whenever the web bridge — or any consumer — spawns the CLI and reads
 * its output through a pipe). The write only QUEUES the bytes; calling `process.exit()`
 * immediately afterward tears the process down before Node flushes the queued tail past
 * the OS pipe buffer (~64 KB on Linux). The result is a `--json` payload TRUNCATED
 * mid-string at the 64 KB boundary, so the consumer's `JSON.parse` fails. This was
 * latent for as long as every payload stayed under 64 KB; a federated source pushed
 * `catalog dedup --json` to ~0.85 MB and exposed it (piped: 65536 bytes captured, not
 * the full ~889 KB).
 *
 * A SYNCHRONOUS `fs.writeSync(1, …)` blocks until the bytes are accepted by the kernel,
 * so the payload is fully on its way out before we exit. We loop to handle PARTIAL
 * writes (writeSync may accept fewer bytes than offered) and retry on EAGAIN (fd 1 can
 * be non-blocking — a partial/zero write throws EAGAIN rather than blocking; we spin
 * until it drains). The catch makes a BEST-EFFORT async fallback so the worst case is
 * the original (possibly-truncated) behavior, never a thrown exception out of the tail.
 *
 * Zero-dep: `node:fs` only. Pure side-effect (writes fd 1); never throws.
 *
 * @param {string} str The exact bytes to emit (callers pass `JSON.stringify(env) + '\n'`).
 */
export function writeStdoutSync(str) {
  const buf = Buffer.from(typeof str === 'string' ? str : String(str), 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      if (e && e.code === 'EAGAIN') continue;
      try { process.stdout.write(buf.subarray(off)); } catch { /* best-effort */ }
      break;
    }
  }
}

/**
 * Count findings by level into the uniform summary triple.
 *
 * @param {Finding[]} findings The findings to tally.
 * @returns {{ errors: number, warnings: number, info: number }}
 */
export function summarizeFindings(findings) {
  const summary = { errors: 0, warnings: 0, info: 0 };
  if (!Array.isArray(findings)) return summary;
  for (const f of findings) {
    const level = f && f.level;
    if (level === 'ERROR') summary.errors++;
    else if (level === 'WARN') summary.warnings++;
    else if (level === 'INFO') summary.info++;
  }
  return summary;
}
