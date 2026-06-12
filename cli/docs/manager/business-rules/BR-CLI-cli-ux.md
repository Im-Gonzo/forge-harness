# Business Rules — CLI & UX (BR-CLI)

> The normative rules for the manager's command surface: the verb taxonomy, the `--json` envelope, the
> `forge status` dashboard, global flags, and help. Decided by ADR-0001, ADR-0004, ADR-0007, ADR-0015;
> detailed by SPEC-08 (CLI & status) and SPEC-09 (data model / envelope). Acceptance maps to `EVAL-CLI`
> (and, where integration is the subject, `EVAL-INT`). **Phase: v0.2** unless a rule notes otherwise.

### BR-CLI-001 — One binary, noun-first groups on the existing switch

**Rule:** The manager MUST add its surface as cases on `bin/forge.mjs`'s existing `switch (cmd)`. It MUST
NOT introduce a second binary or a TUI. Multi-verb dimensions MUST be **noun-first groups** (`forge
registry …`, `forge fleet …`, `forge telemetry …`, `forge eval-harness …`); `analyze`, `optimize`,
`status`, `monitor` are top-level verbs. Each group MUST be a lazily-imported `forge/manager/<noun>.mjs`
(`await import`) loaded only when invoked.
**Rationale:** One entry point keeps the manager "feeling like forge" (ADR-0001); lazy import keeps the hot
path (`doctor`/`init`/`sync`) free of manager code.
**Acceptance:** `forge doctor` runs without importing any `forge/manager/*` module; `forge registry ls`
dispatches to `forge/manager/registry.mjs`; there is exactly one binary — `EVAL-CLI-006`.
**Priority:** MUST
**Refs:** ADR-0001, ADR-0015, SPEC-00, SPEC-08

### BR-CLI-002 — Business logic returns data; the dispatcher renders

**Rule:** A `forge/manager/<noun>.mjs` `run(subcmd, args, ctx)` MUST return a structured result
(`{ ok, data, findings[], summary }`) and MUST NOT write to stdout/stderr directly. The dispatcher MUST
own rendering: human text by default, or the C3 envelope under `--json`.
**Rationale:** The print/compute split is what makes `--json` exist with no per-command branching (ADR-0001,
ADR-0004); a module that prints would bypass the envelope.
**Acceptance:** A manager module run in-process returns a result object and produces no stdout side-effect;
the same result renders identically into human and `--json` forms — `EVAL-CLI-007` (shape conformance
cross-checked by `EVAL-INT` findings-shape).
**Priority:** MUST
**Refs:** ADR-0001, ADR-0004, SPEC-00, SPEC-08

### BR-CLI-003 — The `--json` envelope is synthesized at the parent runner

**Rule:** `forge validate --json` and `forge doctor --json` MUST emit the C3 envelope
`{forge, command, ok, ts, data, findings[], summary}`, where `findings[]` is produced by **parsing** each
captured child validator's `LEVEL path:line message` lines (regex
`^(ERROR|WARN|INFO)\s+(\S+?)(?::(\d+))?\s+(.*)$`) into `{level, path, line, message, source}` **at the
parent runner**. No child validator MAY be modified to add a `--json` mode.
**Rationale:** The parents (`run-all.mjs`/`run-meta.mjs`) already capture child stdout/stderr/status; parsing
there is the highest-leverage build and touches zero children (ADR-0004).
**Acceptance:** Running `run-all.mjs --json` over a fixture validator that prints a `WARN path:line msg`
line yields one well-shaped finding with `source` = that validator's filename, inside a conformant
envelope, with **no edit to the child** — `EVAL-CLI-001`.
**Priority:** MUST
**Refs:** ADR-0004, C2, C3, SPEC-08, SPEC-09, BR-INT

### BR-CLI-004 — Single envelope shape across every command

**Rule:** Every machine-readable command (`validate`, `doctor`, `status`, every `registry`/`fleet`/… verb)
MUST emit the identical envelope shape (C3) via one shared writer (`manager/lib/json-out.mjs`). `ok` MUST
be `summary.errors === 0` AND no failed/errored child; `ts` MUST be an ISO-8601 string; `findings[]` MUST
use the C2 shape exactly.
**Rationale:** One machine shape lets any wrapper (CI, `status`) parse every command the same way (ADR-0004).
**Acceptance:** `forge registry ls --json` and `forge validate --json` both validate against the SPEC-09
envelope schema; `ok` reflects the error count — `EVAL-CLI-002`.
**Priority:** MUST
**Refs:** ADR-0004, C3, SPEC-09

### BR-CLI-005 — `forge status` composes one panel per dimension, fail-open

**Rule:** `forge status` MUST compose a panel per dimension (registry, fleet, telemetry, eval, efficiency)
plus an OVERALL line and a next-actions list, by calling each module's `summarize(state)`. When a
dimension's state is absent/unreadable, its panel MUST render `(no data — run <command>)` and `status`
MUST still exit 0. `status` MUST support `--json` (the same envelope, with per-panel data in `data`).
**Rationale:** The dashboard is the skeleton's proof-of-composition (SPEC-08, ADR-0016); fail-open panels mean
one missing subsystem never blanks the whole view (invariant 4).
**Acceptance:** With only the registry present, `forge status` shows a live registry panel and four
`(no data — run X)` panels and exits 0; `--json` carries each panel under `data` — `EVAL-CLI-003`.
**Priority:** MUST
**Refs:** ADR-0001, ADR-0015, SPEC-08, BR-INT

### BR-CLI-006 — `status` is informational; `doctor` is pass/fail; they don't duplicate

**Rule:** `forge status` MUST be informational and MUST exit 0 regardless of advisory findings. `forge
doctor` MUST remain the pass/fail health command (non-zero on real problems) and MUST be **extended**
additively with manager-scope lines, never replaced by `status`. The two MUST NOT duplicate each other's
role (status paints panels; doctor decides health).
**Rationale:** A dashboard that also gates exit codes conflates information with health (ADR-0015); keeping
them separate preserves a clean "is it healthy?" signal.
**Acceptance:** `forge status` exits 0 with standing WARN findings present; `forge doctor` exits non-zero on
a real marker problem and now prints additive manager-scope lines — `EVAL-CLI-004`.
**Priority:** MUST
**Refs:** ADR-0015, ADR-0014, SPEC-08, BR-INT

### BR-CLI-007 — Dry-run is the default for every writing verb

**Rule:** Every verb that mutates state (`registry build`, `fleet sync`/`relink`/`prune`, `optimize`,
`telemetry wipe`) MUST be **dry-run by default** and MUST require an explicit `--apply` (or, for registry,
`--write`) to persist. In dry-run it MUST print/return the planned change and MUST write nothing.
**Rationale:** Detect-and-offer, never auto-mutate (invariant 3); dry-run-by-default is the C4 module
contract.
**Acceptance:** `forge optimize` (no `--apply`) and `forge registry build` (no `--write`) produce a plan and
leave the filesystem byte-identical; adding the apply flag is what writes — `EVAL-CLI-005`.
**Priority:** MUST
**Refs:** ADR-0001, ADR-0015, C4, SPEC-08, BR-INT

### BR-CLI-008 — Global flags are uniform and parsed once

**Rule:** `--json`, `--dry-run`/`--apply`, `--strict`, `--quiet` MUST be recognized uniformly across every
manager verb, parsed once (reusing `parseArgs`) and carried in `ctx`. `--strict` (and only `--strict`)
MUST make advisory WARN findings count toward the exit code; without it, advisory findings MUST NOT affect
exit (ADR-0007).
**Rationale:** Uniform flags make the surface predictable; `--strict` is the single dial between advisory and
gating (ADR-0007, ADR-0015).
**Acceptance:** `forge validate` exits 0 with only WARN findings; `forge validate --strict` exits non-zero
on the same findings; `--json`/`--quiet` behave identically across two different groups — `EVAL-CLI-008`.
**Priority:** SHOULD
**Refs:** ADR-0007, ADR-0015, C5, SPEC-08

### BR-CLI-009 — `forge --help` documents the manager surface; unknown sub-verb is fail-soft

**Rule:** `forge --help` MUST include a "MANAGER" section listing the groups and top-level manager verbs.
`forge <group> help` (or no sub-verb) MUST list that group's verbs. An unknown sub-verb MUST print the
group's usage and exit 2 (mirroring the existing top-level `default:` behavior in `bin/forge.mjs`).
**Rationale:** Discoverability over a 30-verb wall (ADR-0015); consistent unknown-command handling matches
the existing CLI.
**Acceptance:** `forge --help` lists `registry|fleet|telemetry|analyze|optimize|eval-harness|status|monitor`;
`forge registry bogus` prints registry usage and exits 2 — `EVAL-CLI-009`.
**Priority:** SHOULD
**Refs:** ADR-0001, ADR-0015, SPEC-08

### BR-CLI-010 — `status`/`stat`/`monitor` and `analyze`/`optimize` overlaps are resolved by role

**Rule:** There MUST be no top-level `forge stat`. Subsystem state MUST be `forge telemetry status`; the
composed snapshot MUST be `forge status`; the live tail MUST be `forge monitor`. `forge analyze` MUST be
read-only (no mutation flags, never proposes a change); `forge optimize` MUST be a dry-run plan (`--apply`
to act). **Phase: v0.3+** for the `analyze`/`optimize`/`monitor` bodies; the *taxonomy reservation* is v0.2.
**Rationale:** Each overlap has one clear home; read-only vs propose is a real distinction (ADR-0015).
**Acceptance:** `forge stat` is unknown (exits 2 with usage); `forge telemetry status`, `forge status`, and
`forge monitor` are three distinct commands; `forge analyze` rejects `--apply` — `EVAL-CLI-010`.
**Priority:** SHOULD
**Refs:** ADR-0015, BR-TEL, BR-EFF, SPEC-08
