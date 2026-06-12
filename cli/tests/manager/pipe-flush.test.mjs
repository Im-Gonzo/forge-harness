#!/usr/bin/env node
/**
 * pipe-flush — regression test for the stdout PIPE-TRUNCATION bug (CLI-wide).
 *
 * THE BUG: every dual-mode manager module emits its `--json` envelope from its
 * `isMain()` block as `process.stdout.write(JSON.stringify(env) + '\n'); process.exit()`.
 * `process.stdout.write` is ASYNCHRONOUS when stdout is a PIPE (exactly how the web
 * bridge — and these tests — spawn the CLI): the write only QUEUES the bytes, and the
 * immediate `process.exit()` tears the process down before Node flushes the tail past
 * the OS pipe buffer (~64 KB on Linux). Any `--json` payload over ~64 KB was therefore
 * TRUNCATED mid-string (captured length pinned at 65536) and the consumer's JSON.parse
 * failed. It was latent only because every payload stayed under 64 KB until a federated
 * source pushed `catalog dedup --json` to ~0.85 MB.
 *
 * THE FIX: a SHARED `writeStdoutSync(str)` in manager/lib/json-out.mjs writes fd 1
 * SYNCHRONOUSLY (fs.writeSync, looping over partial writes, retrying on EAGAIN), so the
 * whole payload is on its way out before exit. Every dual-mode module now emits through it.
 *
 * THIS TEST drives the EXACT production emit path — the real `envelope()` + the real
 * `writeStdoutSync()` from json-out.mjs, then an IMMEDIATE `process.exit()` — over a REAL
 * PIPE (spawnSync's default 'pipe' stdio), with a deterministic >64 KB payload synthesized
 * in-process (so it never depends on global federation state / a synced source / CI host).
 * It asserts the captured stdout is the FULL payload (not the 65536-byte truncation
 * signature) and parses back to a complete, well-formed C3 envelope.
 *
 * A second, OPPORTUNISTIC case spawns the real `manager/catalog.mjs dedup --json` module
 * over a pipe and — IF the catalog exceeds 64 KB on this host (a federated source is
 * synced) — asserts it is whole; otherwise it is skipped (no global state to rely on).
 *
 * Zero deps. node:test. Spawns a CHILD over a PIPE (the failure only reproduces across a
 * process boundary + pipe — importing run() in-process would never expose it).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // …/tests/manager
const CLI_ROOT = path.resolve(HERE, '..', '..'); // the real cli/ repo root
const JSON_OUT = path.join(CLI_ROOT, 'manager', 'lib', 'json-out.mjs');
const CATALOG = path.join(CLI_ROOT, 'manager', 'catalog.mjs');

/** The OS pipe-buffer boundary the async write was truncating at. */
const PIPE_BUF = 65536;

/** A spawn whose stdout is a genuine PIPE (default stdio), with headroom on the capture buffer. */
function spawnPiped(scriptPath, args, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: cwd || CLI_ROOT,
    // No `stdio` override → default 'pipe' for stdout/stderr: a REAL pipe, so the
    // async-write truncation reproduces exactly as it would for the web bridge.
    // `maxBuffer` is bumped so the CAPTURE side never caps the payload (we are testing
    // the CHILD's flush, not the parent's buffer). Bytes, not a decoded string, so the
    // length assertion is exact.
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------------------
// 1. The exact production emit path (real envelope + real writeStdoutSync +
//    immediate process.exit) over a pipe, with a deterministic >64 KB payload.
// ---------------------------------------------------------------------------

test('writeStdoutSync emits a >64 KB --json envelope WHOLE over a pipe (no 64 KB truncation)', () => {
  // A throwaway module whose isMain tail mirrors EVERY dual-mode module verbatim:
  //   envelope({...big data...}) -> writeStdoutSync(JSON.stringify(env)+'\n') -> process.exit(0)
  // It imports the REAL json-out.mjs, so it exercises the shipped helper, not a copy.
  const jsonOutUrl = 'file://' + JSON_OUT.split(path.sep).join('/').replace(/^([A-Za-z]):/, '/$1:');
  const harness = `
import { envelope, writeStdoutSync } from ${JSON.stringify(jsonOutUrl)};
// ~1 MB of deterministic payload — comfortably past the 64 KB pipe buffer.
const big = [];
for (let i = 0; i < 20000; i++) big.push({ uid: 'artifact:' + i, blob: 'x'.repeat(40) });
const env = envelope({ command: 'pipe-flush probe', ok: true, data: { records: big }, findings: [], forgeVersion: 'test' });
writeStdoutSync(JSON.stringify(env) + '\\n');
process.exit(0); // the immediate exit that USED to drop the unflushed tail
`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pipe-flush-'));
  const mod = path.join(tmp, 'probe.mjs');
  try {
    fs.writeFileSync(mod, harness, 'utf8');
    const r = spawnPiped(mod, [], tmp);

    assert.strictEqual(r.status, 0, `probe exited ${r.status}; stderr: ${r.stderr}`);
    const out = r.stdout; // Buffer (no encoding requested)
    assert.ok(out.length > PIPE_BUF, `payload must exceed the pipe buffer to be a real test (got ${out.length})`);
    // The smoking gun of the bug was a capture pinned at EXACTLY the 64 KB buffer.
    assert.notStrictEqual(out.length, PIPE_BUF, 'stdout was truncated at the 64 KB pipe buffer — the bug is back');

    const text = out.toString('utf8');
    assert.ok(text.endsWith('\n'), 'envelope must end with the trailing newline (last byte survived)');
    // The whole thing parses (a truncated payload throws here).
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.command, 'pipe-flush probe');
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.data.records.length, 20000, 'every record survived — no mid-array truncation');
    // Round-trips byte-for-byte: nothing was dropped, nothing was added.
    assert.strictEqual(JSON.stringify(parsed) + '\n', text, 're-serialization is byte-identical to the captured stdout');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// 2. The real catalog.mjs module over a pipe — opportunistic (depends on whether
//    a federated source is synced on this host, so skip when the catalog is small).
// ---------------------------------------------------------------------------

test('real catalog dedup --json is whole over a pipe when it exceeds the pipe buffer', (t) => {
  const r = spawnPiped(CATALOG, ['dedup', '--json'], CLI_ROOT);
  assert.strictEqual(r.status === 0 || r.status === 1, true, `catalog dedup exited ${r.status}; stderr: ${r.stderr}`);
  const out = r.stdout;
  if (out.length <= PIPE_BUF) {
    t.skip(`catalog is ${out.length} B (<= 64 KB on this host — no large federated source synced); the synthetic case above covers the >64 KB path`);
    return;
  }
  assert.notStrictEqual(out.length, PIPE_BUF, 'catalog stdout truncated at the 64 KB pipe buffer — the bug is back');
  const text = out.toString('utf8');
  assert.ok(text.endsWith('\n'), 'catalog envelope must end with the trailing newline');
  const parsed = JSON.parse(text); // throws on truncation
  assert.strictEqual(typeof parsed, 'object');
  assert.ok(Array.isArray(parsed.data && parsed.data.records), 'a complete catalog envelope carries data.records[]');
  assert.strictEqual(parsed.command, 'catalog dedup');
});
