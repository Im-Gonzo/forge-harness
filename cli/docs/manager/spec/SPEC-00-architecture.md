# SPEC-00 — Architecture & manager-module contract

Status: design-stage · Phase: v0.2 · Implements: BR-INT-001..010, BR-CLI-001/002 · Decided-by: ADR-0001,
ADR-0002, ADR-0003, ADR-0004, ADR-0014, ADR-0015, ADR-0016

## Summary

The manager is **one binary, noun-first subcommand groups, lazily-imported modules, and a print/compute
split** layered over the existing `bin/forge.mjs`. This spec fixes the overall shape: the dispatch model,
the lazy-module mechanism, the **manager-module contract (C4)** every dimension obeys, the shared
`manager/lib/` foundation, and the **three logical roots** (`FORGE_ROOT`, `PROJECT_DIR`, `STATE_HOME`)
that every command resolves through `ctx`. Dimension-specific behavior lives in SPEC-01..07; the CLI
surface in SPEC-08; the on-disk shapes in SPEC-09. Architecture is deliberately thin: the spine, not the
organs.

## Design

### Dispatch: groups on the existing switch (ADR-0001, ADR-0015)

> **Amends earlier async-main / `await import` wording.** This section originally described making
> `main()` `async` and lazily `await import(...)`-ing each manager module on the hot path. The
> implemented decision is to **delegate** each manager verb group to a child script via the existing
> `delegateInherit` helper — the same pattern the `validate` verb already uses — so `main()` stays
> synchronous and no manager module is imported into the CLI process at all.

`bin/forge.mjs#main()` stays synchronous. Its `switch (cmd)` keeps every existing flat verb
(`profile|validate|init|doctor|sync|install|uninstall|help`) and gains manager cases. Group cases
**delegate** to their `manager/<noun>.mjs` child script via `delegateInherit` (which `spawnSync`s a
fresh `node` process with `stdio: 'inherit'`), exactly as `case 'validate'` delegates to
`lint/run-all.mjs`:

```
case 'registry': case 'fleet': case 'telemetry':
case 'analyze':  case 'optimize': case 'eval-harness':
case 'status':   case 'monitor': {
  const noun = cmd;                                 // the group
  // delegate to the dual-mode child script; it parses subcmd/args, builds ctx,
  // runs run()/summarize(), and prints (human OR --json envelope) itself.
  process.exit(delegateInherit(`manager/${MODULE_OF[noun]}.mjs`, rest, FORGE_ROOT));
}
```

- **Delegation is load-bearing:** the existing flat verbs and the startup path import nothing under
  `forge/manager/`; the manager module loads only inside its own child process. `forge doctor` pays
  zero manager cost (BR-CLI-001, BR-INT-010). The **process boundary strengthens the
  no-hot-path-import invariant** (EVAL-CLI-006 / EVAL-INT-010): a manager module *cannot* leak into
  the parent CLI's module graph because it never shares one.
- **Modules stay dual-mode.** Each `manager/<noun>.mjs` is BOTH a runnable script (an
  `import.meta.main`-style entry that parses argv, builds `ctx`, calls its own `run()`/`summarize()`,
  and renders) AND a module that still `export`s `run()`/`summarize()` for in-process callers
  (`status` composition, tests). The **C4 module contract below is UNCHANGED** — delegation is a
  dispatch detail, not a contract change.
- **`validate`/`doctor` are extended, not moved.** They stay flat verbs; `validate` simply passes `--json`
  through to `lint/run-all.mjs` (which gains the parser, ADR-0004); `doctor` gains additive manager-scope
  lines (BR-INT-007). `fleet sync` fans out over the existing per-project `sync` (ADR-0010), never
  reimplements it.

### The manager-module contract (C4) — the spine (ADR-0001, ADR-0014, BR-INT-001)

Every `forge/manager/<noun>.mjs` exports exactly:

```
export async function run(subcmd, args, ctx) {
  // do the group's work; NEVER write stdout/stderr
  return { ok: boolean, data: any, findings: Finding[], summary: object };
}
export function summarize(state) {
  // pure; map this noun's persisted state to a one-panel summary
  // return a (no data) panel when state is absent — fail-open
  return { panel: '<noun>', ok, lines: string[], hint?: string };
}
```

Invariants the contract carries (all in BR-INT):
- **Print/compute split** — `run` returns data; the dispatcher renders. Makes `--json` free (ADR-0004).
- **Store-only state** — reads/writes go through `manager/lib/store.mjs`; no module touches `fs` for state.
- **Fail-open** — any failure degrades to an empty result / `(no data)` panel, never throws past the
  dispatcher.
- **Dry-run default** — writing verbs require `--apply`/`--write` (BR-CLI-007).
- **Paired validator** — each noun ships `lint/validate-<noun>.mjs`, auto-discovered (ADR-0014).

### Shared foundation: `manager/lib/`

| File | Role |
|---|---|
| `store.mjs` | The storage seam (ADR-0002/0003): `readJson/writeJsonAtomic/appendJsonl/readJsonl`, root resolution by data-kind, `schemaVersion` stamping, atomic temp-rename, advisory `.lock`. |
| `json-out.mjs` | The single envelope writer (C3): wraps a module result or a runner parse into `{forge, command, ok, ts, data, findings[], summary}`. |
| `findings.mjs` | Parse `LEVEL path:line message` → C2 finding; emit a C2 finding. Used by the runner parser and by modules. |
| `walk.mjs` | Deterministic library traversal (the registry scan surface). |
| `frontmatter.mjs` | Frontmatter parse, **extracted from existing validators** so registry and `validate-manifests` agree. |
| `resolve-kind.mjs` | `kind`→`path` mapping, **extracted from `validate-manifests.mjs`** (BR-REG-003). |
| `hash.mjs` | The one `sha256hex(bytes)` helper (ADR-0005), mirroring `bin/forge.mjs#sha256hex`. |

Extraction (not duplication) is deliberate: the registry must resolve artifacts the *same* way the
composition validator does, or it lies about the tree (BR-REG-003).

### The three logical roots (carried in `ctx`) (ADR-0003)

Forge already separates the **library** from the **target project**; the manager adds the **machine-local
state home**:

| Root | What | Resolved from | Owns |
|---|---|---|---|
| `FORGE_ROOT` | the forge library (the harness being managed) | `bin/forge.mjs` `FORGE_ROOT` const | git-tracked truth: `forge/.forge/` (registry, log, eval baselines/cases) |
| `PROJECT_DIR` | the target project (default `cwd`) | `positional[0] || process.cwd()` | per-project marker `.claude/.forge.json` (read for fleet/sourceRev) |
| `STATE_HOME` | machine-local manager state | `resolveClaudeHome().claudeDir + '/forge'` | machine-local cache: `fleet.json`, `telemetry/`, `eval-runs/`, `analyze/` |

`ctx = { FORGE_ROOT, PROJECT_DIR, STATE_HOME, flags, opts, store }`. A module never re-derives a path or
re-parses argv; it asks `ctx`/`store`. `FORGE_ROOT` vs `PROJECT_DIR` is forge's existing, sacred
separation (the library is never the project); `STATE_HOME` is the new third leg, kept physically outside
any git tree so machine-local data cannot be committed (BR-INT-004, C6).

### Composition with the existing harness (BR-INT-007)

- **`doctor`** — additive manager-scope lines (registry presence/staleness, advisory drift), existing
  output and exit semantics unchanged.
- **`validate`** — auto-discovers `validate-registry.mjs` + `validate-manager-zerodep.mjs` via the existing
  glob; `--json` flows to the parent parser (ADR-0004).
- **`sync`** — untouched; `fleet sync` orchestrates it per project (Bundle B).
- **`status`** — new; composes every `summarize()` (SPEC-08), fail-open.

## Data structures

- `Ctx` = `{ FORGE_ROOT, PROJECT_DIR, STATE_HOME, flags:Set, opts:object, store:Store }`.
- `ModuleResult` = `{ ok:boolean, data:any, findings:Finding[], summary:object }` (returned by `run`).
- `Finding` (C2) = `{ level, path, line, message, source }` (schema in SPEC-09).
- `Envelope` (C3) = `{ forge, command, ok, ts, data, findings[], summary }` (schema in SPEC-09).
- `Panel` = `{ panel, ok, lines[], hint? }` (returned by `summarize`; composed by `status`, SPEC-08).
- State file shapes (registry, fleet, telemetry, …) are owned by SPEC-09 and the dimension specs.

## CLI / interface

The command taxonomy, `forge --help` manager section, the `forge status` dashboard mock, and `--json`
behavior are specified in **SPEC-08**. This spec fixes only the *dispatch and module* mechanics behind it.

## Edge cases & failure modes

- **`main()` stays synchronous** — flat verbs keep their current synchronous bodies; the new group cases
  add a single `delegateInherit` call and `process.exit` its status. A missing/unspawnable child script
  surfaces as `delegateInherit`'s non-zero status (it prints the spawn failure to stderr), and an unknown
  group never reaches a case (falls through to usage, exit 2).
- **Module throws** — the child script (not the parent) catches, renders a single ERROR finding
  (`source` = the noun), and exits non-zero only if that finding is ERROR-level; otherwise exits 0
  (fail-open, BR-INT-003). The parent simply propagates the child's exit status.
- **Unknown sub-verb** — the module's `run` returns a usage result; the dispatcher prints it and exits 2
  (BR-CLI-009).
- **State unreadable** — `store` returns null; `summarize` yields a `(no data)` panel; `run` yields an
  empty result. No throw escapes (BR-INT-003).
- **Concurrent writers** — atomic temp-rename for snapshots; advisory lock for JSONL, drop-on-contention
  (BR-INT-005).

## Open questions

- Should `ctx.store` be a class instance or a closure-bound record? (Leaning closure for zero-class
  simplicity; deferred to implementation.)
- Does `monitor` (live tail) need its own non-`run` entry shape since it streams? Likely a `run` that
  loops until SIGINT, still returning a final result. Carried to SPEC-08/SPEC-05.

## Traceability

- **BRs:** BR-INT-001 (C4), BR-INT-002 (zero-dep), BR-INT-003 (fail-open), BR-INT-004 (storage roots),
  BR-INT-005 (atomic/lossy), BR-INT-006 (findings shape), BR-INT-007 (compose), BR-INT-008 (self-validate),
  BR-INT-009 (advisory), BR-INT-010 (proportionate); BR-CLI-001/002 (shape & print-split).
- **ADRs:** ADR-0001 (shape), ADR-0002 (storage engine), ADR-0003 (storage split / roots), ADR-0004
  (envelope), ADR-0014 (self-validation), ADR-0015 (taxonomy), ADR-0016 (phasing).
- **EVALs:** EVAL-INT-001 (zero-dep), EVAL-INT-002 (fail-open), EVAL-INT-003 (storage-additive), EVAL-INT-004
  (findings shape), EVAL-INT-005 (C4 contract), EVAL-INT-007 (compose), EVAL-INT-010 (proportionate);
  EVAL-CLI-006 (no hot-path import), EVAL-CLI-007 (print-split).
