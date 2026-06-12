---
description: Read-only health check of a project's Forge harness — marker validity, resolvable global references, live hook commands, and Forge version drift. Reports only; fixes solely with explicit --fix.
argument-hint: "[--fix] (apply safe repairs instead of reporting only)"
allowed-tools: Bash, Read
---

# /harness-doctor — diagnose a Forge harness (read-only)

Verify that this project's tailored harness is intact and current. **Read-only by default** — it reports, it does
not change anything. Repairs run **only** when the user passes `--fix`. Thin frontend over `forge doctor`. Honors
`../docs/ARCHITECTURE.md` §7: diagnosis never auto-mutates; any fix is additive and confirmed.

## Run the check

```bash
forge doctor .
```

`forge doctor` is the source of truth for the diagnosis. Pass `$ARGUMENTS` through (notably `--fix`). The checks:

1. **Marker present & valid.** `.claude/.forge.json` exists and validates against
   `../schemas/marker.schema.json` (forgeVersion, profile, modules, files[] with checksum + userEditable). A
   missing marker means this project was never tailored → point to **/harness-init**.

2. **Referenced global components resolve.** Every global agent / skill / rule the harness points at (it
   references, never copies — `../docs/ARCHITECTURE.md` §2) resolves to a real file in the installed Forge plugin.
   Dangling references are reported with the exact missing path.

3. **Hook commands still exist.** Every command wired into `.claude/settings.json` hooks (the detected real
   commands — e.g. `uv run mypy .`, `pnpm -s tsc --noEmit`) is still runnable. A hook pointing at a tool the
   project removed is a silent gate failure — surface it.

4. **Checksum integrity.** Compare each `files[]` entry's on-disk checksum to the recorded one. Report drift as
   **informational** (user-edited files are expected to drift; that is not an error) — do not "fix" drift here;
   that belongs to **/harness-sync** with its diff-and-merge flow.

5. **Forge version drift.** Compare the marker's `forgeVersion` to the installed Forge `VERSION`. If behind,
   report it and recommend **/harness-sync** to upgrade — do not upgrade from doctor.

## Output contract

Return, from the `forge doctor` output (do not re-derive by hand):

- Overall status: `healthy` / `warnings` / `errors`.
- Per-check result with **exact file paths** for any failure.
- Version line: marker `forgeVersion` vs installed `VERSION`.
- Recommended next action (e.g. "run /harness-sync to upgrade", "run /harness-init — no marker found").

## Fixing (only with --fix)

Without `--fix`: **report only. Change nothing.** This is invariant #2 — diagnosis never auto-mutates.

With `--fix` (and only then): apply **safe, additive** repairs — re-resolve a moved global reference, re-pin a
hook to a still-present command, regenerate a missing seed. Each fix is shown before it is applied. Doctor
**never** touches user-edited files, never overwrites the constitution, and never performs the sync upgrade —
checksum-drift merges and version upgrades route to **/harness-sync**, which has the diff-and-merge machinery.

## Guardrails

- **Read-only by default.** No `--fix` ⇒ zero writes.
- **Drift is not an error.** A user-edited file failing its checksum is expected; report it, don't repair it.
- **Stay in lane.** Doctor diagnoses; **/harness-sync** upgrades and merges; **/harness-init** generates.
- **Evidence before claims:** every status line comes from a fresh `forge doctor` run shown in the output.
