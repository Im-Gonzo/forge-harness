# EVAL-FLEET — Fleet & Provenance acceptance specs

> RED-first (`evals/README.md`). Every case fails on today's tree (no provenance field, no fleet module
> exist yet). Provenance cases (`-001`, `-002`) are **v0.2**; fleet-read cases are **v0.3**; fleet-write
> cases are **v0.5** — the latter two tiers are **DEFERRED, Tier 3** (`ideas/01-proportionality.md`).
> Drift compute and sync reuse the existing `cmdDoctor`/`cmdSync` logic — cases assert *behavior*, not a
> re-implementation.

### EVAL-FLEET-001 — `sourceRev` computed correctly + schema widening additive
- **Verifies:** BR-FLEET-001, BR-FLEET-002
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a fixture project `{profile, modules}` and a built Registry, **when** `forge init --apply` runs, **then** the marker's `provenance.sourceRev` equals an independently recomputed `sha256` over the sorted `{uid: contentHash}` of the resolved components, and `provenance.registrySchema` is set. Reordering the resolved set yields the **same** `sourceRev` (order-independence). Schema arm: the pre-change marker corpus validates against the widened `marker.schema.json` unchanged; a well-formed `provenance` validates; an *unknown* extra top-level key still fails (`additionalProperties:false` preserved).
- **Fixture:** sample project + committed `registry.json`; a recompute helper; the pre-provenance marker corpus.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-FLEET-002 — Legacy marker → version-level drift only
- **Verifies:** BR-FLEET-003
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a valid marker with **no** `provenance`, **when** the manager assesses drift, **then** it reports only `versionBehind` (via the existing `forgeVersion` check), sets `componentsBehind = null` (unknown), and **never raises an error**.
- **Fixture:** a provenance-less marker + a Registry one revision ahead.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-FLEET-003 — Drift detection (version + component, `--component R`, advisory, cheap gate)
- **Verifies:** BR-FLEET-004, BR-FLEET-012, BR-FLEET-022, BR-FLEET-023
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a registered project and a Registry where component R advanced 2 revisions since tailor, **when** `forge fleet drift --component R` runs, **then** it reports R as 2 behind (computed live from the Registry, with no per-component data in the marker), scopes output to projects resolving to R, emits the finding at advisory `WARN` level, and a project whose `markerChecksum` is unchanged is served from cache without re-hashing its files.
- **Fixture:** a 2-project fleet index; a Registry with R advanced; a project that does/does not resolve to R.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-FLEET-004 — User edits are sacred during sync (merge staged, not clobbered) + grade
- **Verifies:** BR-FLEET-020, BR-FLEET-013
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a copied file the user has edited (checksum drift) and an upstream change to it, **when** `forge fleet sync <id> --apply` runs, **then** the **live file is byte-identical** to before, `base`/`yours`/`new` are written under `<project>/.claude/.forge-merge/`, and the project is flagged `needs-manual-merge`. Grade arm: a project whose only deviation is user-edited files grades `healthy`; introducing a missing tracked file flips it to `unhealthy`.
- **Fixture:** project with one user-edited copied file; upstream library with a newer version of it.
- **Phase:** v0.5
- **Status:** RED (deferred)

### EVAL-FLEET-005 — Fail-open on corrupt `fleet.json` + module contract
- **Verifies:** BR-FLEET-014, BR-FLEET-024
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given `~/.claude/forge/fleet.json` truncated to invalid JSON, **when** `forge init --apply`, `forge doctor`, and `forge sync` each run, **then** all three complete successfully (valid marker / report produced) and **none throws**; the fleet is reported "unavailable". Contract arm: `lint/validate-fleet.mjs` is auto-discovered and asserts `manager/fleet.mjs` exports `run`/`summarize`, is dry-run by default, and writes nothing outside the machine-local root.
- **Fixture:** corrupt `fleet.json`; the manager module + its paired validator.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-FLEET-006 — Opt-in, default OFF; registration is offered, not silent
- **Verifies:** BR-FLEET-007, BR-FLEET-008
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a clean machine (`fleetEnabled` absent/false), **when** `forge init --apply` then `doctor`/`sync` run, **then** **no** `fleet.json` is created. After `forge fleet enable`, **when** `doctor` runs against an unregistered project non-interactively (no confirmation), **then** it **offers** registration and still writes nothing to `fleet.json`; only an explicit confirmation (or `fleet add`) registers it.
- **Fixture:** empty `$HOME`; one tailored project; non-interactive invocation harness.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-FLEET-007 — Index is disposable; marker always wins
- **Verifies:** BR-FLEET-005, BR-FLEET-006
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a populated `fleet.json`, **when** it is deleted and `forge fleet scan` runs, **then** an equivalent index is reproduced from markers alone. And given a row with stale `profile`/`modules` that disagree with the marker, **when** reconcile runs, **then** the row is corrected to match the marker and the **marker is never rewritten** from the row.
- **Fixture:** a fleet of 2 projects; a deliberately stale row.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-FLEET-008 — Row schema complete + honest staleness, no daemon
- **Verifies:** BR-FLEET-009, BR-FLEET-010
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a registered fixture project, **when** it is reconciled, **then** its row has every required field (`id`, `path`, `tailoredFrom`, `profile`, `modules[]`, `generatedAt`, `lastSyncedAt`, `lastSeenAt`, `markerChecksum`, `status`, full `health{}`) well-typed, `id = sha256(realpath)[:16]`. `fleet status` shows a per-row "reconciled Nd ago" derived from `lastSeenAt`, and **no background process** is spawned by any fleet command.
- **Fixture:** one project; a process-spawn assertion.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-FLEET-009 — `fleet scan` is bounded and skips `node_modules`/`.git`
- **Verifies:** BR-FLEET-011
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a tree with markers within `scanRoots` depth, one nested under `node_modules/`, and one under `.git/`, **when** `forge fleet scan` runs, **then** in-depth markers are discovered, the `node_modules/`- and `.git/`-nested ones are **not**, and the scan terminates within the depth bound.
- **Fixture:** a synthetic directory tree with planted markers at varying depths.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-FLEET-010 — Moved project detected; relink offered, not silent
- **Verifies:** BR-FLEET-015
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a registered project whose directory is then moved, **when** `forge fleet scan` runs, **then** the row becomes `moved` (marker matched by `generatedAt` at the new path) and a `relink` is **offered**; declining leaves `status=moved`, accepting updates `path` and restores `active`.
- **Fixture:** a project moved between two paths sharing one `generatedAt`.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-FLEET-011 — Lifecycle controls; pinned excluded from sync; files untouched
- **Verifies:** BR-FLEET-016
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a fleet, **when** `forge fleet pin <id>` then `forge fleet sync --all --apply` run, **then** the pinned project is excluded from sync. And **when** `forge fleet forget <id>` runs, **then** only the row is removed and the project's marker on disk is **untouched**.
- **Fixture:** a 2-project fleet; one pinned.
- **Phase:** v0.5
- **Status:** RED (deferred)

### EVAL-FLEET-012 — Fleet state never staged (no-personal-paths)
- **Verifies:** BR-FLEET-017
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given staged files, **when** `validate-no-personal-paths` runs, **then** it raises a finding if a `fleet.json` or a `~/.claude/forge/` path is among them, and passes when none are. Fleet state is confirmed to exist only under `~/.claude/forge/` and never inside a tailored project or the git-tracked library.
- **Fixture:** a staged-file set with and without a planted fleet path.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-FLEET-013 — `fleet sync` orchestrates per-project sync; auto-upgrade unedited
- **Verifies:** BR-FLEET-018, BR-FLEET-019
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a fleet with drifted projects, **when** `forge fleet sync --all` runs **without** `--apply`, **then** it writes nothing and prints a per-project plan. **When** run with `--apply`, **then** it invokes the existing `cmdSync` per eligible project (skipping pinned), auto-upgrades an unedited copied file to the new bytes (advancing its marker checksum), and refreshes only `sourceRev` for a referenced component (no file write). The merge logic is the existing per-project sync, not a re-implementation.
- **Fixture:** projects with unedited-copied, referenced, and pinned states; an upstream library bump.
- **Phase:** v0.5
- **Status:** RED (deferred)

### EVAL-FLEET-014 — Added module additive; removed module report-only
- **Verifies:** BR-FLEET-021
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given/When/Then:** Given a project whose resolved modules change, **when** `forge fleet sync <id> --apply` runs, **then** a newly **added** module's missing files are written additively (existing files preserved), and a **removed** module's files are **never deleted** — the removal appears only as a "would remove" report line.
- **Fixture:** a project with one module added and one removed relative to its marker.
- **Phase:** v0.5
- **Status:** RED (deferred)
