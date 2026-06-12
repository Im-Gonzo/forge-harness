# EVAL-INT — Integration invariant acceptance specs

> RED-first acceptance specs for the cross-cutting invariants that bind the manager to the harness:
> zero-dep enforcement, fail-open, storage-additive (writes only under the two roots, with `schemaVersion`),
> the unified findings shape, the C4 module contract, atomic/lossy writes, compose-don't-break, self-
> validation, advisory gates, and proportionality. Every case is **RED**. Verifies `BR-INT`; cross-refs
> `EVAL-CLI`/`EVAL-REG` where the surface or the registry is the subject.

### EVAL-INT-001 — Zero-dep: `validate-manager-zerodep` catches a non-node import

- **Verifies:** BR-INT-002
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a `forge/manager/` fixture tree where one `.mjs` file contains
  `import _ from 'lodash'` (a bare, non-`node:`, non-relative specifier). When `node
  lint/validate-manager-zerodep.mjs <root>` runs (and when `forge validate` auto-discovers it). Then it
  emits an ERROR finding naming that file/specifier and exits non-zero. And when the offending import is
  replaced with `import path from 'node:path'` (or a relative `./lib/x.mjs`), the validator exits 0. The
  validator MUST be discovered by `run-all.mjs` with no runner edit.
- **Fixture:** a `manager/` tree with one planted `lodash` import; a clean variant.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-INT-002 — Fail-open: a broken store read yields an empty panel and exit 0

- **Verifies:** BR-INT-003
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given `forge/.forge/registry.json` corrupted to invalid JSON (and, in a second
  trial, deleted). When `forge status` runs. Then the REGISTRY panel renders `(no data — run forge registry
  build)` (not a stack trace), the other panels render normally, no exception escapes the process, and the
  exit code is 0.
- **Fixture:** a tree with a corrupted/absent `registry.json`.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-INT-003 — Storage-additive: writes only under the two roots, every file carries `schemaVersion`

- **Verifies:** BR-INT-004
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a sandboxed `FORGE_ROOT` and `STATE_HOME`, with a recursive snapshot of
  every path's mtime/hash outside `forge/.forge/` and `~/.claude/forge/`. When a representative writing run
  executes (`registry build --write`, plus a telemetry/fleet write in their trials). Then **every** created
  or modified file lies under `forge/.forge/` or `~/.claude/forge/` (nothing outside the two roots changed),
  and each written state file contains a top-level `schemaVersion`. (This is `tests/meta/
  manager-storage-additive.mjs`, discovered by `run-meta.mjs`.)
- **Fixture:** sandboxed roots; a small library to build a registry from.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-INT-004 — Findings-shape conformance: every finding matches the C2 shape

- **Verifies:** BR-INT-006, BR-CLI-003
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a mixed batch of findings — some parsed by the runner from
  `LEVEL path:line message` child output, some emitted directly by a manager module's `run()`. When all
  findings are collected. Then every finding validates against `schemas/finding.schema.json`:
  `level ∈ {ERROR,WARN,INFO}`, `path` a string, `line` an integer or null, `message` a non-empty string,
  `source` a non-empty string identifying the emitter. A finding missing any field or with a wrong type
  fails the case.
- **Fixture:** the EVAL-CLI-001 fixture validator output + the registry module's findings.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-INT-005 — The C4 module contract holds for a representative module

- **Verifies:** BR-INT-001, BR-CLI-002
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given `forge/manager/registry.mjs` imported in-process. When its exports are
  inspected and exercised. Then it exports `run(subcmd, args, ctx)` and `summarize(state)`; `run` returns
  `{ ok, data, findings, summary }` and produces no stdout; `summarize(undefined)` returns a `(no data)`
  panel (does not throw); all state access went through `manager/lib/store.mjs` (no direct `fs` state
  write — asserted by stubbing the store and observing zero out-of-store writes); and a paired
  `lint/validate-registry.mjs` exists.
- **Fixture:** the registry module + a stubbed store.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-INT-006 — Atomic snapshot, lossy append: a crash/contention never corrupts state

- **Verifies:** BR-INT-005
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given an existing valid `registry.json`. When a snapshot write is interrupted
  mid-way (simulated by failing between temp-write and rename). Then the prior `registry.json` is intact
  (no truncated/partial file). And when two appenders contend on `telemetry/events.jsonl` (one holds the
  advisory `.lock`). Then the late event is dropped (the append returns without writing) rather than
  corrupting the file or throwing.
- **Fixture:** a store harness that can inject a mid-write failure and hold the lock.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-INT-007 — Compose, don't break: existing `doctor`/`validate`/`sync` unchanged

- **Verifies:** BR-INT-007
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a baseline capture of `forge doctor`, `forge validate`, and `forge sync`
  output/exit on a tree with **no** manager state. When the manager is present but no state exists. Then
  those three commands' output and exit codes match the baseline (additive lines appear only once manager
  state exists). And with state present, `forge validate` runs the two new validators (they appear in its
  discovered set) and `forge doctor` shows the additive MANAGER SCOPE block — with the pre-existing
  per-project checks still present and unchanged.
- **Fixture:** a tree with/without `forge/.forge/` state; a baseline output capture.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-INT-008 — Self-validated and self-catalogued

- **Verifies:** BR-INT-008
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** When `forge validate` runs. Then both `validate-registry.mjs` and
  `validate-manager-zerodep.mjs` appear in the discovered-validator set, and `manager-storage-additive.mjs`
  appears in the `run-meta` set. When `forge registry build --write` then `forge registry ls` run. Then
  records exist for `forge/manager/**` modules and for the two new validators (the cataloguer catalogs
  itself). Registry-content correctness is cross-checked by `EVAL-REG`.
- **Fixture:** the full manager tree + a build.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-INT-009 — Advisory gates surface as WARN and do not block

- **Verifies:** BR-INT-009
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given an artifact whose `contentHash` changed but whose `revision` did not (the
  live-symlink scenario), and a VERSION triple drift. When `forge validate` (which runs
  `validate-registry`) executes. Then those checks emit `WARN` findings and the run exits 0 (no blocking),
  and the manager installs no commit/push hook. When the same runs under `--strict`. Then those WARNs count
  toward a non-zero exit. Cross-checked by `EVAL-CLI-008`.
- **Fixture:** a registry with a hash≠revision artifact; a tree with VERSION/package/plugin drift.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-INT-010 — Proportionate: no hot-path cost, no dep, no daemon, graceful absence

- **Verifies:** BR-INT-010, BR-CLI-001
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** When `forge doctor`/`init`/`sync` run. Then no `forge/manager/*` module is
  imported (cross-ref EVAL-CLI-006). And the manager declares **zero** runtime dependencies (no
  `dependencies` in any manifest it adds). And no command spawns a long-lived/background process (every
  manager process exits; `monitor` exits on SIGINT). And every dimension with no upstream signal renders an
  empty `(no data)` panel rather than erroring (cross-ref EVAL-INT-002 / EVAL-CLI-003).
- **Fixture:** a project with a valid marker; a manifest inventory of the manager's additions.
- **Phase:** v0.2
- **Status:** GREEN
