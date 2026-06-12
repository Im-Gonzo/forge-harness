# ADR-0003: Storage split — git-tracked `forge/.forge/` vs machine-local `~/.claude/forge/`

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.2

## Context

The manager's state divides cleanly into two natures. Some of it *is the harness's identity* and must
travel with the code, be reviewed in PRs, and be reproducible from a fresh checkout: the registry, the
per-artifact change log, eval baselines and cases. The rest is *observations of this machine*: telemetry
events, the fleet index of where harnesses are installed, eval-run outputs, an analyze cache. The second
kind is private (foundational invariant 6: machine-local data physically cannot be committed) and
non-authoritative (it is a cache that any command can rebuild). `bin/forge.mjs` already models a
machine-local root: `resolveClaudeHome()` returns `~/.claude/…` and `.forge-install-state.json` lives
there. We need a split that makes privacy *structural*, not a `.gitignore` we might forget.

## Decision

**Git-tracked truth lives under `forge/.forge/` (inside FORGE_ROOT, committed). Machine-local cache lives
under `~/.claude/forge/` (resolved from `resolveClaudeHome()`). No machine-local file is ever
authoritative.**

- **`forge/.forge/` — committed, the harness's truth (root: `FORGE_ROOT`):**
  - `registry.json`, `registry.log.jsonl` (identity + changelog, ADR-0002/BR-REG)
  - eval **baselines** and eval **cases** (the harness's own acceptance corpus, BR-EVAL)
  These are reviewed in diffs, distributed by git, reproducible by `forge registry build`.
- **`~/.claude/forge/` — machine-local, never committed (root: `STATE_HOME`):**
  - `fleet.json` (the opt-in install index, BR-FLEET)
  - `telemetry/` (opt-in event logs, BR-TEL)
  - `eval-runs/` (this machine's eval execution outputs, BR-EVAL)
  - `analyze/` (cost/optimization cache, BR-EFF)
  Resolved beside `~/.claude/.forge-install-state.json`, so it inherits the same `$HOME`-based,
  sandbox-testable resolution forge already uses.
- **Privacy is structural.** Machine-local data lives *outside the git work tree entirely* — it cannot be
  `git add`-ed by accident because it is not under any tracked repo. This is stronger than `.gitignore`:
  there is no path inside `forge/` (or any project) where telemetry/fleet data can be staged.
- **Non-authoritative rule (C6).** Anything in `~/.claude/forge/` is a *cache or observation*. A command
  must function (fail-open, with a `(no data — run X)` panel) when it is absent, stale, or unreadable.
  Truth is recomputable: the registry rebuilds from the tree; fleet rebuilds from a filesystem scan;
  telemetry/analyze are derived signals. No decision depends on a machine-local file being present.
- **Enforcement.** A meta-test (`tests/meta/manager-storage-additive.mjs`, ADR-0014/BR-INT) asserts the
  manager writes only under these two roots and that every state file carries `schemaVersion`. The store
  seam (ADR-0002) is the only writer, so the assertion has one place to hold.

## Consequences

**Positive**
- Privacy can't be lost to a forgotten `.gitignore` — it is enforced by *where the files physically are*.
- A PR diff shows exactly the identity change (registry/log/baselines) and never noisy local telemetry.
- `forge` keeps one machine-local home (`~/.claude/…`), consistent with install state; nothing new to
  learn about where data goes.

**Negative**
- Two roots to reason about; a module must ask the store for the right one. Mitigated by `ctx` carrying
  both (`FORGE_ROOT`, `STATE_HOME`) and the store routing by data kind, so modules never hard-code paths.
- Machine-local data is not backed up by git; losing it loses only rebuildable cache (by design).

**Neutral**
- `forge/.forge/` is a *hidden* dir inside the library, intentionally adjacent to `manifests/` but
  namespaced so it reads as "manager state" at a glance.

## Alternatives considered

- **Everything under `forge/.forge/` (all committed).** Rejected: telemetry/fleet are private and noisy;
  committing them breaks invariant 6 and pollutes diffs.
- **Everything under `~/.claude/forge/` (all machine-local).** Rejected: the registry/baselines *must* be
  versioned with the code (C6); a machine-local registry can't be reviewed or distributed.
- **One root + `.gitignore` to hide the private parts.** Rejected: privacy-by-`.gitignore` is a foot-gun
  (one `git add -f`, one mis-merged ignore file, and telemetry leaks). Physical separation is safer.

## Related

ADR-0002 (the file shapes stored in each root), ADR-0010 (fleet as machine-local cache), ADR-0011
(telemetry local-only), ADR-0001 (`ctx` carries both roots; store routes by kind), ADR-0014 (the
storage-additive meta-test). C6, invariant 6, BR-INT, BR-FLEET, BR-TEL, BR-EFF, BR-EVAL, SPEC-09.
