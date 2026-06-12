/**
 * verify-rule-memory-roundtrip — proves the RULE and MEMORY visual forms produce
 * frontmatter that round-trips through the bridge's additive write path: the bytes
 * the forms serialize → `forge validate` PASSES, and an UPDATE is a MINIMAL DIFF
 * (only the changed frontmatter line moves; the body stays verbatim).
 *
 * It uses the EXACT pure cores the bridge writes with (frontmatter-edit-core.mjs:
 * serializeDocument for create, updateDocument for minimal-diff update) — the same
 * modules crud.ts calls — so the verified bytes are byte-identical to production.
 *
 * SAFETY (same pattern as verify-dangling-resolve.mjs): it copies the WHOLE forge
 * harness to a TEMP dir and points all writes + the CLI at the copy. The REAL
 * harness is never read for state nor written.
 *
 * What it exercises:
 *   RULE
 *     1. CREATE a scoped rule (name + description + paths globs) via
 *        serializeDocument → write rules/verify-rule.md → validate PASS.
 *     2. UPDATE its `paths` list via updateDocument → assert ONLY the paths line
 *        changed (body + every other fm line byte-identical) → validate PASS.
 *   MEMORY
 *     3. Plant a COMPLETE vault: memory/gotchas/g-0001-verify.md (the full required
 *        frontmatter the form emits) + memory/index.md listing it. validate PASS.
 *     4. UPDATE the planted entry's `confidence` (the slider's job) via
 *        updateDocument → assert minimal diff (only confidence moved, body verbatim)
 *        → validate PASS.
 *     5. CREATE a NON-active memory note at memory/<id>.md (root) via
 *        serializeDocument — the bridge's relPathFor lands memory entries at the
 *        memory/ root (ids can't nest), so a non-active status needs no index —
 *        and assert validate STILL PASSES (the root entry is an advisory WARN only).
 *
 * Exit 0 on pass; 1 on any failed assertion. Never touches the real harness.
 *
 *   node scripts/verify-rule-memory-roundtrip.mjs
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
        /* fall through */
      }
    }
    fail(`forge ${cmd} returned non-JSON stdout:\n${raw.slice(0, 400)}`);
  }
  return null;
}

/**
 * Run the bridge's CONVERGED write cycle then validate. The bridge (crud.ts
 * runWriteCycle) writes the file, runs validate, then `registry build --write`;
 * a fresh artifact makes the FIRST validate flag the registry as stale (an
 * expected transient), and the registry rebuild clears it. We assert the
 * CONVERGED state — registry rebuilt, then validate — which is the byte-clean
 * end state the bridge always reaches (and what a subsequent edit/read sees).
 */
function validate(tmpRoot, label) {
  runForge(tmpRoot, "registry", ["build", "--write"]);
  const env = runForge(tmpRoot, "validate");
  const errors = env?.summary?.errors ?? -1;
  if (errors !== 0) {
    const errFindings = (env?.findings ?? [])
      .filter((f) => f.level === "ERROR")
      .map((f) => `${f.path}: ${f.message}`)
      .join("\n  ");
    fail(`validate reported ${errors} error(s) ${label}:\n  ${errFindings}`);
  }
  pass(`forge validate reports 0 errors ${label} (registry converged).`);
  return env;
}

/** Count how many lines differ between two texts (cheap structural diff check). */
function changedLines(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  let n = 0;
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) if (al[i] !== bl[i]) n++;
  return n;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-rule-mem-"));
try {
  fs.cpSync(REAL_FORGE_ROOT, tmpRoot, { recursive: true });
  console.log(`Temp harness copy at ${tmpRoot}\n`);

  // Baseline must be clean (so any failure below is caused by US).
  validate(tmpRoot, "(baseline, before any edit)");

  // ───────────────────────────────────────────────────────────────────────
  // RULE — create
  // ───────────────────────────────────────────────────────────────────────
  console.log("\n# RULE");
  const ruleAbs = path.join(tmpRoot, "rules", "verify-rule.md");
  const ruleBody = `# Verify Rule

> Synthetic rule planted by verify-rule-memory-roundtrip. Scoped to TS files.

- [ ] A body line that must survive verbatim across the update.
`;
  // The EXACT frontmatter shape the rule form emits: name + description + paths[].
  const ruleFmCreate = {
    name: "verify-rule",
    description: "Synthetic scoped rule for the round-trip verification.",
    paths: ["**/*.ts", "**/*.tsx"],
  };
  const ruleCreated = serializeDocument(ruleFmCreate, ruleBody);
  fs.writeFileSync(ruleAbs, ruleCreated, "utf8");

  // The paths line must serialize as a NON-EMPTY YAML LIST (validate-rules.mjs
  // rejects a scalar). Globs start with `*` so they are quoted.
  if (!/^paths:\s*\[.+\]\s*$/m.test(ruleCreated)) {
    fail(`rule create did not emit an inline paths list:\n${ruleCreated}`);
  }
  pass("rule create serialized `paths` as a non-empty inline glob list.");
  validate(tmpRoot, "(after rule create)");

  // ───────────────────────────────────────────────────────────────────────
  // RULE — minimal-diff update of `paths`
  // ───────────────────────────────────────────────────────────────────────
  const ruleFmUpdate = {
    name: "verify-rule",
    description: "Synthetic scoped rule for the round-trip verification.",
    paths: ["**/*.ts", "**/*.tsx", "**/*.mts"], // added one glob
  };
  const ruleUpdated = updateDocument(ruleCreated, ruleFmUpdate, ruleBody);
  // Body verbatim?
  const ruleBodyAfter = splitDocument(ruleUpdated).body;
  const ruleBodyBefore = splitDocument(ruleCreated).body;
  if (ruleBodyAfter !== ruleBodyBefore) {
    fail("rule update changed the body (must be verbatim).");
  }
  pass("rule update preserved the body verbatim.");
  // Minimal diff: only the `paths:` line changed (name + description untouched).
  const ruleDiffLines = changedLines(ruleCreated, ruleUpdated);
  if (ruleDiffLines !== 1) {
    fail(
      `rule update changed ${ruleDiffLines} lines (expected exactly 1 — the paths line).\n--- before\n${ruleCreated}\n--- after\n${ruleUpdated}`,
    );
  }
  pass("rule update is a minimal diff (only the `paths` line changed).");
  fs.writeFileSync(ruleAbs, ruleUpdated, "utf8");
  validate(tmpRoot, "(after rule paths update)");

  // ───────────────────────────────────────────────────────────────────────
  // MEMORY — plant a complete vault (entry under a type dir + index)
  // ───────────────────────────────────────────────────────────────────────
  console.log("\n# MEMORY");
  const memDir = path.join(tmpRoot, "memory");
  const gotchasDir = path.join(memDir, "gotchas");
  fs.mkdirSync(gotchasDir, { recursive: true });

  const memBody = `## Summary

A synthetic gotcha planted to verify the memory form's frontmatter round-trips.

## Detail

Symptom / Cause / Fix-guard for the verification entry. See also [[g-0002-verify]].

## Evidence

- 2026-06-06 — observed by verify-rule-memory-roundtrip.mjs writing this entry and running \`forge validate\` to PASS.

## See also

- [[g-0002-verify]]
`;
  // The EXACT scalar frontmatter the memory form emits (required keys + tags +
  // links), all FLAT so it is minimal-diff editable and serializes byte-clean.
  const memFm = {
    id: "g-0001-verify",
    title: "Synthetic gotcha for round-trip verification",
    type: "gotcha",
    status: "active",
    created: "2026-06-06",
    updated: "2026-06-06",
    confidence: 0.5,
    tags: ["verification", "memory-form"],
    links: ["g-0002-verify"],
  };
  const memCreated = serializeDocument(memFm, memBody);
  const memAbs = path.join(gotchasDir, "g-0001-verify.md");
  fs.writeFileSync(memAbs, memCreated, "utf8");

  // confidence MUST serialize as a bare NUMBER (not a quoted string).
  if (!/^confidence:\s*0\.5\s*$/m.test(memCreated)) {
    fail(`memory create did not serialize confidence as a number:\n${memCreated}`);
  }
  pass("memory create serialized `confidence` as a bare number (0.5).");

  // The link target [[g-0002-verify]] must resolve → plant the sibling entry.
  const sibBody = `## Summary

The link target for g-0001-verify.

## Evidence

- 2026-06-06 — planted as the [[g-0001-verify]] link target.
`;
  const sibFm = {
    id: "g-0002-verify",
    title: "Link target for the verification gotcha",
    type: "gotcha",
    status: "active",
    created: "2026-06-06",
    updated: "2026-06-06",
    confidence: 0.6,
    tags: ["verification"],
    links: ["g-0001-verify"],
  };
  fs.writeFileSync(
    path.join(gotchasDir, "g-0002-verify.md"),
    serializeDocument(sibFm, sibBody),
    "utf8",
  );

  // The index must list every ACTIVE entry (freshness invariant).
  fs.writeFileSync(
    path.join(memDir, "index.md"),
    `# Memory Index

- g-0001-verify — Synthetic gotcha for round-trip verification
- g-0002-verify — Link target for the verification gotcha
`,
    "utf8",
  );
  validate(tmpRoot, "(after planting the memory vault)");

  // ───────────────────────────────────────────────────────────────────────
  // MEMORY — minimal-diff update of `confidence` (the slider's job)
  // ───────────────────────────────────────────────────────────────────────
  const memFmUpdate = { ...memFm, confidence: 0.85 };
  const memUpdated = updateDocument(memCreated, memFmUpdate, memBody);
  const memBodyAfter = splitDocument(memUpdated).body;
  if (memBodyAfter !== splitDocument(memCreated).body) {
    fail("memory update changed the body (must be verbatim).");
  }
  pass("memory update preserved the body verbatim (Evidence + [[links]] intact).");
  const memDiffLines = changedLines(memCreated, memUpdated);
  if (memDiffLines !== 1) {
    fail(
      `memory confidence update changed ${memDiffLines} lines (expected exactly 1).`,
    );
  }
  if (!/^confidence:\s*0\.85\s*$/m.test(memUpdated)) {
    fail(`memory update did not write confidence: 0.85:\n${memUpdated}`);
  }
  pass("memory confidence update is a minimal diff (only the `confidence` line).");
  fs.writeFileSync(memAbs, memUpdated, "utf8");
  validate(tmpRoot, "(after memory confidence update)");

  // ───────────────────────────────────────────────────────────────────────
  // MEMORY — create a NON-active note at memory/<id>.md (bridge root path)
  // ───────────────────────────────────────────────────────────────────────
  // relPathFor("memory", id) → memory/<id>.md (ids can't nest), so a created
  // entry lands at the memory/ ROOT. A non-active status needs no index entry,
  // and a root entry is only an advisory WARN — validate must still PASS.
  const rootFm = {
    id: "l-0003-verify",
    title: "Root-level non-active memory note",
    type: "learning",
    status: "deprecated",
    created: "2026-06-06",
    updated: "2026-06-06",
    confidence: 0.3,
    tags: [],
  };
  const rootBody = `## Summary

A deprecated learning created at the memory root via the bridge path.

## Evidence

- 2026-06-06 — created by the verification script at memory/l-0003-verify.md.
`;
  fs.writeFileSync(
    path.join(memDir, "l-0003-verify.md"),
    serializeDocument(rootFm, rootBody),
    "utf8",
  );
  const rootEnv = validate(tmpRoot, "(after root-level non-active memory create)");
  // Sanity: there SHOULD be advisory WARN(s) for the root entry, never an error.
  const warns = rootEnv?.summary?.warnings ?? 0;
  console.log(`        (${warns} advisory WARN(s) — non-blocking, ADR-0007).`);

  // ───────────────────────────────────────────────────────────────────────
  // registry rebuild + final clean state
  // ───────────────────────────────────────────────────────────────────────
  runForge(tmpRoot, "registry", ["build", "--write"]);
  validate(tmpRoot, "(final — after registry rebuild)");

  console.log("\nALL RULE + MEMORY ROUND-TRIP ASSERTIONS PASSED.");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

process.exit(0);
