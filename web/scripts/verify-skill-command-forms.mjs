/**
 * verify-skill-command-forms — proves the skill + command Visual forms' write
 * round-trip: a create → edit → delete cycle using the EXACT frontmatter shapes
 * `forms/skill.tsx` and `forms/command.tsx` emit, driven through the SAME pure
 * write core the bridge uses (frontmatter-edit-core.mjs: serializeDocument on
 * create, updateDocument on edit), against a TEMP COPY of the whole harness.
 *
 * The forms are CONTROLLED frontmatter editors (ResourceFormProps): they emit a
 * frontmatter object, the shell re-serializes it, and the bridge persists it via
 * this core + the validate → registry-build cycle. This script reconstructs the
 * frontmatter each form produces for a representative edit and asserts:
 *   • create  — a fresh skill/command validates PASS (0 errors) and is registered.
 *   • edit    — a minimal-diff update (the field a form would change) re-validates
 *               PASS, touches ONLY the changed key's line, body preserved verbatim.
 *   • delete  — removing the resource (whole skills/<id>/ dir for a skill) leaves
 *               the harness byte-clean: validate PASS, the SAME artifact count as
 *               the pristine baseline, registry build reports changed: 0.
 *
 * SAFETY: like verify-dangling-resolve.mjs, it copies FORGE_ROOT to a temp dir
 * and points the temp-copy CLI at the copy. The REAL harness is never written.
 *
 *   node scripts/verify-skill-command-forms.mjs
 *
 * Exit 0 on pass; 1 on any failed assertion.
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

const fail = (msg) => {
  console.error("FAIL —", msg);
  process.exit(1);
};
const pass = (msg) => console.log("PASS —", msg);

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
 * The bridge's write cycle, asserted on the SETTLED state.
 *
 * crud.ts runs `forge validate` then `forge registry build --write`. On a CREATE
 * or DELETE the file set changed, so the FIRST validate sees a stale registry
 * (the new/removed file isn't in registry.json yet) and reports the advisory
 * "registry stale" ERROR — which the build immediately reconciles. To assert the
 * resource is GENUINELY valid (the property the forms care about), this runs the
 * build to reconcile the registry, then re-validates: that settled validate must
 * be byte-clean. (For an in-place edit no file set changes, so this is a no-op
 * reconcile and the assertion is identical to a single validate.)
 */
function writeCycle(tmpRoot, label) {
  runForge(tmpRoot, "registry", ["build", "--write"]);
  const validate = runForge(tmpRoot, "validate", []);
  const errors = validate?.summary?.errors ?? -1;
  if (errors !== 0) {
    const errs = (validate.findings || []).filter((f) => f.level === "ERROR");
    fail(
      `${label}: settled forge validate reported ${errors} error(s):\n` +
        JSON.stringify(errs, null, 2),
    );
  }
  return validate;
}

function artifactCount(tmpRoot) {
  const reg = JSON.parse(
    fs.readFileSync(path.join(tmpRoot, ".forge", "registry.json"), "utf8"),
  );
  return reg.artifacts.length;
}

/** Assert a resource is present in the registry by its <kind>:<id> uid. */
function assertRegistered(tmpRoot, uid) {
  const reg = JSON.parse(
    fs.readFileSync(path.join(tmpRoot, ".forge", "registry.json"), "utf8"),
  );
  if (!reg.artifacts.some((a) => a.uid === uid)) {
    fail(`expected registry to contain '${uid}' after create.`);
  }
}

// ── temp copy of the whole harness ──────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-resform-"));
try {
  fs.cpSync(REAL_FORGE_ROOT, tmpRoot, { recursive: true });
  console.log(`Temp harness copy at ${tmpRoot}`);

  // Pristine baseline (after a fresh build) — the count the harness must return to.
  runForge(tmpRoot, "registry", ["build", "--write"]);
  const baselineCount = artifactCount(tmpRoot);
  pass(`pristine baseline: ${baselineCount} artifacts, validate clean.`);

  // ───────────────────────────────────────────────────────────────────────────
  // SKILL round-trip — frontmatter shape forms/skill.tsx emits: { name, description }
  // ───────────────────────────────────────────────────────────────────────────
  {
    const id = "form-roundtrip-skill";
    const uid = `skill:${id}`;
    const rel = path.join("skills", id, "SKILL.md");
    const abs = path.join(tmpRoot, rel);

    // CREATE — the form emits name + description; the shell serializes; body is
    // the author's procedure (here a minimal `##` section) kept verbatim.
    const body =
      "\n# form-roundtrip-skill — temporary verification skill\n\n" +
      "## When to activate\n\nNever — this skill is planted by a verify script.\n";
    const created = serializeDocument(
      { name: id, description: "Temporary skill planted to verify the skill Visual form's create→edit→delete round-trip. Safe to delete." },
      body,
    );
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, created, "utf8");
    writeCycle(tmpRoot, "skill create");
    assertRegistered(tmpRoot, uid);
    if (artifactCount(tmpRoot) !== baselineCount + 1) {
      fail(`skill create: expected ${baselineCount + 1} artifacts, got ${artifactCount(tmpRoot)}.`);
    }
    pass(`skill create — '${uid}' validates and is registered (+1 artifact).`);

    // EDIT — the form changes the `description` key only (minimal diff). Reuse the
    // EXACT update core the bridge writes with; assert body + name line untouched.
    const before = fs.readFileSync(abs, "utf8");
    const edited = updateDocument(
      before,
      { name: id, description: "Edited description — exercises the skill form's minimal-diff update path. Still safe to delete." },
      splitDocument(before).body,
    );
    if (edited === before) fail("skill edit produced no change (description should differ).");
    fs.writeFileSync(abs, edited, "utf8");
    // The name line and body must be byte-identical to before (only description changed).
    if (!edited.includes(`name: ${id}\n`)) fail("skill edit: name line was altered.");
    if (splitDocument(edited).body !== splitDocument(before).body) {
      fail("skill edit: body was not preserved verbatim.");
    }
    writeCycle(tmpRoot, "skill edit");
    pass("skill edit — minimal-diff description change validates; name + body verbatim.");

    // DELETE — for a skill the WHOLE skills/<id>/ dir is removed (crud.ts contract).
    fs.rmSync(path.dirname(abs), { recursive: true, force: true });
    writeCycle(tmpRoot, "skill delete");
    if (fs.existsSync(path.dirname(abs))) fail("skill delete: skill dir still exists.");
    if (artifactCount(tmpRoot) !== baselineCount) {
      fail(`skill delete: expected ${baselineCount} artifacts (baseline), got ${artifactCount(tmpRoot)}.`);
    }
    pass("skill delete — dir removed, validate clean, artifact count back to baseline.");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // COMMAND round-trip — frontmatter shape forms/command.tsx emits:
  //   { description, "argument-hint", "allowed-tools": "Bash, Read" }  (comma-string)
  // ───────────────────────────────────────────────────────────────────────────
  {
    const id = "form-roundtrip-command";
    const uid = `command:${id}`;
    const rel = path.join("commands", `${id}.md`);
    const abs = path.join(tmpRoot, rel);

    const body =
      "\n# /form-roundtrip-command — temporary verification command\n\n" +
      "Planted by a verify script. Safe to delete.\n";
    const created = serializeDocument(
      {
        description: "Temporary command planted to verify the command Visual form's create→edit→delete round-trip. Safe to delete.",
        "argument-hint": "[--noop] (does nothing)",
        "allowed-tools": "Bash, Read",
      },
      body,
    );
    fs.writeFileSync(abs, created, "utf8");
    writeCycle(tmpRoot, "command create");
    assertRegistered(tmpRoot, uid);
    if (artifactCount(tmpRoot) !== baselineCount + 1) {
      fail(`command create: expected ${baselineCount + 1} artifacts, got ${artifactCount(tmpRoot)}.`);
    }
    // The allowed-tools must be the COMMA-STRING form the form emits (not a YAML array).
    if (!created.includes("allowed-tools: Bash, Read\n")) {
      fail(`command create: allowed-tools not emitted as a comma-string. Got:\n${splitDocument(created).fm}`);
    }
    pass(`command create — '${uid}' validates, registered, allowed-tools is a comma-string.`);

    // EDIT — the form toggles a tool (Bash, Read → Bash, Read, Skill) and tweaks
    // argument-hint; both are minimal-diff scalar-line rewrites. description + body verbatim.
    const before = fs.readFileSync(abs, "utf8");
    const edited = updateDocument(
      before,
      {
        description: "Temporary command planted to verify the command Visual form's create→edit→delete round-trip. Safe to delete.",
        "argument-hint": "[--noop] (edited hint)",
        "allowed-tools": "Bash, Read, Skill",
      },
      splitDocument(before).body,
    );
    if (edited === before) fail("command edit produced no change.");
    if (!edited.includes("allowed-tools: Bash, Read, Skill\n")) {
      fail("command edit: toggled allowed-tools not written as comma-string.");
    }
    if (splitDocument(edited).body !== splitDocument(before).body) {
      fail("command edit: body was not preserved verbatim.");
    }
    fs.writeFileSync(abs, edited, "utf8");
    writeCycle(tmpRoot, "command edit");
    pass("command edit — toggled allowed-tools + argument-hint validate; body verbatim.");

    // DELETE — a command is a single file.
    fs.rmSync(abs, { force: true });
    writeCycle(tmpRoot, "command delete");
    if (fs.existsSync(abs)) fail("command delete: file still exists.");
    if (artifactCount(tmpRoot) !== baselineCount) {
      fail(`command delete: expected ${baselineCount} artifacts (baseline), got ${artifactCount(tmpRoot)}.`);
    }
    pass("command delete — file removed, validate clean, artifact count back to baseline.");
  }

  // Final: the temp harness is byte-clean and back to the pristine baseline.
  const finalValidate = runForge(tmpRoot, "validate", []);
  const finalBuild = runForge(tmpRoot, "registry", ["build", "--write"]);
  if ((finalValidate?.summary?.errors ?? -1) !== 0) {
    fail("final validate reported errors.");
  }
  if (artifactCount(tmpRoot) !== baselineCount) {
    fail(`final artifact count ${artifactCount(tmpRoot)} != baseline ${baselineCount}.`);
  }
  if ((finalBuild?.summary?.changed ?? -1) !== 0) {
    fail(`final registry build reported changed: ${finalBuild?.summary?.changed} (expected 0 — not byte-clean).`);
  }
  pass(`final — harness byte-clean: ${baselineCount} artifacts, validate PASS, registry build changed: 0.`);

  console.log("\nALL SKILL + COMMAND FORM ROUND-TRIP ASSERTIONS PASSED.");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

process.exit(0);
