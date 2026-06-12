/**
 * verify-resource-crud — proves the per-resource dual-mode CRUD round-trip
 * end-to-end against a TEMP COPY of the harness (the REAL harness is never read
 * for state nor written).
 *
 * It exercises the EXACT write-cores the bridge's crud.ts uses
 * (frontmatter-edit-core.mjs: serializeDocument / updateDocument) plus the SAME
 * additive write cycle (write → `forge validate` → `forge registry build
 * --write`) the bridge runs after every op — the only thing it re-implements is
 * the FORGE_ROOT IO + spawn (crud.ts adds exactly that thin layer on top of the
 * pure core, which is what `@/`-aliased TS keeps us from importing directly).
 *
 * The round-trip (an AGENT resource — the reference kind):
 *   1. Copy the WHOLE harness to a temp dir; confirm baseline validate PASS and
 *      the baseline artifact count.
 *   2. CREATE agents/verify-crud-agent.md (additive serialize) → validate PASS,
 *      artifact count = baseline + 1, the new agent is registered.
 *   3. UPDATE its `description` with a MINIMAL DIFF → exactly ONE line changed
 *      (the description), body + every other line byte-identical → validate PASS.
 *   4. DELETE it (guarded) → validate PASS, artifact count back to baseline, the
 *      agent is gone from the registry.
 *   5. Assert the registry/validate are back to the pre-test baseline.
 *
 *   node scripts/verify-resource-crud.mjs
 *
 * Exit 0 on pass; 1 on any failed assertion. The temp copy is always removed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  serializeDocument,
  updateDocument,
  splitDocument,
} from "../src/lib/forge-bridge/frontmatter-edit-core.mjs";

const REAL_FORGE_ROOT =
  process.env.FORGE_ROOT ??
  new URL("../../cli", import.meta.url).pathname;

const KIND = "agent";
const ID = "verify-crud-agent";
const REL = path.join("agents", `${ID}.md`);

const fail = (msg) => {
  console.error("FAIL —", msg);
  process.exit(1);
};

/** Run the TEMP copy's forge CLI with cwd = temp root; parse the C3 envelope. */
function runForge(tmpRoot, cmd, args = []) {
  const bin = path.join(tmpRoot, "bin", "forge.mjs");
  const res = spawnSync(
    process.execPath,
    [bin, ...cmd.split(/\s+/), ...args, "--json"],
    { cwd: tmpRoot, encoding: "utf8" },
  );
  const raw = (res.stdout || "").trim();
  if (!raw) {
    fail(`forge ${cmd} ${args.join(" ")} produced no stdout. stderr: ${res.stderr}`);
  }
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

/**
 * The bridge's write cycle is validate → registry build --write. On a STRUCTURAL
 * change (create/delete adds/removes an artifact) the FIRST validate reports the
 * registry as stale (the build that fixes it runs next) — that is the documented
 * order in crud.ts. To assert the END state is byte-clean we run the same cycle
 * and then RE-VALIDATE after the build, returning that settled result. (For a
 * content-only update there is no staleness, so the two agree.)
 */
function writeCycle(tmpRoot) {
  runForge(tmpRoot, "validate", []); // mirror the bridge's pre-build validate
  runForge(tmpRoot, "registry", ["build", "--write"]);
  return runForge(tmpRoot, "validate", []); // settled, post-build state
}

function artifactCount(tmpRoot) {
  const ls = runForge(tmpRoot, "registry", ["ls"]);
  return (ls?.data?.artifacts ?? []).length;
}

function hasArtifact(tmpRoot, uid) {
  const ls = runForge(tmpRoot, "registry", ["ls"]);
  return (ls?.data?.artifacts ?? []).some((a) => a.uid === uid);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-crud-"));
try {
  fs.cpSync(REAL_FORGE_ROOT, tmpRoot, { recursive: true });
  console.log(`Temp harness copy at ${tmpRoot}`);

  // --- 1. baseline ----------------------------------------------------------
  const baseValidate = runForge(tmpRoot, "validate", []);
  if ((baseValidate?.summary?.errors ?? -1) !== 0) {
    fail(`baseline validate is not clean: ${JSON.stringify(baseValidate?.summary)}`);
  }
  const baseCount = artifactCount(tmpRoot);
  console.log(`PASS — baseline validate is clean; ${baseCount} artifacts.`);

  const abs = path.join(tmpRoot, REL);
  const uid = `${KIND}:${ID}`;
  if (fs.existsSync(abs)) fail(`temp copy already has ${REL} (unexpected).`);

  // --- 2. CREATE (additive serialize, the create write path) ----------------
  const createFm = {
    name: ID,
    description:
      "Synthetic agent planted by verify-resource-crud to exercise the per-resource CRUD round-trip. Safe to delete.",
    tools: ["Read", "Grep"],
    model: "sonnet",
  };
  const createBody =
    "\n# verify-crud-agent\n\nA throwaway agent used only by the CRUD verification script.\n";
  const created = serializeDocument(createFm, createBody);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, created, "utf8");
  let validate = writeCycle(tmpRoot);
  if ((validate?.summary?.errors ?? -1) !== 0) {
    fail(`validate FAILED after create: ${JSON.stringify(validate?.findings)}`);
  }
  if (!hasArtifact(tmpRoot, uid)) fail(`registry does not contain ${uid} after create.`);
  if (artifactCount(tmpRoot) !== baseCount + 1) {
    fail(`artifact count after create is ${artifactCount(tmpRoot)}, expected ${baseCount + 1}.`);
  }
  console.log(`PASS — CREATE: ${uid} registered; validate PASS; count = baseline + 1.`);

  // --- 3. UPDATE description with a MINIMAL DIFF ----------------------------
  const before = fs.readFileSync(abs, "utf8");
  const nextFm = {
    ...createFm,
    description:
      "EDITED by verify-resource-crud: the description was changed to prove a minimal-diff update.",
  };
  const beforeBody = splitDocument(before).body;
  const updated = updateDocument(before, nextFm, beforeBody);
  fs.writeFileSync(abs, updated, "utf8");

  // Exactly ONE line should differ (the description line), and the body must be
  // byte-identical (preserved verbatim).
  const beforeLines = before.split("\n");
  const afterLines = updated.split("\n");
  const changed = [];
  for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
    if (beforeLines[i] !== afterLines[i]) changed.push(i + 1);
  }
  if (changed.length !== 1) {
    fail(`expected exactly 1 changed line on update, got ${changed.length}: ${changed.join(", ")}`);
  }
  if (!afterLines[changed[0] - 1].startsWith("description:")) {
    fail(`the changed line is not the description line: ${afterLines[changed[0] - 1]}`);
  }
  if (splitDocument(updated).body !== beforeBody) {
    fail("body was NOT preserved verbatim across the update.");
  }
  validate = writeCycle(tmpRoot);
  if ((validate?.summary?.errors ?? -1) !== 0) {
    fail(`validate FAILED after update: ${JSON.stringify(validate?.findings)}`);
  }
  console.log(
    `PASS — UPDATE: minimal diff (only line ${changed[0]}, the description); body verbatim; validate PASS.`,
  );

  // --- 4. DELETE (guarded — the file is removed, registry drops it) ---------
  fs.rmSync(abs, { force: true });
  validate = writeCycle(tmpRoot);
  if ((validate?.summary?.errors ?? -1) !== 0) {
    fail(`validate FAILED after delete: ${JSON.stringify(validate?.findings)}`);
  }
  if (hasArtifact(tmpRoot, uid)) fail(`registry STILL contains ${uid} after delete.`);
  console.log(`PASS — DELETE: ${uid} removed; validate PASS.`);

  // --- 5. back to baseline --------------------------------------------------
  const finalCount = artifactCount(tmpRoot);
  if (finalCount !== baseCount) {
    fail(`final artifact count is ${finalCount}, expected baseline ${baseCount}.`);
  }
  const finalValidate = runForge(tmpRoot, "validate", []);
  if ((finalValidate?.summary?.errors ?? -1) !== 0) {
    fail(`final validate is not clean: ${JSON.stringify(finalValidate?.summary)}`);
  }
  console.log(`PASS — registry + validate back to baseline (${finalCount} artifacts, 0 errors).`);

  console.log("\nALL RESOURCE-CRUD ASSERTIONS PASSED.");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

process.exit(0);
