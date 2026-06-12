# ADR-0001: Manager shape — subcommands on `bin/forge.mjs` + lazy `forge/manager/<noun>.mjs` modules

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.2

## Context

The manager adds a large surface (registry, fleet, telemetry, analyze, optimize, eval-harness, status) to
a harness whose entire CLI today is a single `switch (cmd)` in `bin/forge.mjs` (~lines 1700-1747) with a
flat verb set (`profile|validate|init|doctor|sync|install|uninstall|help`). We must add that surface
without (a) breaking the existing flat verbs, (b) bloating the always-loaded path of `bin/forge.mjs` (a
solo dev runs `forge doctor` far more than `forge optimize`), or (c) violating zero-dep / fail-open.

Three shape questions: one binary or two? where does each group's logic live? and does business logic
print, or return data the dispatcher renders (the latter is what makes `--json` cheap — see ADR-0004)?

## Decision

**One binary. Noun-first subcommand *groups* dispatched from the existing `switch (cmd)`. Each group's
logic lives in a lazily-imported `forge/manager/<noun>.mjs` module. Business logic never writes stdout —
it returns a structured result the dispatcher renders as human text or `--json`.**

1. **No second binary, no TUI.** `forge` stays the only entry point; the manager is more cases on the same
   switch. A new top-level case per group (`registry`, `fleet`, `telemetry`, `analyze`, `optimize`,
   `eval-harness`, `status`, `monitor`) sits beside the existing verbs. `doctor`/`sync`/`validate` are
   *extended additively* (ADR-0014), not replaced. No TUI/web UI now (out of scope, `ideas/02`).
2. **Lazy modules.** Each group case does `const mod = await import('../manager/<noun>.mjs')` only when
   that group is invoked, then calls `mod.run(subcmd, args, ctx)`. The existing flat verbs and the
   `bin/forge.mjs` startup path import nothing new. `main()` becomes `async` (top-level `await import`).
3. **The module contract (C4).** Every `forge/manager/<noun>.mjs` exports:
   - `run(subcmd, args, ctx)` — performs the group's work and **returns** a result object
     `{ ok, data, findings[], summary }`; it MUST NOT call `console.log`/`process.stdout.write`.
   - `summarize(state)` — pure: maps that noun's persisted state to a one-panel summary object for
     `forge status` to compose (fail-open: returns a `(no data)` panel when state is absent).
   The dispatcher owns rendering: it formats `run()`'s result as human text, or — under `--json` — wraps
   it in the C3 envelope (ADR-0004). This print/compute split is what lets `--json` exist with zero
   per-command branching.
4. **Shared `manager/lib/`.** Cross-cutting helpers live once: `store.mjs` (the storage seam, ADR-0002/3),
   `json-out.mjs` (envelope writer), `findings.mjs` (parse/emit the C2 shape), `walk.mjs` (library
   traversal), `frontmatter.mjs` + `resolve-kind.mjs` (extracted from existing validators so the registry
   and `validate-manifests` agree), `hash.mjs` (the one sha256 helper, ADR-0005). Every module reaches
   state only through `store.mjs`; none reaches the filesystem for state directly.
5. **Repo layout.** New tree under `forge/manager/` (`<noun>.mjs` + `lib/`), plus two auto-discovered
   validators `lint/validate-registry.mjs` and `lint/validate-manager-zerodep.mjs` (ADR-0014).

`ctx` carries the three logical roots (`FORGE_ROOT`, `PROJECT_DIR`, `STATE_HOME` = `resolveClaudeHome()` +
`/forge`), the parsed flags (`--json`/`--dry-run`/`--apply`/`--strict`/`--quiet`), and a `store` handle —
so a module never re-derives paths or re-parses argv.

## Consequences

**Positive**
- The hot path (`doctor`, `init`, `sync`) loads zero manager code; cold groups pay their import only when
  called. Fits the proportionality verdict (`ideas/01`): the manager you don't run costs nothing.
- One print/compute seam makes `--json` (ADR-0004) and the `status` composition (ADR-0015) fall out for
  free — every group already returns data, so the renderer is written once.
- `forge` *feels like forge*: same binary, same `parseArgs`, same `delegateInherit` style for spawning
  the runners; nothing about install/marketplace changes.

**Negative**
- `main()` becomes `async`; the existing synchronous `process.exit(...)` returns must be threaded through
  an awaited dispatch. Mechanical, but it touches the one hot file.
- A module that forgets the no-stdout rule would bypass `--json`. Mechanically caught: `summarize`/`run`
  returning data is asserted by the module's paired validator and a meta-test (ADR-0014).

**Neutral**
- "Group" verbs (`registry ls`) coexist with flat verbs (`doctor`). The taxonomy that keeps them coherent
  (and resolves `status`/`stat`/`monitor`) is ADR-0015.

## Alternatives considered

- **A second binary (`forge-manage`).** Rejected: two install targets, two help systems, two arg parsers;
  the manager would feel bolted-on, contradicting the concept (`ideas/00`).
- **Eager `import` of all manager modules at top of `bin/forge.mjs`.** Rejected: every `forge doctor`
  would parse the whole manager. Lazy `await import` keeps the common path lean.
- **Business logic prints directly, `--json` re-parses its own stdout.** Rejected as fragile and circular;
  the print/compute split is strictly simpler and is the same trick ADR-0004 plays on the child runners.
- **A plugin/registry-of-commands abstraction.** Rejected as over-engineering for ~8 groups; a plain
  switch with lazy import is proportionate.

## Related

ADR-0002 (storage the modules read/write), ADR-0003 (the roots in `ctx`), ADR-0004 (the `--json`
rendering this shape enables), ADR-0014 (self-validation of the module contract), ADR-0015 (the verb
taxonomy), ADR-0016 (phasing). C4 (module contract), BR-CLI, BR-INT, SPEC-00, SPEC-08.
