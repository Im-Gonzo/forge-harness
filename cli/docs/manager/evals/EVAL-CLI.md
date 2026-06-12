# EVAL-CLI — CLI & UX acceptance specs

> RED-first acceptance specs for the CLI surface: the `--json` envelope synthesized at the parent runner,
> the single envelope shape, `forge status` composition, `status`≠`doctor` roles, dry-run-by-default, lazy
> dispatch, the `--strict` dial, help/unknown handling, and overlap resolution. Every case is **RED**
> (nothing is implemented). Verifies `BR-CLI`; cross-refs `EVAL-INT` where integration is the subject.

### EVAL-CLI-001 — `--json` envelope from `run-all`, parsed from `LEVEL path:line`, no child change

- **Verifies:** BR-CLI-003, BR-CLI-004
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a fixture validator under `lint/` that prints exactly
  `WARN agents/x.md:12 dangling ref "y"` and exits 0, **and that validator file is byte-identical before
  and after** (no `--json` mode added to it). When `node lint/run-all.mjs --json <fixtureRoot>` runs.
  Then stdout is a single C3 envelope whose `findings[]` contains exactly one finding
  `{level:"WARN", path:"agents/x.md", line:12, message:'dangling ref "y"', source:"validate-fixture.mjs"}`,
  `command:"validate"`, `ok:true` (no ERROR), and `summary.warnings === 1` — and a byte-diff of the child
  validator before/after the run is empty.
- **Fixture:** a throwaway lint dir with one `validate-fixture.mjs` printing the canonical line; a tree
  with `agents/x.md`.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-CLI-002 — One envelope shape across commands; `ok` reflects error count

- **Verifies:** BR-CLI-004
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a built registry and the same fixture validator. When `forge registry ls
  --json` and `forge validate --json` both run. Then both outputs validate against
  `schemas/envelope.schema.json` (keys `forge, command, ok, ts, data, findings, summary`; `ts` ISO-8601;
  each finding matches `finding.schema.json`); and for a tree with one ERROR finding, that command's `ok`
  is `false` while a WARN-only command's `ok` is `true`.
- **Fixture:** a built `forge/.forge/registry.json`; one error-emitting and one warn-only fixture validator.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-CLI-003 — `forge status` composes a panel per dimension, fail-open

- **Verifies:** BR-CLI-005
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a tree with **only** the registry present (no fleet/telemetry/eval/analyze
  state). When `forge status` runs (human) and `forge status --json` runs. Then the human output contains a
  live REGISTRY panel (artifact count) and four `(no data — run <command>)` panels (fleet, telemetry,
  efficiency, eval), an OVERALL line, and a NEXT ACTIONS list; the `--json` output carries each panel under
  `data.panels` (the absent ones with `ok:null` / `state:"no-data"` + a `hint`); and the process exits 0.
- **Fixture:** a built registry; `~/.claude/forge/` empty.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-CLI-004 — `status` is informational (exit 0); `doctor` is pass/fail and extended

- **Verifies:** BR-CLI-006, BR-INT-007
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a tree with standing advisory WARN findings (VERSION triple drift) and a
  separately broken project marker. When `forge status` runs. Then it prints the WARNs and exits 0. When
  `forge doctor` runs on the broken-marker project. Then it exits non-zero **and** prints the additive
  "MANAGER SCOPE" lines (registry presence, advisory drift) while its pre-existing per-project output and
  exit semantics are unchanged versus a baseline `doctor` run without the manager.
- **Fixture:** a tree with VERSION/package/plugin drift; a project with a malformed `.claude/.forge.json`.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-CLI-005 — Dry-run is the default; a writer writes nothing without the apply flag

- **Verifies:** BR-CLI-007
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a tree with no `forge/.forge/registry.json`. When `forge registry build`
  runs (no `--write`). Then it prints/returns the planned registry and the filesystem is byte-identical
  afterward (no `registry.json`, no `registry.log.jsonl` created — verified by a recursive hash of the tree
  before/after). When `forge registry build --write` runs. Then exactly `registry.json` (and, on mutation,
  `registry.log.jsonl`) appear under `forge/.forge/`.
- **Fixture:** a small library tree with no prior registry.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-CLI-006 — Lazy dispatch: the hot path imports no manager module

- **Verifies:** BR-CLI-001, BR-INT-010
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given an instrumented run that records every module specifier `import`-ed. When
  `forge doctor`, `forge init`, and `forge sync` run. Then no `forge/manager/*` module appears in the
  import set for any of them. When `forge registry ls` runs. Then `forge/manager/registry.mjs` does appear.
  (Verifiable via `--experimental-loader` hook or `process` import tracking; the assertion is the
  set-membership, not the mechanism.)
- **Fixture:** a project with a valid marker (so `doctor`/`sync` exercise their normal path).
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-CLI-007 — Print/compute split: a module returns data and emits no stdout

- **Verifies:** BR-CLI-002, BR-INT-001
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a manager module imported in-process with stdout/stderr captured. When its
  `run(subcmd, args, ctx)` is awaited. Then it returns `{ ok, data, findings, summary }` with `findings`
  matching the C2 shape, and the captured stdout/stderr are empty (the module printed nothing); and
  rendering that same result through the dispatcher's human and `--json` paths produces consistent
  content (same findings, same data).
- **Fixture:** the registry module + a small built registry.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-CLI-008 — `--strict` is the only dial that makes advisory WARNs fail the exit

- **Verifies:** BR-CLI-008, BR-INT-009
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a tree whose only findings are advisory WARNs (VERSION drift). When
  `forge validate` runs. Then exit code is 0. When `forge validate --strict` runs on the same tree. Then
  exit code is non-zero. And `--json`/`--quiet` produce the same envelope/suppression behavior when run
  against two different groups (`validate` and `registry ls`).
- **Fixture:** a tree with WARN-only drift; the same fixture used by EVAL-CLI-002.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-CLI-009 — `forge --help` lists the manager surface; unknown sub-verb is fail-soft

- **Verifies:** BR-CLI-009
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** When `forge --help` runs. Then output contains a MANAGER section naming
  `registry`, `fleet`, `telemetry`, `analyze`, `optimize`, `eval-harness`, `status`, `monitor`. When
  `forge registry bogus` runs. Then registry usage is printed and the exit code is 2 (mirroring the
  existing top-level `default:` behavior).
- **Fixture:** none (CLI introspection only).
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-CLI-010 — Overlap resolution: no `forge stat`; `analyze` is read-only

- **Verifies:** BR-CLI-010
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** When `forge stat` runs. Then it is an unknown command (usage + exit 2) — there
  is no top-level `stat`. When `forge telemetry status`, `forge status`, and `forge monitor` are resolved.
  Then they dispatch to three distinct code paths (subsystem state · composed dashboard · live tail). When
  `forge analyze --apply` runs. Then it is rejected with a usage error (analyze is read-only and accepts no
  mutation flag).
- **Fixture:** none (dispatch resolution only).
- **Phase:** v0.2 (taxonomy reservation); `monitor`/`analyze` bodies land v0.3+
- **Status:** GREEN
