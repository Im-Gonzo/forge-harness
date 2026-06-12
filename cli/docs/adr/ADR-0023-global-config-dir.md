# ADR-0023: Global config dir (`FORGE_HOME`) for the machine-level federation state

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (Realignment Slice 6 — relocate the GLOBAL federation state out of the `cli/` library checkout into a machine-level global config dir `$FORGE_HOME`, default `~/.forge`)

> **Release-facing copy.** This is the global-config-dir decision as cited by the shipped harness assets and
> the `source`/`catalog` CLI verb groups (`manager/source.mjs`, `manager/catalog.mjs`). The full design-stage
> record — alternatives considered and the manager corpus cross-references — lives in
> [docs/manager/adr/ADR-0023-global-config-dir.md](../manager/adr/ADR-0023-global-config-dir.md). The companion
> SPEC section is [docs/specs/catalog.md](../specs/catalog.md) §2 + BR-CAT-021.

## Context

ADR-0017 gave Forge a federated CATALOG: external repos registered in a manifest (`manifests/sources.json`),
shallow-cloned into a machine-local CACHE (`~/.claude/forge-sources/<id>`) and PINNED in `sources.lock`, then
ADMITTED into the owned LIBRARY (recorded in `manifests/admitted.json`) with agent verdicts recorded to a
sidecar (`catalog-verdicts.json`). ADR-0003 / SPEC-09 split the manager's on-disk world into TWO roots, never
mixed: the GIT-TRACKED truth under FORGE_ROOT (the reviewable `registry.json` + eval baselines) and the
MACHINE-LOCAL cache under `~/.claude/forge` (never-committed fleet/telemetry/eval-runs).

As first built, FOUR federated-state files resolved UNDER the FORGE_ROOT library checkout —
`manifests/sources.json`, `.forge/sources.lock`, `manifests/admitted.json`, `.forge/catalog-verdicts.json`.
That is the wrong tier: this state is MACHINE-GLOBAL (which sources are registered, at which commits, what is
admitted, the verdicts behind it), shared by every project on the machine, and must SURVIVE a library
reinstall/upgrade. Tying it to a `cli/` checkout loses it on a re-clone, a `git clean`, or installing the
published plugin into a different path — and it pollutes the reviewable git-tracked library with
machine-specific runtime state. The byte CACHE was already correctly machine-local (ADR-0017 §2.2); only the
manifests + sidecar were misfiled.

## Decision

### 1. `FORGE_HOME` is the GLOBAL config root for machine-level federation state

`store.mjs#forgeHome()` returns the global config dir: `$FORGE_HOME` if set (resolved absolute), else
`~/.forge`. Resolved the sandbox-friendly way `machineStateHome()` uses (`$HOME`/`$USERPROFILE`/`os.homedir()`).
It holds the GLOBAL federation state and ONLY that:

| file | path under FORGE_HOME | schema | owner |
|---|---|---|---|
| sources manifest | `manifests/sources.json` | `forge.sources.v1` | `manager/source.mjs` |
| sync lockfile | `.forge/sources.lock` | `forge.sources.lock.v1` | `manager/source.mjs` |
| admitted manifest | `manifests/admitted.json` | `forge.admitted.v1` | `manager/catalog.mjs` |
| verdict sidecar | `.forge/catalog-verdicts.json` | `forge.catalog-verdicts.v1` | `manager/catalog.mjs` |

### 2. Three blessed roots, never mixed

FORGE_HOME is the THIRD physical root, DISTINCT from the two ADR-0003 named:

| root | resolver | holds | committed? |
|---|---|---|---|
| FORGE_ROOT library | `forgeStateDir()` (`<forgeRoot>/.forge`) | reviewable CORE resources + `registry.json` + eval baselines | git-tracked |
| machine cache | `machineStateHome()` (`~/.claude/forge`) | `fleet.json`, `telemetry/`, `eval-runs/`, `analyze/` | never committed |
| global config | `forgeHome()` (`~/.forge`, this ADR) | the GLOBAL federation state (§1) | never committed (machine-global) |

The source byte CACHE `~/.claude/forge-sources/<id>` (ADR-0017 §2.2) is UNCHANGED — it holds the cloned
*bytes*; FORGE_HOME holds the *records about* those sources. The machine cache `~/.claude/forge` is UNCHANGED;
FORGE_HOME is a SEPARATE, env-overridable dir (`~/.forge`) so the federation posture is a first-class config
root, not buried under the Claude home next to telemetry.

### 3. What MOVES, and what does NOT

**MOVES to FORGE_HOME:** `source.mjs#manifestPath()` (`manifests/sources.json`) and `#lockPath()`
(`.forge/sources.lock`); `catalog.mjs#admittedPath()` (`manifests/admitted.json`, every read/write routes
through it) and `#verdictsPath()` (`.forge/catalog-verdicts.json`); `catalog.mjs#readSourcesAndLock()` reads
the manifest + lockfile from FORGE_HOME (so "catalog = core ∪ synced sources" still holds). The two cross-module
READ consumers follow the move at their read sites only: `conflict.mjs#verdictsPath()` (verdict sidecar) and
`lock.mjs#sourcesLockPath()` (the `commit` JOIN into `forge.lock`, ADR-0022 §5).

**Does NOT move:** the CORE LIBRARY record production from FORGE_ROOT (`buildRegistry()` / the registry build);
`source.mjs#cacheRoot()` (`~/.claude/forge-sources`) and `selfForgeRoot()`; conflict's `eval/` baseline read
(a CORE library artifact); and ALL per-project state — subscriptions, composition, adjudication, tailoring, and
the project lockfile `forge.lock` stay under the ACTIVE PROJECT ROOT (ADR-0018..0022). FORGE_HOME is GLOBAL, not
per-project.

### 4. Command behavior, the C3 envelope, and the read-view are UNCHANGED

A STORAGE-LOCATION change only. No command behavior, output shape, C3 envelope, read-view, admission pipeline,
security-scan gate, dedup, or judge changes. Findings render the moved files relative to FORGE_HOME for clean
display (fail-open to absolute). The zero-dep CLI idiom and the fail-open / atomic-write discipline are kept.

### 5. One-time migration

For an existing install with state under the OLD `cli/` location, copy it once into FORGE_HOME:
`cli/manifests/sources.json` → `~/.forge/manifests/sources.json` (and likewise `admitted.json`,
`.forge/sources.lock` → `~/.forge/.forge/sources.lock`, `.forge/catalog-verdicts.json` →
`~/.forge/.forge/catalog-verdicts.json`). No automatic migration runs (fail-open: an absent manifest is just an
empty registry). The byte cache `~/.claude/forge-sources` needs no migration; `forge source sync` re-pins the
lockfile if it was not copied.

## Consequences

- The machine's federation state now persists INDEPENDENTLY of any `cli/` checkout — surviving a reinstall,
  re-clone, `git clean`, or a different install path — and is shared by every project on the machine.
- FORGE_ROOT stays a clean, reviewable library identity (ADR-0003): no machine-specific runtime state pollutes
  the git-tracked harness.
- `$FORGE_HOME` is env-overridable, so CI / sandboxed runs isolate the federation state trivially (the test
  suites already do, via `$HOME`/`$FORGE_HOME`).
- A THIRD root now exists (`~/.forge`) alongside `~/.claude/forge` and the FORGE_ROOT library; the §2 table is
  the canonical disambiguator. Existing installs need the one-time copy (§5, fail-open, manual).
- Changes NO schema, NO command behavior, NO envelope, NO per-project state location. Identity stays
  `contentHash` (ADR-0005); provenance stays the minimal `source` (ADR-0009).

## Related

- [docs/manager/adr/ADR-0023-global-config-dir.md](../manager/adr/ADR-0023-global-config-dir.md) — the full
  design-stage record (alternatives, manager corpus xrefs).
- [docs/adr/ADR-0017-federated-catalog.md](./ADR-0017-federated-catalog.md) — the federated catalog whose
  sources manifest / `sources.lock` / admitted manifest / verdict sidecar STORAGE this relocates; the
  `~/.claude/forge-sources` byte cache it keeps put.
- [docs/adr/ADR-0020-conflict-adjudication.md](./ADR-0020-conflict-adjudication.md) — `conflict` reads the
  verdict sidecar; its read site follows the move.
- [docs/adr/ADR-0022-project-lockfile.md](./ADR-0022-project-lockfile.md) — `lock` CONSUMES `sources.lock`'s
  per-entry `commit`; its read site follows the move (`forge.lock` itself stays per-project).
- [docs/specs/catalog.md](../specs/catalog.md) §2 + BR-CAT-021 — the normative rules for the global config dir.
- `manager/lib/store.mjs` (`forgeHome()`), `manager/source.mjs`, `manager/catalog.mjs`, `manager/conflict.mjs`,
  `manager/lock.mjs` — the resolver and its writers/consumers.
