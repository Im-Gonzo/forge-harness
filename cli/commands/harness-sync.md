---
description: Update an already-tailored project. Re-profiles, diffs the module set + file checksums vs .forge.json, upgrades unchanged generated files, and proposes merges for user-edited ones — never clobbers.
argument-hint: "[--dry-run] (preview the plan without writing)"
allowed-tools: Bash, Read, Skill
---

# /harness-sync — bring an existing harness up to date

Upgrade a project that **already has** a Forge harness: pick up the current Forge version, add components for
stack the project has grown into (e.g. it added Postgres), and refresh generated files — while treating every
user edit as sacred. Thin frontend over the `forge` CLI (`forge sync`) and the `skills/bootstrap-harness/` skill.
Honors `../docs/ARCHITECTURE.md` §7: **additive, never destructive**; updates are **checksum-guarded**.

## Preflight — STOP if there is no marker

```bash
test -f .claude/.forge.json && echo "FORGE_MARKER_PRESENT" || echo "NO_MARKER"
```

- No `.claude/.forge.json` → there is nothing to sync. This project was never tailored. Point the user to
  **/harness-init** and stop.
- Marker present → continue.

## What sync does (`../docs/BOOTSTRAP.md` §idempotent update)

1. **Re-profile (deterministic, read-only).** Re-run `bootstrap/profile-project.mjs` to get fresh stack facts
   into `.claude/profile-project.json`. The stack may have changed since `generatedAt`.

2. **Diff the module set.** Re-compose from the new facts (`../manifests/profiles.json` +
   `../manifests/modules.json` + `moduleSelectionRules`) and diff the resulting module set against the marker's
   `modules`. **Newly-detected modules** (e.g. `database` because the project added Postgres; `eval` because
   tests now exist) get their components **added**. Dropped signals are reported, not silently removed — propose,
   let the user decide.

3. **Diff file checksums (the sacred part).** For each file in the marker's `files[]`, compare its **on-disk**
   checksum to the recorded one:
   - **Unchanged** (checksum matches) → safe to **upgrade** to the current Forge version's template.
   - **User-edited** (checksum drift) → **NEVER overwrite.** Show a diff (new template vs the user's file) and
     **propose a merge**. The user decides. This is the whole point of the marker.

4. **Report Forge version drift.** Compare the marker's `forgeVersion` to the installed Forge `VERSION`. State
   what an upgrade brings.

## Procedure

1. **Preview (always first).** Run sync in dry-run to show the plan before any write:

   ```bash
   forge sync . --dry-run 2>/dev/null || forge doctor .
   ```

   Present: modules to add, files to upgrade (unchanged), files needing a merge (drifted), and the version delta.
   If `$ARGUMENTS` contains `--dry-run`, stop here and report — write nothing.

2. **Apply, guarded.** With the user's go-ahead:

   ```bash
   forge sync .
   ```

   `forge sync` upgrades only checksum-clean files, adds components for newly-detected modules, and rewrites the
   marker (new checksums + bumped `forgeVersion`). If `forge sync` is **unavailable** in this Forge build, fall
   back to the `skills/bootstrap-harness/` skill and walk the steps by hand: re-profile → re-compose → diff →
   add-only the new module components → upgrade only unchanged files → for each drifted file, show the diff and
   propose a merge → rewrite `.forge.json`.

3. **Constitution drift.** If the constitution (`AGENTS.md` / `CLAUDE.md`) is user-edited, never overwrite —
   show the diff and propose the merge, same as any other drifted file. New invariants from the current profile
   are offered as additions, not replacements.

4. **Validate + report.** Run `forge validate`, then list: components added, files upgraded, files left for the
   user to merge (with diffs), and the new marker version.

## Guardrails

- **Never clobber.** Checksum drift ⇒ diff + merge proposal, never an overwrite. User edits are sacred
  (invariant #1).
- **Additive.** Sync adds components for new modules and upgrades clean files; it does not delete the user's
  customizations.
- **Idempotent.** A second sync with no changes is a no-op that reports "already current."
- **Evidence before claims:** "upgraded / merged / validated" comes from fresh `forge sync` + `forge validate`
  output shown to the user, never from memory.

## Related

- First-time generation (no marker yet) → **/harness-init**.
- Read-only health check → **/harness-doctor**.
