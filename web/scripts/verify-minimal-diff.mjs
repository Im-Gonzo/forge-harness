/**
 * verify-minimal-diff — proves FIX 1: in-place manifest edits are byte-minimal.
 *
 * The bridge edits a composition manifest with jsonc-parser element-level
 * splicing (src/lib/forge-bridge/graph.ts `editScalarArray`), so a one-module
 * change touches ONLY the targeted array — an inline array stays inline, and an
 * unrelated hand-wrapped multi-line array is preserved verbatim.
 *
 * This script replicates that edit against a TEMP COPY of the REAL profiles.json
 * (the real file is never mutated) and asserts:
 *   1. add(next-ts, database) then remove(next-ts, database) round-trips to a
 *      BYTE-IDENTICAL file (sha256 match).
 *   2. a single add produces a diff touching ONLY the next-ts `modules` line —
 *      the python-next-fullstack profile's multi-line `modules` array is byte-
 *      identical (no reflow).
 *
 *   node scripts/verify-minimal-diff.mjs
 *
 * Exit 0 on pass; 1 on any failed assertion.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { editScalarArray } from "../src/lib/forge-bridge/graph-edit-core.mjs";

const FORGE_ROOT =
  process.env.FORGE_ROOT ??
  new URL("../../cli", import.meta.url).pathname;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const fail = (msg) => {
  console.error("FAIL —", msg);
  process.exit(1);
};

// --- TEMP COPY of the real profiles.json (never mutate the real one) ---------
const realProfiles = path.join(FORGE_ROOT, "manifests", "profiles.json");
const baseline = fs.readFileSync(realProfiles, "utf8");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-min-diff-"));
const tmpProfiles = path.join(tmpDir, "profiles.json");
fs.writeFileSync(tmpProfiles, baseline, "utf8");

try {
  const baselineSha = sha(baseline);

  // --- 1. add → remove round-trip is byte-identical -------------------------
  const added = editScalarArray(
    baseline,
    ["profiles", "next-ts", "modules"],
    "add",
    "database",
  );
  fs.writeFileSync(tmpProfiles, added, "utf8");
  const roundTrip = editScalarArray(
    fs.readFileSync(tmpProfiles, "utf8"),
    ["profiles", "next-ts", "modules"],
    "remove",
    "database",
  );
  fs.writeFileSync(tmpProfiles, roundTrip, "utf8");

  const rtSha = sha(fs.readFileSync(tmpProfiles, "utf8"));
  if (rtSha !== baselineSha) {
    fail(
      `round-trip is NOT byte-identical.\n  baseline sha ${baselineSha}\n  roundtrip sha ${rtSha}`,
    );
  }
  console.log("PASS — add→remove round-trip is byte-identical (sha256 match).");
  console.log(`        sha256 ${baselineSha}`);

  // --- 2. a single add reflows ONLY the intended line -----------------------
  const before = baseline.split("\n");
  const after = added.split("\n");

  // Every line that changed must belong to the next-ts modules edit.
  const changed = [];
  const maxLen = Math.max(before.length, after.length);
  for (let i = 0; i < maxLen; i++) {
    if (before[i] !== after[i]) changed.push(i + 1);
  }
  // Exactly ONE line should differ (the inline next-ts modules array), and it
  // must be the line that gained "database".
  if (changed.length !== 1) {
    fail(
      `expected exactly 1 changed line, got ${changed.length}: ${changed.join(", ")}`,
    );
  }
  const changedLine = after[changed[0] - 1];
  if (!/"next-ts"|"modules"/.test(before[changed[0] - 1]) && !changedLine.includes("database")) {
    fail(`the changed line is not the next-ts modules line: ${changedLine}`);
  }
  if (!changedLine.includes('"database"')) {
    fail(`the changed line did not gain "database": ${changedLine}`);
  }
  console.log(
    `PASS — single add touched ONLY line ${changed[0]} (next-ts modules); no reflow.`,
  );

  // --- 3. the multi-line python-next-fullstack array is byte-identical -------
  // Locate that profile's modules block in both before & after and compare.
  const blockOf = (text) => {
    const m = text.match(
      /"python-next-fullstack":[\s\S]*?"modules":\s*\[([\s\S]*?)\]/,
    );
    return m ? m[0] : null;
  };
  const beforeBlock = blockOf(baseline);
  const afterBlock = blockOf(added);
  if (!beforeBlock || beforeBlock !== afterBlock) {
    fail("python-next-fullstack multi-line modules array was REFLOWED by an unrelated edit.");
  }
  console.log(
    "PASS — unrelated multi-line array (python-next-fullstack) is byte-identical (no reflow).",
  );

  console.log("\nALL MINIMAL-DIFF ASSERTIONS PASSED.");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

process.exit(0);
