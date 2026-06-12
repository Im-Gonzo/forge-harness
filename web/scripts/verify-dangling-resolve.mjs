/**
 * verify-dangling-resolve — proves FIX 2: the editable graph's resolve-dangling
 * write-action actually removes a dangling reference end-to-end.
 *
 * The real repo has 0 dangling refs (react-reviewer was fixed), so that
 * write-path was unverified. This script:
 *   1. Copies the WHOLE forge harness to a TEMP dir (the forge CLI resolves its
 *      root from its OWN location AND cwd, and `registry build --write` writes
 *      .forge/registry.json under that root — so a temp COPY fully isolates the
 *      test; the REAL harness is never read for state nor written).
 *   2. Plants a synthetic agent whose prose references a non-existent
 *      `ghost-reviewer` (matches deps.mjs' <x>-reviewer prose heuristic).
 *   3. Builds the registry + lists dangling to CONFIRM `ghost-reviewer` is
 *      reported as a dangling ref (with its site).
 *   4. Invokes the EXACT route write-core (`rewriteRef` from graph-edit-core.mjs,
 *      action "remove") on the planted file, then re-runs validate + registry
 *      build --write (the same write→validate→registry cycle the bridge runs).
 *   5. Asserts the dangling ref is GONE (registry dangling empty) and validate
 *      reports zero errors.
 *   6. Removes the temp copy.
 *
 *   node scripts/verify-dangling-resolve.mjs
 *
 * Exit 0 on pass; 1 on any failed assertion. Never touches the real harness.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { rewriteRef } from "../src/lib/forge-bridge/graph-edit-core.mjs";

const REAL_FORGE_ROOT =
  process.env.FORGE_ROOT ??
  new URL("../../cli", import.meta.url).pathname;

const GHOST = "ghost-reviewer";
const PLANTED_REL = path.join("agents", "ghost-test-agent.md");

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
    // recover the last JSON object on stdout
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

// --- 1. TEMP COPY of the whole harness --------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-dangling-"));
try {
  // copy everything (small tree, zero runtime deps); dereference nothing special.
  fs.cpSync(REAL_FORGE_ROOT, tmpRoot, { recursive: true });
  console.log(`Temp harness copy at ${tmpRoot}`);

  // --- 2. plant a synthetic dangling ref ------------------------------------
  // An agent .md whose PROSE backticks `ghost-reviewer`. deps.mjs scans agent
  // bodies and matches the <x>-reviewer heuristic → a routes-to edge whose
  // target does not resolve → a consolidated dangling entry.
  const plantedAbs = path.join(tmpRoot, PLANTED_REL);
  const planted = `---
name: ghost-test-agent
description: Synthetic agent planted by verify-dangling-resolve to exercise the resolve-dangling write-path. Routes review to a non-existent reviewer.
tools: [Read]
model: sonnet
---

# ghost-test-agent

This agent hands a TypeScript change off to the \`${GHOST}\` for a second pass.
The \`${GHOST}\` does not exist, so this is a synthetic dangling reference.
`;
  fs.writeFileSync(plantedAbs, planted, "utf8");

  // --- 3. CONFIRM it is reported as dangling --------------------------------
  runForge(tmpRoot, "registry", ["build", "--write"]);
  const before = runForge(tmpRoot, "registry", ["dangling"]);
  const danglingBefore = before?.data?.dangling ?? [];
  const ghostEntry = danglingBefore.find((d) => d.rawRef === GHOST);
  if (!ghostEntry) {
    fail(
      `planted ref '${GHOST}' was NOT reported as dangling. dangling=${JSON.stringify(
        danglingBefore,
      )}`,
    );
  }
  console.log(
    `PASS — '${GHOST}' is reported as dangling (refKind=${ghostEntry.refKind}, ` +
      `${ghostEntry.sites.length} site(s)).`,
  );

  // --- 4. invoke the resolve action (the EXACT route write-core) ------------
  // Build the plan exactly as the route would from the dangling entry, then run
  // rewriteRef + the write→validate→registry-build cycle against the temp root.
  const sites = ghostEntry.sites;
  const relPaths = Array.from(new Set(sites.map((s) => s.path)));
  let edited = 0;
  for (const rel of relPaths) {
    const abs = path.join(tmpRoot, rel);
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const next = rewriteRef(text, GHOST, "remove");
    if (next !== text) {
      fs.writeFileSync(abs, next, "utf8");
      edited++;
    }
  }
  if (edited === 0) {
    fail(`resolve action edited 0 files (rewriteRef matched nothing for '${GHOST}').`);
  }
  console.log(`        resolve action edited ${edited} file(s).`);

  // The bridge's resolveDanglingRef runs validate then registry build --write.
  const validate = runForge(tmpRoot, "validate", []);
  runForge(tmpRoot, "registry", ["build", "--write"]);

  // --- 5. assert the dangling ref is GONE and validate passes ---------------
  const after = runForge(tmpRoot, "registry", ["dangling"]);
  const danglingAfter = after?.data?.dangling ?? [];
  const stillThere = danglingAfter.find((d) => d.rawRef === GHOST);
  if (stillThere) {
    fail(
      `'${GHOST}' is STILL dangling after resolve: ${JSON.stringify(stillThere)}`,
    );
  }
  if (danglingAfter.length !== 0) {
    fail(
      `expected ZERO dangling refs after resolve, got ${danglingAfter.length}: ` +
        JSON.stringify(danglingAfter.map((d) => d.rawRef)),
    );
  }
  console.log("PASS — registry dangling is EMPTY after resolve (ghost-reviewer gone).");

  const errors = validate?.summary?.errors ?? -1;
  if (errors !== 0) {
    fail(`validate reported ${errors} error(s) after resolve (expected 0).`);
  }
  console.log("PASS — forge validate reports 0 errors after resolve.");

  // sanity: the planted file should no longer contain a backticked ghost ref
  const finalText = fs.readFileSync(plantedAbs, "utf8");
  if (finalText.includes("`" + GHOST + "`")) {
    fail("the planted file still contains a backticked `ghost-reviewer`.");
  }
  console.log("PASS — planted file's backticked ref was unticked (edge dropped).");

  console.log("\nALL DANGLING-RESOLVE ASSERTIONS PASSED.");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

process.exit(0);
