/**
 * verify-hook-board — proves the HOOK lifecycle board's two load-bearing claims,
 * end-to-end, WITHOUT touching the real forge harness.
 *
 * Like verify-dangling-resolve.mjs, this copies the WHOLE forge harness to a TEMP
 * dir and points everything at the copy (the forge CLI resolves its root from cwd
 * AND its own location, and `registry build --write` writes under that root — so a
 * temp COPY fully isolates the test). The REAL harness is never read for state nor
 * written.
 *
 * It exercises the EXACT code the /api/hook-test route runs by importing the route's
 * PURE core (hook-edit-core.mjs) — not a re-implementation:
 *
 *   CLAIM 1 (minimal-diff field edit + validate-hooks PASS):
 *     - Pick a real hook group (forge:secret-scan), read its current timeout.
 *     - editHookField(text, id, "timeout", newValue) → write the temp hooks.json.
 *     - Assert the diff is MINIMAL: exactly ONE changed line, and that line is the
 *       timeout (key order + every other byte preserved).
 *     - Run the temp copy's validate-hooks → assert 0 errors (PASS).
 *     - Run forge validate (full) → assert 0 errors (the harness stays byte-clean
 *       in spirit: the only delta is the intended timeout).
 *
 *   CLAIM 2 (test-vs-stdin shows secret-scan DENY on a planted secret):
 *     - resolveHookScript() the secret-scan command → its temp script path.
 *     - Spawn it with the board's "planted-secret" sample payload on stdin.
 *     - interpretHookResult(stdout, code) → assert verdict === "deny" (NO file was
 *       mutated by the test — the run is read-only by construction).
 *
 *   node scripts/verify-hook-board.mjs
 *
 * Exit 0 on pass; 1 on any failed assertion. Never touches the real harness.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  flattenHooks,
  findHookLocation,
  editHookField,
  resolveHookScript,
  interpretHookResult,
} from "../src/app/api/hook-test/hook-edit-core.mjs";

const REAL_FORGE_ROOT =
  process.env.FORGE_ROOT ??
  new URL("../../cli", import.meta.url).pathname;

const HOOK_ID = "forge:secret-scan";

const fail = (msg) => {
  console.error("FAIL —", msg);
  process.exit(1);
};

/** Run the temp copy's forge CLI; parse the C3 envelope. */
function runForge(tmpRoot, cmd, args = []) {
  const bin = path.join(tmpRoot, "bin", "forge.mjs");
  const res = spawnSync(
    process.execPath,
    [bin, ...cmd.split(/\s+/), ...args, "--json"],
    { cwd: tmpRoot, encoding: "utf8" },
  );
  const raw = (res.stdout || "").trim();
  if (!raw) fail(`forge ${cmd} produced no stdout. stderr: ${res.stderr}`);
  try {
    return JSON.parse(raw);
  } catch {
    const i = raw.lastIndexOf("{");
    if (i >= 0) {
      try {
        return JSON.parse(raw.slice(i));
      } catch {
        /* fallthrough */
      }
    }
    fail(`forge ${cmd} returned non-JSON stdout:\n${raw.slice(0, 400)}`);
  }
}

/** Spawn a script with `stdin` piped in; resolve {code, stdout, stderr}. */
function spawnWithStdin(scriptAbs, stdinText, root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptAbs], {
      cwd: root,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (e) => resolve({ code: null, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

/** Count the lines that differ between two texts (added/removed/changed). */
function changedLineCount(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  let changed = 0;
  const max = Math.max(la.length, lb.length);
  for (let i = 0; i < max; i++) {
    if (la[i] !== lb[i]) changed++;
  }
  return changed;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hookboard-"));
const main = async () => {
  fs.cpSync(REAL_FORGE_ROOT, tmpRoot, { recursive: true });
  console.log(`Temp harness copy at ${tmpRoot}`);

  const hooksPath = path.join(tmpRoot, "hooks", "hooks.json");
  const before = fs.readFileSync(hooksPath, "utf8");

  // Sanity: the board can flatten the file and find our hook.
  const parsed = JSON.parse(before);
  const flat = flattenHooks(parsed);
  if (!flat.some((h) => h.id === HOOK_ID)) {
    fail(`board flatten did not surface '${HOOK_ID}'. ids=${flat.map((h) => h.id).join(", ")}`);
  }
  const loc = findHookLocation(parsed, HOOK_ID);
  if (!loc) fail(`findHookLocation could not locate '${HOOK_ID}'.`);
  const currentTimeout = loc.group.hooks[0].timeout;
  console.log(`PASS — board located '${HOOK_ID}' (current timeout=${currentTimeout}s).`);

  // ── CLAIM 1: minimal-diff timeout edit + validate-hooks PASS ──────────────
  const newTimeout = (currentTimeout ?? 5) + 7;
  const after = editHookField(before, HOOK_ID, "timeout", newTimeout);

  if (after === before) fail("editHookField produced no change for the timeout edit.");
  const changed = changedLineCount(before, after);
  if (changed !== 1) {
    fail(`expected EXACTLY 1 changed line (minimal diff), got ${changed}.`);
  }
  // The single changed line must be the timeout line, and key order preserved.
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const diffIdx = beforeLines.findIndex((ln, i) => ln !== afterLines[i]);
  if (!/"timeout"\s*:/.test(afterLines[diffIdx])) {
    fail(`the single changed line is not the timeout line: ${afterLines[diffIdx]}`);
  }
  if (!afterLines[diffIdx].includes(String(newTimeout))) {
    fail(`the changed timeout line does not carry the new value ${newTimeout}: ${afterLines[diffIdx]}`);
  }
  // Re-parse to confirm ONLY this hook's timeout changed and nothing else.
  const afterParsed = JSON.parse(after);
  const afterLoc = findHookLocation(afterParsed, HOOK_ID);
  if (afterLoc.group.hooks[0].timeout !== newTimeout) {
    fail("re-parsed timeout does not equal the new value.");
  }
  // Every OTHER hook group must be byte-deep-equal to before.
  const beforeOthers = flattenHooks(parsed).filter((h) => h.id !== HOOK_ID);
  const afterOthers = flattenHooks(afterParsed).filter((h) => h.id !== HOOK_ID);
  if (JSON.stringify(beforeOthers) !== JSON.stringify(afterOthers)) {
    fail("a hook group OTHER than the edited one changed (not minimal).");
  }
  console.log(`PASS — timeout edit ${currentTimeout}s→${newTimeout}s is MINIMAL-DIFF (1 line, key order preserved, other groups untouched).`);

  fs.writeFileSync(hooksPath, after, "utf8");

  // Run the standalone validate-hooks validator on the temp copy.
  const vh = spawnSync(
    process.execPath,
    [path.join(tmpRoot, "lint", "validate-hooks.mjs"), tmpRoot],
    { cwd: tmpRoot, encoding: "utf8" },
  );
  if (vh.status !== 0) {
    fail(`validate-hooks exited ${vh.status} after the timeout edit:\n${vh.stdout}\n${vh.stderr}`);
  }
  if (!/validate-hooks:\s*PASS/.test(vh.stdout)) {
    fail(`validate-hooks did not report PASS:\n${vh.stdout}`);
  }
  console.log("PASS — validate-hooks PASS after the minimal-diff timeout edit.");

  // Full forge validate must also stay clean (0 errors).
  const validate = runForge(tmpRoot, "validate", []);
  const errs = validate?.summary?.errors ?? -1;
  if (errs !== 0) {
    fail(`forge validate reported ${errs} error(s) after the timeout edit (expected 0).`);
  }
  console.log("PASS — forge validate reports 0 errors after the edit.");

  // ── CLAIM 2: test-vs-stdin → secret-scan DENY on a planted secret ─────────
  // The board's "planted-secret" sample payload (mirrors the route's preset).
  const PLANTED = {
    session_id: "verify-hook-board",
    tool_name: "Write",
    tool_input: {
      file_path: "src/config.ts",
      content: "export const AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';\n",
    },
  };

  const cmd = afterLoc.group.hooks[0].command;
  const script = resolveHookScript(cmd, tmpRoot, path.join);
  if (!script) fail(`resolveHookScript returned null for command: ${cmd}`);
  if (!fs.existsSync(script.abs)) fail(`resolved script does not exist: ${script.abs}`);
  console.log(`        secret-scan script resolves to ${script.rel}`);

  // Snapshot hooks.json bytes to prove the TEST mutates nothing.
  const hooksBytesBeforeTest = fs.readFileSync(hooksPath);

  const run = await spawnWithStdin(script.abs, JSON.stringify(PLANTED), tmpRoot);
  const verdict = interpretHookResult(run.stdout, run.code);
  if (verdict.verdict !== "deny") {
    fail(
      `expected secret-scan to DENY the planted secret, got '${verdict.verdict}'. ` +
        `stdout=${run.stdout.slice(0, 200)} stderr=${run.stderr.slice(0, 200)}`,
    );
  }
  if (!/secret/i.test(verdict.reason ?? "")) {
    fail(`deny reason does not mention a secret: ${verdict.reason}`);
  }
  console.log(`PASS — test-vs-stdin shows secret-scan DENY on the planted secret.`);
  console.log(`        reason: ${(verdict.reason ?? "").slice(0, 90)}…`);

  // The test must NOT have mutated hooks.json (read-only by construction).
  const hooksBytesAfterTest = fs.readFileSync(hooksPath);
  if (!hooksBytesBeforeTest.equals(hooksBytesAfterTest)) {
    fail("the test-vs-stdin run mutated hooks.json (it must be read-only).");
  }
  console.log("PASS — the test run did NOT mutate hooks.json (read-only).");

  // Control: a clean payload must ALLOW (no false-positive deny).
  const CLEAN = {
    session_id: "verify-hook-board",
    tool_name: "Write",
    tool_input: { file_path: "src/x.ts", content: "export const ok = 1;\n" },
  };
  const cleanRun = await spawnWithStdin(script.abs, JSON.stringify(CLEAN), tmpRoot);
  const cleanVerdict = interpretHookResult(cleanRun.stdout, cleanRun.code);
  if (cleanVerdict.verdict !== "allow") {
    fail(`expected ALLOW for a clean payload, got '${cleanVerdict.verdict}'.`);
  }
  console.log("PASS — a clean payload is ALLOWed (no false-positive deny).");

  console.log("\nALL HOOK-BOARD ASSERTIONS PASSED.");
};

main()
  .catch((e) => fail(e && e.stack ? e.stack : String(e)))
  .finally(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
