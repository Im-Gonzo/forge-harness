# Business Rules — Fleet & Provenance (BR-FLEET)

> **Scope & deferral.** The *provenance* half (BR-FLEET-001..004, **v0.2**) is the cheap, non-deferred
> Bundle-B slice: the marker gains one `sourceRev` field. The *fleet* half (BR-FLEET-005..024) is
> **DEFERRED — Tier 3** per `ideas/01-proportionality.md`: read-only fleet in **v0.3**, write/merge in
> **v0.5**. Every rule is tagged with its phase. Cross-dimension primitives are referenced by prefix only:
> Registry `contentHash` = *see BR-REG / ADR-0005*; CLI verb taxonomy = *see BR-CLI / ADR-0015*;
> fail-open & detect-and-offer = *see BR-INT*.

---

## Provenance (v0.2 — not deferred)

### BR-FLEET-001 — Marker carries `provenance.sourceRev`
**Rule:** `forge init --apply` MUST write `provenance.sourceRev = "sha256:" + sha256hex(canonical(sorted({uid: contentHash})))` into the project marker, folding the `contentHash` of **every component the project's `{profile, modules}` resolve to** (hashes read from the Registry — *see BR-REG / ADR-0005*). It MUST also write `provenance.registrySchema`. The map MUST be sorted by `uid` before serialization so the fold is order-independent and reproducible.
**Rationale:** One cheap hash answers "is this project in sync?" without duplicating the Registry in the marker (`ADR-0009`).
**Acceptance:** Given a fixture project + Registry, `init --apply` produces a marker whose `provenance.sourceRev` equals the independently recomputed fold; reordering the resolved set does not change it. → **EVAL-FLEET-001**
**Priority:** MUST
**Refs:** ADR-0009, ADR-0005, SPEC-04

### BR-FLEET-002 — Marker schema widening is a controlled, additive change
**Rule:** Adding `provenance` MUST be done by widening `schemas/marker.schema.json` (today `"additionalProperties": false`) to allow an **optional** `provenance` object; the marker's `required` set MUST remain unchanged. Every marker valid before the change MUST remain valid after it.
**Rationale:** `additionalProperties:false` makes any marker field a controlled schema change; keep it additive so legacy markers never break (invariant #2; `ADR-0009`).
**Acceptance:** The pre-change marker corpus validates against the widened schema unchanged; a marker with a well-formed `provenance` validates; a marker with an *unknown* extra key still fails. → **EVAL-FLEET-001** (schema arm)
**Priority:** MUST
**Refs:** ADR-0009, SPEC-04

### BR-FLEET-003 — Legacy markers degrade to version-level drift only
**Rule:** A marker without `provenance` MUST be treated as valid and yield **version-level drift only**: the manager falls back to the `forgeVersion` comparison (the existing `cmdDoctor` version-drift check) and MUST NOT report component-level drift for it until the project gains a `sourceRev`.
**Rationale:** Forward/backward compatibility; the manager never errors on a pre-provenance marker (`ADR-0009`).
**Acceptance:** A provenance-less marker reports `componentsBehind = null` (unknown) and only version drift; it never raises an error. → **EVAL-FLEET-002**
**Priority:** MUST
**Refs:** ADR-0009, SPEC-04

### BR-FLEET-004 — "N revisions behind" is derived on demand, never stored
**Rule:** Per-component "behind by N revisions" MUST be computed at query time by recomputing each resolved component's current `contentHash` from the Registry and diffing against the set folded into `sourceRev` (counting revisions via Registry history — *see BR-REG / ADR-0006*). It MUST NOT be persisted per project in the marker or fleet row.
**Rationale:** Keeps the marker minimal and the Registry the single home of revision history (`ADR-0009`).
**Acceptance:** With a Registry where component R advanced 2 revisions since tailor, `fleet drift --component R` reports R as 2 behind, computed live, with no per-component data in the marker. → **EVAL-FLEET-003** (component arm)
**Priority:** MUST
**Refs:** ADR-0009, ADR-0006, SPEC-04

---

## Fleet index & lifecycle (v0.3 read-only — DEFERRED, Tier 3)

### BR-FLEET-005 — Fleet index is a machine-local, disposable cache
**Rule:** The fleet index MUST live at `~/.claude/forge/fleet.json` (machine-local root, `C6`), MUST NEVER be written under git-tracked `forge/.forge/`, and MUST be fully reconstructable by re-scanning markers. Deleting it MUST lose nothing but the index.
**Rationale:** No third source of truth; the marker is authoritative (`ADR-0010`, `C6`).
**Acceptance:** Deleting `fleet.json` then running `fleet scan` reproduces an equivalent index from markers alone. → **EVAL-FLEET-007**
**Priority:** MUST
**Refs:** ADR-0010, ADR-0003, SPEC-04

### BR-FLEET-006 — Per-project truth always wins
**Rule:** On any conflict between a `fleet.json` row and a project's marker, the marker MUST be believed and the row corrected. `~/.claude/.forge-install-state.json` remains authoritative for global-install facts; `fleet.json` MUST NOT contradict either.
**Rationale:** The cache never overrides truth (`ADR-0010`, `C6`).
**Acceptance:** A row with stale `profile`/`modules` is corrected to match the marker on reconcile; the marker is never rewritten from the row. → **EVAL-FLEET-007**
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-007 — Fleet is opt-in, default OFF
**Rule:** `fleetEnabled` MUST default to **false**. A project MUST be registered **only** via (a) `forge init --apply` run after `forge fleet enable`, or (b) `forge fleet add .`. With the fleet disabled and no explicit `add`, `init`/`doctor`/`sync` MUST NOT write `fleet.json`.
**Rationale:** Privacy-first; the manager does not silently build a map of the user's machine (#6; `ADR-0010`).
**Acceptance:** On a clean machine, `init --apply` followed by `doctor`/`sync` produces **no** `fleet.json`; only after `fleet enable` (or `fleet add`) does registration occur. → **EVAL-FLEET-006**
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-008 — Registration is detect-and-offer, never silent global mutation
**Rule:** When `doctor`/`sync` encounter an unregistered marker while the fleet is enabled, they MUST **offer** registration and MUST NOT register silently. Registration is a global-state change and MUST require explicit confirmation (*see BR-INT*).
**Rationale:** Detect-and-offer-never-auto-mutate (invariant #3; `ADR-0010`).
**Acceptance:** Run non-interactively (no confirmation), `doctor` on an unregistered project reports the offer and writes nothing to `fleet.json`. → **EVAL-FLEET-006** (offer arm)
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-009 — Fleet row schema
**Rule:** Each registered project MUST be recorded with: `id = sha256(realpath)[:16]`, `path`, `tailoredFrom` (= marker `forgeVersion`), `profile`, `modules[]`, `generatedAt`, `lastSyncedAt`, `lastSeenAt`, `markerChecksum` (`sha256` of the marker bytes), `status` (`active|stale|moved|missing|ignored|pinned`), and `health{versionBehind, componentsBehind, userEditedFiles, missingFiles, brokenRefs, grade}`.
**Rationale:** Enough to answer drift cheaply; `markerChecksum` is the freshness gate (`ADR-0010`).
**Acceptance:** A registered fixture project produces a row with every required field populated and well-typed. → **EVAL-FLEET-008**
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-010 — No daemon; refresh is opportunistic + user-driven
**Rule:** The manager MUST NOT run a background process or file-watcher to maintain the index. Refresh MUST be opportunistic (`doctor`/`sync` update the one project's row) or explicit (`forge fleet scan`). The UI MUST display staleness honestly as "last reconciled Nd ago".
**Rationale:** Proportionality; no always-on cost; honest staleness over false liveness (`ADR-0010`).
**Acceptance:** No process is spawned by any fleet command; `fleet status` shows a per-row "reconciled" age derived from `lastSeenAt`. → **EVAL-FLEET-008** (staleness arm)
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-011 — `fleet scan` is bounded and skips noise
**Rule:** `forge fleet scan` MUST crawl configured `scanRoots` for `**/.claude/.forge.json` at **bounded depth**, **skipping `node_modules/` and `.git/`**, and reconcile each row's `status`. It MUST NOT traverse without bound.
**Rationale:** A `find ~`-class crawl must stay cheap and not descend into dependency trees (`ADR-0010`).
**Acceptance:** A fixture tree with a marker nested under `node_modules/` is NOT discovered; markers within depth elsewhere ARE; the scan terminates within the depth bound. → **EVAL-FLEET-009**
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-012 — Drift query reuses existing doctor logic + `markerChecksum` gate
**Rule:** `forge fleet status | drift [--component R] | show <id>` MUST compute drift by reusing the **existing `cmdDoctor` checksum loop and version-drift check** plus `sourceRev` comparison (`ADR-0009`); it MUST NOT reimplement them. A row whose `markerChecksum` is unchanged since last reconcile MUST be skippable (cheap gate).
**Rationale:** One drift algorithm, reused; the gate keeps repeated queries cheap (`ADR-0010`).
**Acceptance:** `fleet drift` on a project the doctor calls drifted reports the same components; a project with an unchanged `markerChecksum` is reported from cache without re-hashing its files. → **EVAL-FLEET-003**
**Priority:** MUST
**Refs:** ADR-0010, ADR-0009, SPEC-04

### BR-FLEET-013 — Grade semantics; user edits alone are never unhealthy
**Rule:** A row's `health.grade` MUST be `unhealthy` if it has missing files or broken refs; `drift` if it is version- or components-behind (and otherwise intact); `healthy` otherwise. `userEditedFiles` alone (checksum drift on `userEditable` files) MUST NEVER make a project `unhealthy` — edits are sacred (#2).
**Rationale:** Health reflects breakage and staleness, not the user's deliberate customizations (`ADR-0010`).
**Acceptance:** A project whose only deviation is user-edited files grades `healthy`; adding a missing tracked file flips it to `unhealthy`. → **EVAL-FLEET-004** (grade arm)
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-014 — Fail-open on corrupt/missing `fleet.json`
**Rule:** A corrupt, unreadable, or missing `fleet.json` MUST NEVER block `init`, `doctor`, or `sync`. The affected command MUST proceed treating the fleet as "no data" and SHOULD note the index is unavailable.
**Rationale:** A cache failure must never break a core command (invariant #4; `ADR-0010`).
**Acceptance:** With `fleet.json` truncated to invalid JSON, `init --apply`, `doctor`, and `sync` all complete successfully and write a valid marker / report; none throws. → **EVAL-FLEET-005**
**Priority:** MUST
**Refs:** ADR-0010, BR-INT, SPEC-04

### BR-FLEET-015 — Lifecycle: moved / missing / relink
**Rule:** When a registered `path` no longer holds a marker, the row MUST become `missing`; if the same marker (matched by `generatedAt`) is found elsewhere during `scan`, the row MUST become `moved` and the manager MUST **offer** `forge fleet relink` (never relink silently — *see BR-INT*).
**Rationale:** Projects move; the index detects it and offers a fix without auto-mutating (`ADR-0010`).
**Acceptance:** Moving a project dir then `scan` marks it `moved` and surfaces a relink offer pointing at the new path; declining leaves the row `moved`, accepting updates `path`. → **EVAL-FLEET-010**
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-016 — Lifecycle controls: relink / forget / prune / ignore / pin
**Rule:** `forge fleet relink | forget | prune | ignore | pin` MUST manage rows without touching project files: `forget` removes one row; `prune` removes `missing` rows; `ignore` sets `status=ignored` (excluded from health rollups); `pin` sets `status=pinned` (intentionally on an older line, **excluded from sync**). None MUST modify any `<project>/` content.
**Rationale:** Index hygiene and intentional exclusions are cache operations, not project mutations (`ADR-0010`).
**Acceptance:** `pin <id>` excludes the project from a subsequent `fleet sync --all`; `forget <id>` removes only the row and leaves the marker untouched on disk. → **EVAL-FLEET-011**
**Priority:** SHOULD
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-017 — Fleet state physically cannot be committed/shipped
**Rule:** `fleet.json` and any fleet state MUST live only under `~/.claude/forge/`, MUST NEVER be written into a tailored project or the git-tracked library, and the manager's `validate-no-personal-paths` self-validator MUST assert that manager machine-local state files are never staged.
**Rationale:** Local-only / privacy (invariant #6; `ADR-0010`).
**Acceptance:** `validate-no-personal-paths` fails (advisory finding) if a `fleet.json` or a `~/.claude/forge/` path is found among staged files; passes otherwise. → **EVAL-FLEET-012**
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

---

## Fleet bulk remediation (v0.5 write/merge — DEFERRED, Tier 3)

### BR-FLEET-018 — `fleet sync` orchestrates the existing per-project sync
**Rule:** `forge fleet sync [--all|<id>] [--component R]` MUST orchestrate the **existing per-project `forge sync`** (`cmdSync`) and MUST NOT reimplement the merge logic. It MUST be **dry-run by default**; `--apply` MUST be required to write; `--skip-merges` MUST apply only safe auto-upgrades. `pinned` projects MUST be excluded.
**Rationale:** One sync engine, orchestrated; dry-run-by-default safety (`C4`, `ADR-0010`).
**Acceptance:** `fleet sync --all` (no `--apply`) writes nothing and prints a per-project plan; `--apply` invokes `cmdSync` per eligible project and skips pinned ones. → **EVAL-FLEET-013**
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-019 — Auto-upgrade only unedited copied files
**Rule:** During `fleet sync --apply`, a **copied + unedited** file (on-disk checksum matches the marker) MUST be auto-upgraded to the new version; a **referenced** component (symlinked, not copied) MUST only have its `sourceRev` refreshed.
**Rationale:** Safe upgrades flow automatically; references need no file write (`ADR-0010`).
**Acceptance:** An unedited copied rule is updated to the new bytes and its marker checksum advanced; a referenced agent triggers only a `sourceRev` refresh, no file write. → **EVAL-FLEET-013** (upgrade arm)
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-020 — User-edited files are staged for 3-way merge, NEVER clobbered
**Rule:** During `fleet sync --apply`, a **copied + user-edited** file (checksum drift) MUST NOT be overwritten. The manager MUST **stage** a 3-way merge to `<project>/.claude/.forge-merge/{base,yours,new}`, leave the **live file UNTOUCHED**, and mark the project `needs-manual-merge`.
**Rationale:** User edits are sacred (invariant #2); upgrades must never destroy them (`ADR-0010`).
**Acceptance:** A user-edited file with an upstream change leaves the live file byte-identical, writes `base`/`yours`/`new` under `.forge-merge/`, and flags `needs-manual-merge`. → **EVAL-FLEET-004**
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-021 — Added modules lay down additively; removed modules are never auto-deleted
**Rule:** During `fleet sync --apply`, a **newly added** module's components MUST be laid down additively (skip-if-exists, like `init`). A **removed** module's files MUST NEVER be auto-deleted; the removal MUST be **reported only**.
**Rationale:** Additive-never-destructive (invariant #2; `ADR-0010`).
**Acceptance:** Adding a module writes its missing files and preserves any existing ones; removing a module deletes nothing and emits a "would remove" report line. → **EVAL-FLEET-014**
**Priority:** MUST
**Refs:** ADR-0010, SPEC-04

### BR-FLEET-022 — Fleet drift is advisory, never blocking
**Rule:** Fleet drift findings MUST be advisory (`WARN`), consistent with `C5` / `ADR-0007`; they MUST NOT block any commit, CI run, or session.
**Rationale:** Advisory-first gates (`ADR-0007`, `C5`).
**Acceptance:** A fleet with drifted projects produces `WARN`-level findings and exit semantics that never fail a gate. → **EVAL-FLEET-003** (level arm)
**Priority:** SHOULD
**Refs:** ADR-0007, ADR-0010, SPEC-04

### BR-FLEET-023 — `--component R` targets one component across the fleet
**Rule:** `forge fleet drift --component R` and `fleet sync --component R` MUST scope to projects whose resolved component set includes `R`, reporting/remediating only `R`'s drift.
**Rationale:** "Who is behind on reviewer R?" is the canonical fleet query (`ADR-0010`).
**Acceptance:** With R advanced upstream, `fleet drift --component R` lists exactly the projects resolving to R and their behind-count; projects not using R are absent. → **EVAL-FLEET-003** (component-scope arm)
**Priority:** SHOULD
**Refs:** ADR-0010, ADR-0009, SPEC-04

### BR-FLEET-024 — `fleet sync` is a manager module honoring the module contract
**Rule:** The fleet implementation MUST be a `forge/manager/fleet.mjs` exporting `run()` + `summarize()`, reading/writing state only via `manager/lib/store.mjs`, fail-open, dry-run by default, with a paired auto-discovered `lint/validate-fleet.mjs` (*see BR-INT / C4*).
**Rationale:** Uniform module contract; forge-validates-forge (`C4`, `ADR-0014`).
**Acceptance:** `lint/validate-fleet.mjs` is auto-discovered and asserts `fleet.mjs` exports `run`/`summarize`, is dry-run by default, and never writes outside the machine-local root. → **EVAL-FLEET-005** (contract arm)
**Priority:** SHOULD
**Refs:** ADR-0010, ADR-0014, SPEC-04
