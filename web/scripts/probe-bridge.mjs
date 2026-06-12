/**
 * probe-bridge — proves the forge-bridge reads the REAL forge state (not
 * no-data) by replicating runForge("registry", ["ls"]): spawn the forge CLI
 * with cwd = FORGE_ROOT, parse the C3 envelope, and assert the artifact count.
 *
 * This mirrors src/lib/forge-bridge/run.ts exactly (same spawn shape, same cwd)
 * but runs as a plain Node script so it can be invoked outside Next.
 *
 *   node scripts/probe-bridge.mjs
 *
 * Exit 0 + prints the count when artifacts are found; exit 1 otherwise.
 */
import { spawn } from "node:child_process";

const FORGE_ROOT =
  process.env.FORGE_ROOT ??
  new URL("../../cli", import.meta.url).pathname;
const FORGE_BIN = `${FORGE_ROOT}/bin/forge.mjs`;

function runForge(cmd, args = []) {
  return new Promise((resolve) => {
    const argv = [FORGE_BIN, ...cmd.split(/\s+/), ...args, "--json"];
    const child = spawn("node", argv, { cwd: FORGE_ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => resolve({ error: e, stdout, stderr }));
    child.on("close", () => resolve({ stdout, stderr }));
  });
}

const res = await runForge("registry", ["ls"]);
if (res.error) {
  console.error("PROBE FAIL — spawn error:", res.error.message);
  process.exit(1);
}

let envelope;
try {
  envelope = JSON.parse(res.stdout.trim());
} catch {
  console.error("PROBE FAIL — non-JSON stdout. stderr:", res.stderr.trim());
  process.exit(1);
}

const artifacts = envelope?.data?.artifacts ?? [];
const count = Array.isArray(artifacts) ? artifacts.length : 0;

console.log(
  JSON.stringify(
    {
      ok: envelope.ok,
      forge: envelope.forge,
      command: envelope.command,
      cwd: FORGE_ROOT,
      artifactCount: count,
    },
    null,
    2,
  ),
);

if (count < 1) {
  console.error("PROBE FAIL — 0 artifacts (bridge returned no-data).");
  process.exit(1);
}
console.log(`PROBE PASS — bridge read ${count} artifacts from real forge state.`);
process.exit(0);
