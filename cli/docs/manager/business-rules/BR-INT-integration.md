# Business Rules — Integration invariants (BR-INT)

> The normative rules that bind the manager to the existing harness without breaking it: the
> manager-module contract (C4), fail-open, dry-run-by-default, zero-dep, storage discipline, self-
> validation, and the proportionality rule ("the manager must not cost more than the harness it manages").
> These are the cross-cutting spine every dimension's module must satisfy. Decided by ADR-0001, ADR-0002,
> ADR-0003, ADR-0004, ADR-0014; detailed by SPEC-00 (architecture) and SPEC-09 (data model). Acceptance
> maps to `EVAL-INT` (and `EVAL-CLI` where the surface is the subject). **Phase: v0.2** unless noted.

### BR-INT-001 — The manager-module contract (C4)

**Rule:** Every `forge/manager/<noun>.mjs` MUST export `run(subcmd, args, ctx)` and `summarize(state)`.
`run` MUST return `{ ok, data, findings[], summary }` and MUST NOT write stdout directly. The module MUST
read/write state **only** via `manager/lib/store.mjs`, MUST be fail-open, MUST be dry-run by default, and
MUST ship a paired `lint/validate-<noun>.mjs`. `summarize(state)` MUST be pure and MUST return a `(no
data)` panel when state is absent.
**Rationale:** C4 is the spine that makes `--json`, `status` composition, storage discipline, and self-
validation all hold uniformly (ADR-0001/0004/0014).
**Acceptance:** A representative module exports both functions with the right signatures; `run` returns the
result object and emits no stdout; reads/writes go through the store; a paired validator exists — `EVAL-INT-005`.
**Priority:** MUST
**Refs:** ADR-0001, ADR-0014, C4, SPEC-00

### BR-INT-002 — Zero runtime dependencies, mechanically enforced

**Rule:** All `forge/manager/**/*.mjs` MUST import only `node:*` builtins and relative (`./`/`../`)
specifiers. `lint/validate-manager-zerodep.mjs` MUST scan those imports and MUST emit an ERROR (failing the
run) on any non-`node:`, non-relative specifier. The validator MUST be auto-discovered by `run-all.mjs`
(name matches `validate-*.mjs`) with no runner change.
**Rationale:** Zero-dep (invariant 1) is non-negotiable; review misses an import, so it is checked
mechanically (ADR-0014).
**Acceptance:** A planted `import x from 'lodash'` in a `manager/` fixture file causes
`validate-manager-zerodep` to emit an ERROR finding and the run to fail; an all-`node:`/relative tree passes
— `EVAL-INT-001`.
**Priority:** MUST
**Refs:** ADR-0014, invariant 1, C2, SPEC-00

### BR-INT-003 — Fail-open: a manager/store failure never blocks

**Rule:** A failure in the manager (a malformed/unreadable state file, a missing root, a contended JSONL
append) MUST NOT block a tool call, a session, or another command. A broken store read MUST degrade to an
empty result / `(no data)` panel and the command MUST exit 0 (absent a real ERROR-level finding).
**Rationale:** Fail-open (invariant 4); machine-local state is non-authoritative (C6), so its absence is
never fatal.
**Acceptance:** With `registry.json` corrupted, `forge status` renders the registry panel as `(no data — run
forge registry build)` and exits 0; no exception escapes — `EVAL-INT-002`.
**Priority:** MUST
**Refs:** ADR-0002, ADR-0003, invariant 4, C6, SPEC-00

### BR-INT-004 — Storage discipline: writes only under the two roots, with `schemaVersion`

**Rule:** The manager MUST write state only under `forge/.forge/` (git-tracked) or `~/.claude/forge/`
(machine-local), never elsewhere; the `store.mjs` seam MUST be the only writer. Every state file MUST carry
a top-level `schemaVersion`. No machine-local file MUST be treated as authoritative.
**Rationale:** Structural privacy and git-diffable truth (ADR-0003/C6); a single writer makes the assertion
checkable; `schemaVersion` guards against silently mis-shaped state (ADR-0002).
**Acceptance:** `tests/meta/manager-storage-additive.mjs` asserts a representative manager run writes only
under the two roots and that each written state file carries `schemaVersion` — `EVAL-INT-003`.
**Priority:** MUST
**Refs:** ADR-0002, ADR-0003, ADR-0014, C6, SPEC-09

### BR-INT-005 — Atomic snapshot writes; best-effort, lossy log appends

**Rule:** Snapshot writes (`registry.json`, `fleet.json`) MUST be atomic (write-temp-then-rename). JSONL
appends MUST use a best-effort advisory `.lock`; on contention the event MUST be **dropped, not blocked**
(fail-open). A crash MUST never leave a half-written snapshot.
**Rationale:** Atomicity protects the authoritative snapshot; lossy appends keep telemetry/audit from ever
becoming a barrier (ADR-0002, invariant 4).
**Acceptance:** A simulated mid-write crash leaves the prior snapshot intact (no truncated file); concurrent
appends under a held lock drop the late event rather than corrupting the log or throwing — `EVAL-INT-006`.
**Priority:** SHOULD
**Refs:** ADR-0002, invariant 4, SPEC-09

### BR-INT-006 — Findings conform to the unified shape (C2)

**Rule:** Every finding the manager emits — from a module's `run()` or parsed from a child validator — MUST
be `{ level: "ERROR"|"WARN"|"INFO", path: string, line: number|null, message: string, source: string }`.
Child validators MUST print `LEVEL path:line message`; the parent runner MUST parse that into the shape
(BR-CLI-003). `source` MUST identify the emitter (validator filename or module noun).
**Rationale:** A uniform finding shape is what makes the `--json` envelope and `status` composition total
(ADR-0004, C2).
**Acceptance:** A mixed batch of findings (parser-produced and module-produced) all validate against the
SPEC-09 finding schema; every field is present and correctly typed — `EVAL-INT-004`.
**Priority:** MUST
**Refs:** ADR-0004, C2, C3, SPEC-09, BR-CLI

### BR-INT-007 — Compose with `doctor`/`sync`/`validate`, never break them

**Rule:** The manager MUST extend existing surfaces additively: `forge doctor` gains manager-scope lines
without altering its existing per-project output or exit semantics; `forge validate` auto-discovers the new
validators via the existing glob (no runner edit); `forge fleet sync` MUST orchestrate (fan out over) the
**existing** per-project `forge sync`, not reimplement it. No existing command's behavior MUST regress.
**Rationale:** Additive, never destructive (invariant 2); the manager is a layer on top of forge's base, not
a fork of it (ADR-0014, ADR-0010).
**Acceptance:** Existing `doctor`/`validate`/`sync` behavior is unchanged on a tree with no manager state;
with state present, `doctor` shows additive lines and `validate` runs the two new validators — `EVAL-INT-007`.
**Priority:** MUST
**Refs:** ADR-0014, ADR-0010, invariant 2, SPEC-00, BR-FLEET

### BR-INT-008 — The manager is self-validated and self-catalogued

**Rule:** The manager MUST ship `lint/validate-registry.mjs` (registry-in-sync; content rules owned by
BR-REG) and `lint/validate-manager-zerodep.mjs`, both auto-discovered, plus
`tests/meta/manager-storage-additive.mjs`. `registry build` MUST catalog `forge/manager/**` and the new
validators as artifacts, so the cataloguer catalogs itself (bounded recursion).
**Rationale:** Forge-validates-forge (invariant 5) applied to the manager; bounded self-validation answers
the proportionality verdict's recursion warning without a recursive eval-of-the-eval (ADR-0014).
**Acceptance:** Both validators appear in a `forge validate` run and the meta-test in `run-meta`; the
manager's own files appear as records in `forge registry ls` — `EVAL-INT-008` (registry presence cross-
checked by `EVAL-REG`).
**Priority:** MUST
**Refs:** ADR-0014, invariant 5, BR-REG, SPEC-00

### BR-INT-009 — Advisory gates do not block (C5)

**Rule:** The version-bump and eval-regression checks MUST surface as advisory `WARN` findings and MUST NOT
affect exit codes by default; the manager MUST NOT add a blocking commit/push hook in v0.2. Promotion of a
specific gate to blocking MUST be an explicit, opt-in, per-gate user decision (deferred to v0.4 with data).
**Rationale:** A blocking version gate × a blocking eval gate is a deadlock surface for a solo dev and would
provoke `--no-verify` (which `block-no-verify` fights); advisory-first avoids it (ADR-0007).
**Acceptance:** With a hash-changed-but-revision-unbumped artifact, `validate-registry` emits a WARN and the
run exits 0; the same under `--strict` counts toward exit — `EVAL-INT-009` (cross-checked by `EVAL-CLI-008`).
**Priority:** MUST
**Refs:** ADR-0007, ADR-0008, C5, BR-VER, BR-EVAL, SPEC-00

### BR-INT-010 — The manager must not cost more than the harness it manages

**Rule:** The manager MUST stay proportionate: lazy-loaded (zero hot-path cost when unused, BR-CLI-001),
zero new dependencies (BR-INT-002), no daemon/background process, and every dimension degrades gracefully
(cost-only, static-only, empty-panel) when its upstream signal is absent. A dimension MUST ship only when
its trigger condition (per `ROADMAP.md`) is met.
**Rationale:** The single most important constraint in the corpus (`ideas/01`): the manager must never cost
more to maintain than the harness it manages.
**Acceptance:** No `forge/manager/*` import occurs on the `doctor`/`init`/`sync` path; the manager declares
no runtime dependency; no long-lived process is spawned; absent-signal dimensions render empty rather than
erroring — `EVAL-INT-010` (no-hot-path-import cross-checked by `EVAL-CLI-006`).
**Priority:** MUST
**Refs:** ADR-0001, ADR-0002, ADR-0010, ADR-0016, invariant 1, `ideas/01-proportionality.md`, SPEC-00
