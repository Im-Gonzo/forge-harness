# ADR-0010: Fleet is an opt-in cache, never authoritative; no daemon

Status: Accepted (design-stage)
Date: 2026-06-05
Phase: v0.3 (fleet read-only) → v0.5 (fleet write/merge) — **DEFERRED (Tier 3)** per `ideas/01-proportionality.md`

## Context

Once several projects are tailored from the harness, "which of my projects are behind, and on what?"
becomes a real question. The full Bundle-B vision was a *fleet manager*: a central index of every tailored
project, continuously kept truthful, with bulk remediation. The proportionality verdict
(`ideas/01-proportionality.md`) puts the entire fleet dimension in **Tier 3 — defer until many projects or
a collaborator**, with the blunt observation that `find ~ -name .forge.json` already enumerates projects and
git already distributes the library. We therefore **spec the fleet fully** (so it is coherent and growable)
but **build it last and lean**: read-only in v0.3, write/merge in v0.5, both behind an explicit opt-in.

Two hard constraints shape the design:

1. **There is already a source of truth — two, in fact.** The per-project **marker**
   (`<project>/.claude/.forge.json`) is the truth about *that project*; `~/.claude/.forge-install-state.json`
   is the truth about the *global install*. A fleet index must not become a third, competing authority.
2. **No background process.** A daemon that crawls the filesystem to keep an index "live" is exactly the
   kind of always-on machinery the proportionality rule forbids ("the manager must never cost more to
   maintain than the harness it manages"), and it violates fail-open (#4) by adding a moving part that can
   wedge a session.

## Decision

**The fleet index is a machine-local CACHE, never authoritative.**

- It lives at `~/.claude/forge/fleet.json` (the machine-local storage root, `ADR-0003` / `C6`) — **never**
  in git-tracked `forge/.forge/`, **never** shipped, **never** committed.
- **Per-project truth always wins.** On any conflict between `fleet.json` and a project's marker, the marker
  is believed and the index row is corrected. Deleting `fleet.json` loses *nothing* but the index — it is
  rebuilt by re-scanning markers (`forge fleet scan`). This is `C6` made concrete for Bundle B.

**The fleet is OPT-IN, default OFF (privacy-first).**

- `fleetEnabled` defaults to **false**. A project is registered into the index **only** when:
  (a) `forge init --apply` runs *after* `forge fleet enable`, or (b) the user runs `forge fleet add .`.
- `doctor` and `sync` **detect-and-offer** registration when they see an unregistered marker — they never
  silently mutate the global index (invariant #3, detect-and-offer-never-auto-mutate). Registration is a
  global-state change and so requires explicit confirmation.

**No daemon — refresh is opportunistic and user-driven.**

- `doctor` / `sync`, when run against a project, update *that one project's* row as a side effect (free, the
  data is already computed).
- `forge fleet scan` crawls configured `scanRoots` for `**/.claude/.forge.json` at **bounded depth**,
  **skipping `node_modules/` and `.git/`**, and reconciles each row's `status`. This is the only "crawl",
  and it runs only when asked.
- Truthfulness is therefore **eventual** and **user-driven**. The UI always shows *staleness* honestly:
  "last reconciled Nd ago". The index never claims to be live.

**Drift compute reuses existing forge code — it does not reinvent it.**

- Component/version drift for a row is computed from the **existing `cmdDoctor` checksum loop and
  version-drift check** (`forge.mjs` ~lines 897–940) plus `sourceRev` comparison (`ADR-0009`). A cheap
  `markerChecksum` gate (sha256 of the marker bytes) lets `fleet status`/`drift` skip projects whose marker
  is unchanged since last reconcile.
- **Bulk remediation reuses the existing per-project `forge sync`** (`cmdSync`); `forge fleet sync` is an
  *orchestrator* over it, not a re-implementation of the merge. User edits stay sacred (#2): an edited file
  is **staged** to a 3-way merge directory, never clobbered. (Detailed in **SPEC-04**.)

**Lifecycle and fail-open.** Rows carry a `status` (`active | stale | moved | missing | ignored | pinned`).
A `pinned` project is intentionally held on an older line and excluded from sync. A `moved` project (path
gone, marker found elsewhere by `generatedAt` match) is offered a relink. A **corrupt or missing
`fleet.json` never blocks `init`/`doctor`/`sync`** — the index degrades to "no fleet data" and the command
proceeds (#4).

## Consequences

**Positive**
- Zero new authoritative state; `fleet.json` is disposable and always reconstructable from markers.
- No background process; nothing to wedge a session; honest staleness instead of false liveness.
- Privacy-first by construction: opt-in, machine-local, physically un-committable (#6).
- Maximal code reuse — drift and sync are existing `cmdDoctor`/`cmdSync` logic, orchestrated.

**Negative**
- The index can be stale; "last reconciled Nd ago" is the honest cost of having no daemon. Acceptable: the
  user triggers `scan` when they want freshness.
- Deferring write/merge to v0.5 means bulk upgrades are manual (per-project `forge sync`) until then — which
  is precisely the Tier-3 trigger ("manual is painful") that justifies building it.

**Neutral**
- `scanRoots` is user-configured machine-local state; sensible default is `$HOME` with the standard skips.
- `markerChecksum` doubles as a freshness gate and a tamper indicator (row marked `stale` if it changed).

## Alternatives considered

- **A daemon / file-watcher keeping the index live** — rejected: always-on cost, a fail-open hazard, and
  disproportionate at `n` = a handful of projects.
- **Make `fleet.json` authoritative (a real database of projects)** — rejected: creates a third source of
  truth that can disagree with the markers; violates `C6`. The marker must always win.
- **Always-on auto-registration on `init`** — rejected: silent global mutation (violates #3) and a privacy
  default-on. Opt-in + detect-and-offer instead.
- **Ship fleet in v0.2 with the registry** — rejected by proportionality: fleet is Tier 3; `find` + git
  already cover the lean case. Build it only when manual enumeration genuinely hurts.

## Related

- ADR-0003 / C6 (git-tracked truth vs machine-local cache — fleet is the cache)
- ADR-0009 (`provenance.sourceRev` — the signal the fleet consumes for component drift)
- ADR-0007 / C5 (advisory gates — fleet drift is advisory, never blocking)
- BR-FLEET-005..020 (fleet rules); BR-CLI (verb taxonomy for `forge fleet …`); BR-INT (fail-open, detect-and-offer)
- SPEC-04 (design); EVAL-FLEET-003 (drift), -004 (user-edits-sacred), -005 (fail-open), -006 (opt-in default-off)
