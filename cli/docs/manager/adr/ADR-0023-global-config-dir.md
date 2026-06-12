# ADR-0023: Global config dir (`FORGE_HOME`) for the machine-level federation state

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (Realignment Slice 6 — relocate the GLOBAL federation state — the sources manifest, the sync lockfile, the admitted manifest, and the catalog verdict sidecar — out of the `cli/` library checkout and into a machine-level global config dir `$FORGE_HOME` (default `~/.forge`), so `forge source` / `forge catalog` persist their state INDEPENDENTLY of any library install)

## Context

ADR-0017 gave Forge a federated CATALOG: external repos registered as *sources* in a manifest
(`manifests/sources.json`, `forge.sources.v1`), shallow-cloned into a machine-local CACHE
(`~/.claude/forge-sources/<id>`) and PINNED in a lockfile (`sources.lock`), then ADMITTED into the owned
LIBRARY (recorded in `manifests/admitted.json`) after a gated pipeline whose agent verdicts are recorded to
a sidecar (`catalog-verdicts.json`). ADR-0003 / SPEC-09 already split the manager's on-disk world into TWO
physical roots, never mixed: the GIT-TRACKED truth under FORGE_ROOT (`forgeStateDir()`, the reviewable
`registry.json` + eval baselines) and the MACHINE-LOCAL cache under `~/.claude/forge`
(`machineStateHome()`, the never-committed `fleet.json` / `telemetry/` / `eval-runs/`).

The federated-catalog work as first built placed FOUR of its state files UNDER the FORGE_ROOT library
checkout — `manifests/sources.json`, `.forge/sources.lock`, `manifests/admitted.json`, and
`.forge/catalog-verdicts.json` all resolved against `selfForgeRoot()` (two levels up from `manager/`). That
is the wrong tier, and it conflates two things ADR-0003 deliberately kept apart:

- **The federation state is MACHINE-GLOBAL, not library-local.** The set of registered sources, the commits
  they are pinned at, what has been admitted, and the agent verdicts behind those admissions describe THIS
  MACHINE'S federation posture. They are shared by every project on the machine and must SURVIVE a library
  reinstall/upgrade. Tying them to a particular `cli/` checkout means a re-clone, a `git clean`, or
  installing the published plugin into a different path silently loses the source registry and the admission
  history. The source byte CACHE was already correctly machine-local (`~/.claude/forge-sources`, ADR-0017 §2.2
  / ADR-0010 / C6); only the manifests + sidecar were misfiled inside the install.
- **It pollutes the reviewable library with non-reviewable runtime state.** FORGE_ROOT is the git-tracked,
  reviewable identity of the harness (ADR-0003). A machine's `sources.json` / `admitted.json` /
  `catalog-verdicts.json` are runtime federation state, not part of that reviewable identity; writing them
  there muddies what is "the harness" vs "this machine's use of it" and risks committing machine-specific
  federation choices.

The architecture was already 90% correct — the cache is machine-local, and per-project composition state
(subscriptions, composition, adjudication, tailoring, `forge.lock`) correctly lives under the active PROJECT
root (ADR-0018..0022). The one remaining misfiling is the GLOBAL federation state. This ADR introduces a
THIRD blessed root to hold exactly it.

## Decision

### 1. `FORGE_HOME` is the GLOBAL config root for machine-level federation state

A new root resolver, `store.mjs#forgeHome()`, returns the **global config dir**:

```js
export function forgeHome() {
  const envVar = process.env.FORGE_HOME;
  if (envVar) return path.resolve(envVar);
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
  return path.join(home, '.forge');
}
```

- Default `~/.forge`, **env-overridable** via `$FORGE_HOME` (resolved to an absolute path). Resolved the same
  sandbox-friendly way as `machineStateHome()` (`$HOME`/`$USERPROFILE`, falling back to `os.homedir()`), so
  tests can sandbox it by pointing `$HOME` (or `$FORGE_HOME`) at a temp dir.
- It holds the GLOBAL federation state — and ONLY that:

  | file | path under FORGE_HOME | schema | owner |
  |---|---|---|---|
  | sources manifest | `manifests/sources.json` | `forge.sources.v1` | `manager/source.mjs` |
  | sync lockfile | `.forge/sources.lock` | `forge.sources.lock.v1` | `manager/source.mjs` |
  | admitted manifest | `manifests/admitted.json` | `forge.admitted.v1` | `manager/catalog.mjs` |
  | verdict sidecar | `.forge/catalog-verdicts.json` | `forge.catalog-verdicts.v1` | `manager/catalog.mjs` |

- Pure path join; does not create the directory (the atomic `store.mjs` writers `mkdirSync` parents on write,
  fail-open).

### 2. Three blessed roots, never mixed

FORGE_HOME is the THIRD physical root, DISTINCT from the two ADR-0003 already named:

| root | resolver | holds | committed? |
|---|---|---|---|
| **FORGE_ROOT library** | `forgeStateDir(forgeRoot)` (= `<forgeRoot>/.forge`) | the reviewable CORE resources + `registry.json` + `registry.log.jsonl` + eval baselines/cases | git-tracked (the harness's identity) |
| **machine cache** | `machineStateHome()` (= `~/.claude/forge`) | `fleet.json`, `telemetry/`, `eval-runs/`, `analyze/` — private observation | never committed |
| **global config** | `forgeHome()` (= `~/.forge`, this ADR) | the GLOBAL federation state (sources manifest, sync lockfile, admitted manifest, verdict sidecar) | never committed (machine-global) |

Relationship to the two ADR-0017 paths under `~/.claude`:

- **`~/.claude/forge-sources/<id>`** (the source byte CACHE, ADR-0017 §2.2 / `cacheRoot()`) is UNCHANGED — it
  still holds the cloned bytes, outside any work tree. FORGE_HOME holds the *records about* those sources
  (the manifest + the pins), the cache holds the *bytes*.
- **`~/.claude/forge`** (the machine cache, `machineStateHome()`) is UNCHANGED — fleet/telemetry/eval-runs
  stay there. FORGE_HOME is a SEPARATE dir (`~/.forge`) for the federation state specifically; it is not
  folded into `~/.claude/forge` so the federation posture is a first-class, easily-located, env-overridable
  config root rather than buried under the Claude home.

### 3. What MOVES, and what explicitly does NOT

**MOVES to FORGE_HOME (the GLOBAL federation-state storage):**

- `manager/source.mjs#manifestPath()` → `<FORGE_HOME>/manifests/sources.json` (the only persistent file
  source.mjs writes).
- `manager/source.mjs#lockPath()` → `<FORGE_HOME>/.forge/sources.lock`.
- `manager/catalog.mjs#admittedPath()` → `<FORGE_HOME>/manifests/admitted.json` (every read/write routes
  through this one resolver: `readAdmitted` / `persistAdmitted` / `upsertAdmitted`).
- `manager/catalog.mjs#verdictsPath()` → `<FORGE_HOME>/.forge/catalog-verdicts.json`.
- `manager/catalog.mjs#readSourcesAndLock()` now READS the sources manifest + sync lockfile from FORGE_HOME
  (it consumes what source.mjs writes), so the catalog VIEW = CORE library (FORGE_ROOT registry) ∪ synced
  sources still holds.
- The two cross-module CONSUMERS of the moved files follow the move at their READ sites ONLY (they remain
  read-only against this state; the owning modules above are the sole writers):
  - `manager/conflict.mjs#verdictsPath()` reads the verdict sidecar from FORGE_HOME (to surface the recorded
    judge verdict). Its `eval/` baseline read stays under FORGE_ROOT (a CORE library artifact, not federation
    state).
  - `manager/lock.mjs#sourcesLockPath()` reads `sources.lock` from FORGE_HOME (to JOIN each entry's pinned
    `commit` into `forge.lock`, ADR-0022 §5).

**Does NOT move (unchanged):**

- The CORE LIBRARY record production from FORGE_ROOT — `buildRegistry()` / the registry build that produces the
  library half of the catalog still resolves against FORGE_ROOT. Only the federated-state STORAGE moves; the
  "catalog = core ∪ synced sources" invariant is preserved.
- `manager/source.mjs#cacheRoot()` (`~/.claude/forge-sources/<id>`) and `selfForgeRoot()` — the byte cache and
  the FORGE_ROOT resolver are untouched.
- ALL per-project state — subscriptions, composition (`.forge/composition.json`), adjudication
  (`.forge/adjudication.json`), tailoring (`.forge/tailoring.json`), and the project lockfile
  (`<activeRoot>/forge.lock`) — stays under the ACTIVE PROJECT ROOT (ADR-0018..0022). FORGE_HOME is GLOBAL,
  not per-project; these are orthogonal tiers.

### 4. Command behavior, the C3 envelope, and the read-view are UNCHANGED

This is a STORAGE-LOCATION change only. No command's behavior, output shape, the C3 envelope, the read-view
logic, the admission pipeline, the security-scan gate, dedup, or the judge change. Findings render the moved
files relative to FORGE_HOME for clean display (fail-open to absolute). The zero-dependency CLI idiom and the
fail-open / atomic-write discipline (`store.mjs`) are preserved.

### 5. One-time migration

For an existing install that already has federation state under the OLD `cli/` location, the migration is a
one-time COPY into FORGE_HOME:

- copy `cli/manifests/sources.json` → `~/.forge/manifests/sources.json` (and, if present,
  `cli/manifests/admitted.json` → `~/.forge/manifests/admitted.json`, `cli/.forge/sources.lock` →
  `~/.forge/.forge/sources.lock`, `cli/.forge/catalog-verdicts.json` → `~/.forge/.forge/catalog-verdicts.json`).

No automatic migration is performed (fail-open: an absent FORGE_HOME manifest degrades to an empty source
registry, exactly as a first run does). After copying, the old in-checkout files can be deleted; the byte
cache at `~/.claude/forge-sources` needs no migration (it never moved). Re-running `forge source sync` after
the copy re-pins the lockfile if it was not migrated.

## Consequences

**Positive**
- The machine's federation state (which sources are registered, at which commits, what is admitted, and the
  verdicts behind it) now persists INDEPENDENTLY of any `cli/` checkout — surviving a reinstall, a re-clone, a
  `git clean`, or installing the published plugin into a different path. It is shared by every project on the
  machine, which is what a machine-global config dir is for.
- FORGE_ROOT stays a clean, reviewable library identity (ADR-0003): no machine-specific federation runtime
  state pollutes the git-tracked harness.
- `$FORGE_HOME` is env-overridable, so CI / multi-tenant / sandboxed runs can point the federation state at an
  isolated dir trivially — and the test suites already do exactly that (via `$HOME`/`$FORGE_HOME`).
- The three-root split (library / machine-cache / global-config) is now explicit and symmetric with the
  cache's existing correct placement.

**Negative**
- A THIRD physical root now exists (`~/.forge`) alongside `~/.claude/forge` (machine cache) and the FORGE_ROOT
  library; users and docs must keep the distinction (federation records vs. private observation vs. reviewable
  library) clear. The table in §2 is the canonical disambiguator.
- Existing installs need the one-time copy (§5). It is a documented manual step, fail-open (a missing manifest
  is just an empty registry), and only affects a machine that had already registered sources under the old
  location.

**Neutral**
- The source byte CACHE (`~/.claude/forge-sources`) is unaffected — bytes and the records about them now live
  in cleanly separate, both-machine-local roots.
- This changes NO schema, NO command behavior, NO envelope, and NO per-project state location; it is purely
  WHERE the four global federation-state files resolve. Identity stays `contentHash` (ADR-0005); provenance
  stays the minimal `source` object (ADR-0009).

## Alternatives considered

- **Leave the federation state under the FORGE_ROOT library checkout (the original placement).** Rejected:
  it ties machine-global state to a particular install path, loses it on reinstall/re-clone, and pollutes the
  reviewable git-tracked library with machine-specific runtime state — the exact conflation ADR-0003's
  two-root split exists to prevent.
- **Fold the federation state into the existing machine cache `~/.claude/forge` (`machineStateHome()`).**
  Rejected: `~/.claude/forge` holds PRIVATE OBSERVATION (fleet/telemetry/eval-runs) that is lossy-by-design and
  never authoritative (SPEC-09). The federation manifests + admission record are AUTHORITATIVE machine config
  the user reasons about and may want to back up or point a tool at; a dedicated, named, env-overridable
  `~/.forge` makes it a first-class config root rather than burying it under the Claude home next to telemetry.
- **Use an XDG base dir (`$XDG_CONFIG_HOME/forge`).** Rejected for now: the manager's whole idiom resolves
  home via `$HOME`/`$USERPROFILE`/`os.homedir()` for sandbox-friendliness and cross-platform parity (SPEC-09,
  `machineStateHome()`); `$FORGE_HOME`-or-`~/.forge` mirrors that idiom exactly and keeps one obvious override
  knob. XDG could be layered in later without changing the resolver's contract.
- **Move per-project state (composition/adjudication/tailoring/`forge.lock`) into FORGE_HOME too.** Rejected:
  those are PER-PROJECT by design (ADR-0018..0022) and correctly live under the active project root —
  FORGE_HOME is GLOBAL. Only the machine-global federation state moves.

## Related

- ADR-0003 (the two physical state roots: git-tracked truth under FORGE_ROOT vs. machine-local cache under
  `~/.claude/forge` — this ADR adds the THIRD root, the global config dir, for the federation state that
  belonged in neither)
- ADR-0017 (federated catalog — the sources manifest, the `sources.lock` lockfile, the `~/.claude/forge-sources`
  byte CACHE this ADR keeps put, the admitted manifest, and the verdict sidecar whose STORAGE this relocates)
- ADR-0010 / C6 (the machine-local-cache-outside-any-work-tree discipline the byte cache already follows, and
  the same never-committed posture FORGE_HOME inherits for the federation records)
- ADR-0020 (conflict adjudication — `manager/conflict.mjs` reads the verdict sidecar; its read site follows the
  move, its `eval/` baseline read stays under FORGE_ROOT)
- ADR-0022 (project lockfile — `manager/lock.mjs` CONSUMES `sources.lock`'s per-entry `commit`; its read site
  follows the move. `forge.lock` itself is PER-PROJECT and stays at the project root)
- SPEC-09 (the storage seam + the canonical on-disk layout: `store.mjs` is the single state seam; `forgeHome()`
  is the new root resolver added beside `forgeStateDir()` / `machineStateHome()`)
- docs/specs/catalog.md §2 + BR-CAT-021.. (the normative rules for the global config dir)
- manager/lib/store.mjs (`forgeHome()`), manager/source.mjs (`manifestPath`/`lockPath`), manager/catalog.mjs
  (`admittedPath`/`verdictsPath`/`readSourcesAndLock`), manager/conflict.mjs + manager/lock.mjs (the read-only
  consumers that follow the move)
