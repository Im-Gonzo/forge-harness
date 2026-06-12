/**
 * verify-bundle-crud — proves the bundle CREATE → EDIT → DELETE round-trip
 * VALIDATES end-to-end against a TEMP COPY of the harness (the REAL harness is
 * never read for state nor written), and pins the serialization invariant the
 * bundle form depends on.
 *
 * WHY A DEDICATED BUNDLE SCRIPT (not the generic verify-resource-crud):
 *   A bundle is the only resource whose frontmatter is NESTED — arrays of maps
 *   (adrs / spec_sections / invisible_20) with nested scalar arrays inside them.
 *   The generic write cores cannot serialize that into a shape `forge validate`
 *   (lint/validate-bundles.mjs, a dependency-free reader) accepts:
 *     • frontmatter-edit-core's serializeDocument (the bridge CREATE path)
 *       JSON-flows an array-of-maps onto one line → the reader parses each element
 *       as a STRING → `.adrs[0]: expected type "object", got string`.
 *     • gray-matter's matter.stringify (the bridge UPDATE fallback) block-expands
 *       the nested sections/refs arrays → the reader can't descend them →
 *       `.spec_sections[0].sections: expected type "array", got string`.
 *   This script DEMONSTRATES both failure modes against the temp copy, then proves
 *   that forms/bundle/serialize-bundle.mjs — the VALIDATOR-PARSEABLE serializer
 *   the bundle form's projection uses — round-trips create→edit→delete cleanly.
 *
 * The round-trip:
 *   1. Copy the WHOLE harness to a temp dir; confirm baseline validate PASS +
 *      baseline artifact count.
 *   2. (Counter-evidence) write a bundle via serializeDocument and via
 *      matter.stringify; assert BOTH make validate FAIL with the documented
 *      schema errors — this is WHY the dedicated serializer exists.
 *   3. CREATE bundles/verify-bundle.md via serializeBundleDocument → validate
 *      PASS, artifact count = baseline + 1, bundle:verify-bundle registered.
 *   4. EDIT it (bump version, add an adr, add a spec section + nested sections,
 *      add an invisible_20 with refs, flip human_gate) via the SAME serializer →
 *      validate PASS, body preserved verbatim.
 *   5. DELETE it → validate PASS, artifact count back to baseline, gone from the
 *      registry.
 *   6. Assert validate/registry are byte-clean and back at baseline.
 *
 *   node scripts/verify-bundle-crud.mjs
 *
 * Exit 0 on pass; 1 on any failed assertion. The temp copy is always removed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import matter from "gray-matter";

import { serializeDocument } from "../src/lib/forge-bridge/frontmatter-edit-core.mjs";
import {
  serializeBundleDocument,
  serializeBundleFrontmatter,
} from "../src/components/resource-editor/forms/bundle/serialize-bundle.mjs";

const REAL_FORGE_ROOT =
  process.env.FORGE_ROOT ??
  new URL("../../cli", import.meta.url).pathname;

const ID = "verify-bundle";
const REL = path.join("bundles", `${ID}.md`);
const UID = `bundle:${ID}`;

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

/** The bridge's write cycle, settled (validate → registry build → re-validate). */
function writeCycle(tmpRoot) {
  runForge(tmpRoot, "validate", []);
  runForge(tmpRoot, "registry", ["build", "--write"]);
  return runForge(tmpRoot, "validate", []);
}

function artifactCount(tmpRoot) {
  return (runForge(tmpRoot, "registry", ["ls"])?.data?.artifacts ?? []).length;
}
function hasArtifact(tmpRoot, uid) {
  return (runForge(tmpRoot, "registry", ["ls"])?.data?.artifacts ?? []).some(
    (a) => a.uid === uid,
  );
}

/** Validate ONLY the bundle file (bundle-scoped errors), via lint/validate-bundles. */
function bundleErrors(tmpRoot) {
  const res = spawnSync(
    process.execPath,
    [path.join(tmpRoot, "lint", "validate-bundles.mjs"), tmpRoot],
    { encoding: "utf8" },
  );
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  return out
    .split("\n")
    .filter((l) => l.startsWith("ERROR") && l.includes(`bundles/${ID}.md`));
}

const BODY =
  "\n# verify-bundle — WARM context for the round-trip test\n\n" +
  "A throwaway bundle planted by verify-bundle-crud. Safe to delete.\n";

/** A complete, schema-valid bundle frontmatter object (canonical key order). */
function baseFrontmatter() {
  return {
    id: ID,
    title: "Verify bundle — exercise the bundle CRUD round-trip",
    version: 1,
    status: "active",
    work_type: "documentation",
    invariants: [1, 2, 4],
    adrs: [
      {
        id: "ADR-0001",
        path: "docs/adr/ADR-0001-architecture-baseline.md",
        why: "fixes the baseline the slice exercises",
      },
    ],
    spec_sections: [
      { path: "docs/METHOD.md", sections: ["1 HOT/WARM/COLD", "2 invisible-20%"] },
    ],
    br_ids: ["BR-CORE-001", "BR-CORE-002"],
    conformance: ["docs/METHOD.md#2"],
    modules: ["the-spine-end-to-end"],
    skill: ".claude/skills/load-bundle/SKILL.md",
    secondary_skill: ".claude/skills/new-bundle/SKILL.md",
    agent: ".claude/agents/code-reviewer.md",
    reviewer: ".claude/agents/diff-reviewer.md",
    dod_ref: "docs/specs/architecture.md#walking-skeleton-definition-of-done",
    invisible_20: [
      {
        id: "INV-1",
        rule: "Every state change goes through the ONE canonical write path.",
        check: "A test asserts the only mutation route is the single write path.",
        refs: ["docs/adr/ADR-0003-single-write-path.md", "AGENTS.md invariant 3"],
      },
    ],
    human_gate: false,
  };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bundle-"));
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
  if (fs.existsSync(abs)) fail(`temp copy already has ${REL} (unexpected).`);

  // --- 2. counter-evidence: the GENERIC cores both produce INVALID bundles ---
  // serializeDocument (bridge CREATE path): JSON-flows arrays-of-maps.
  fs.writeFileSync(abs, serializeDocument(baseFrontmatter(), BODY), "utf8");
  const sdErrors = bundleErrors(tmpRoot);
  if (sdErrors.length === 0) {
    fail("serializeDocument unexpectedly produced a VALID bundle (the dedicated serializer would be unnecessary).");
  }
  if (!sdErrors.some((e) => /\.adrs\[0\]: expected type "object"/.test(e))) {
    fail(`serializeDocument failure not the documented one:\n${sdErrors.join("\n")}`);
  }
  // matter.stringify (bridge UPDATE fallback): block-expands nested arrays.
  fs.writeFileSync(abs, matter.stringify(BODY, baseFrontmatter()), "utf8");
  const gmErrors = bundleErrors(tmpRoot);
  if (!gmErrors.some((e) => /sections: expected type "array"/.test(e))) {
    fail(`matter.stringify failure not the documented one:\n${gmErrors.join("\n")}`);
  }
  fs.rmSync(abs, { force: true });
  console.log(
    "PASS — counter-evidence: serializeDocument AND matter.stringify both yield " +
      "INVALID bundles (the documented reason serialize-bundle.mjs exists).",
  );

  // --- 3. CREATE via the dedicated VALIDATOR-PARSEABLE serializer ------------
  const created = serializeBundleDocument(baseFrontmatter(), BODY);
  // Sanity: a real YAML parser round-trips it to the same object.
  const rp = matter(created);
  if (typeof rp.data.adrs?.[0] !== "object") fail("created adrs[0] is not an object.");
  if (!Array.isArray(rp.data.spec_sections?.[0]?.sections)) {
    fail("created spec_sections[0].sections is not an array.");
  }
  if (!Array.isArray(rp.data.invisible_20?.[0]?.refs)) {
    fail("created invisible_20[0].refs is not an array.");
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, created, "utf8");

  let validate = writeCycle(tmpRoot);
  if ((validate?.summary?.errors ?? -1) !== 0) {
    fail(`validate FAILED after create: ${JSON.stringify(validate?.findings)}`);
  }
  if (bundleErrors(tmpRoot).length !== 0) {
    fail(`bundle-scoped errors after create:\n${bundleErrors(tmpRoot).join("\n")}`);
  }
  if (!hasArtifact(tmpRoot, UID)) fail(`registry does not contain ${UID} after create.`);
  if (artifactCount(tmpRoot) !== baseCount + 1) {
    fail(`artifact count after create is ${artifactCount(tmpRoot)}, expected ${baseCount + 1}.`);
  }
  console.log(`PASS — CREATE: ${UID} registered; validate PASS; count = baseline + 1.`);

  // --- 4. EDIT (exercise every nested shape) → validate PASS, body verbatim --
  const before = fs.readFileSync(abs, "utf8");
  const beforeBody = matter(before).content;
  const editedFm = baseFrontmatter();
  editedFm.version = 2;
  editedFm.human_gate = true;
  editedFm.invariants = [1, 2, 3, 4];
  editedFm.adrs.push({ id: "ADR-0003", path: "docs/adr/ADR-0003-single-write-path.md" });
  editedFm.spec_sections.push({
    path: "docs/specs/architecture.md",
    sections: ["the spine: request -> write path -> persistence -> read"],
  });
  editedFm.invisible_20.push({
    id: "INV-2",
    rule: "The slice is genuinely end-to-end, not a faked stub.",
    refs: ["docs/specs/architecture.md#the-spine"],
  });
  // Body preserved verbatim (the form never touches the body).
  fs.writeFileSync(abs, serializeBundleDocument(editedFm, beforeBody), "utf8");

  if (matter(fs.readFileSync(abs, "utf8")).content !== beforeBody) {
    fail("body was NOT preserved verbatim across the edit.");
  }
  validate = writeCycle(tmpRoot);
  if ((validate?.summary?.errors ?? -1) !== 0) {
    fail(`validate FAILED after edit: ${JSON.stringify(validate?.findings)}`);
  }
  if (bundleErrors(tmpRoot).length !== 0) {
    fail(`bundle-scoped errors after edit:\n${bundleErrors(tmpRoot).join("\n")}`);
  }
  // Confirm the edit actually landed (version bump + the new adr).
  const editedParsed = matter(fs.readFileSync(abs, "utf8")).data;
  if (editedParsed.version !== 2 || editedParsed.adrs.length !== 2) {
    fail(`edit did not land as expected: ${JSON.stringify({ v: editedParsed.version, adrs: editedParsed.adrs.length })}`);
  }
  console.log("PASS — EDIT: nested adds (adr/spec/invisible_20) + human_gate; body verbatim; validate PASS.");

  // --- 5. DELETE ------------------------------------------------------------
  fs.rmSync(abs, { force: true });
  validate = writeCycle(tmpRoot);
  if ((validate?.summary?.errors ?? -1) !== 0) {
    fail(`validate FAILED after delete: ${JSON.stringify(validate?.findings)}`);
  }
  if (hasArtifact(tmpRoot, UID)) fail(`registry STILL contains ${UID} after delete.`);
  console.log(`PASS — DELETE: ${UID} removed; validate PASS.`);

  // --- 6. back to baseline --------------------------------------------------
  const finalCount = artifactCount(tmpRoot);
  if (finalCount !== baseCount) {
    fail(`final artifact count is ${finalCount}, expected baseline ${baseCount}.`);
  }
  const finalValidate = runForge(tmpRoot, "validate", []);
  if ((finalValidate?.summary?.errors ?? -1) !== 0) {
    fail(`final validate is not clean: ${JSON.stringify(finalValidate?.summary)}`);
  }
  console.log(`PASS — registry + validate back to baseline (${finalCount} artifacts, 0 errors).`);

  // Extra: the serializer emits keys in canonical order (stable re-serialize).
  const fmText = serializeBundleFrontmatter(baseFrontmatter());
  const keyOrder = [...fmText.matchAll(/^([A-Za-z_][\w-]*):/gm)].map((m) => m[1]);
  const expected = [
    "id", "title", "version", "status", "work_type", "invariants", "adrs",
    "spec_sections", "br_ids", "conformance", "modules", "skill",
    "secondary_skill", "agent", "reviewer", "dod_ref", "invisible_20", "human_gate",
  ];
  if (JSON.stringify(keyOrder) !== JSON.stringify(expected)) {
    fail(`emitted key order is not canonical:\n  got      ${keyOrder.join(", ")}\n  expected ${expected.join(", ")}`);
  }
  console.log("PASS — frontmatter key order is canonical (18 keys, schema order).");

  console.log("\nALL BUNDLE-CRUD ASSERTIONS PASSED.");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

process.exit(0);
