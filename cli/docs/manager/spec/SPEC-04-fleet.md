# SPEC-04 — Fleet & Provenance

Status: design-stage · Phase: v0.2 (provenance) / v0.3 (fleet read) / v0.5 (fleet write) — **fleet half DEFERRED, Tier 3** · Implements: BR-FLEET-001..024 · Decided-by: ADR-0009, ADR-0010

## Summary

This dimension answers one question at two depths: **"is a tailored project in sync with the current
harness, and if not, by how much?"**

- **Provenance (v0.2, not deferred)** — the marker gains **one** field, `provenance.sourceRev`, a fold-hash
  over the `contentHash` of every component the project resolves to. One cheap comparison answers "in sync?".
  This is an additive, controlled widening of `marker.schema.json` (`ADR-0009`).
- **Fleet (v0.3 read, v0.5 write — DEFERRED, Tier 3)** — an **opt-in, machine-local cache**
  (`~/.claude/forge/fleet.json`) indexing tailored projects so drift can be queried across many of them and
  (later) remediated in bulk. The cache is never authoritative; the marker always wins; there is no daemon
  (`ADR-0010`). Per `ideas/01-proportionality.md`, this is built last and lean — `find ~ -name .forge.json`
  + git already cover the small case.

Both halves **reuse existing forge code**: the `cmdDoctor` checksum loop and version-drift check
(`bin/forge.mjs` ~lines 897–940) compute drift; `cmdSync` performs every actual file write. The manager
orchestrates; it does not re-implement.

## Design

### Provenance — `sourceRev` (v0.2)

`sourceRev` is computed at tailor time and refreshed on sync:

1. Resolve `{profile, modules}` → the full component set (the resolution `init`/`cmdSync` already perform).
2. For each component, read its `contentHash` from the Registry (*see BR-REG / ADR-0005*).
3. Build `{uid → contentHash}`, **sort by `uid`**, serialize canonically (stable key order, no whitespace
   ambiguity), and `sha256` it.
4. Write `provenance = { registrySchema, sourceRev }` into the marker (in-code, alongside the existing
   marker writer at `bin/forge.mjs` ~lines 782–805).

Sync check: recompute `sourceRev` against today's Registry; equal ⇒ component set byte-identical to tailor
time ⇒ no component drift. `registrySchema` guards against silently comparing folds produced by different
registry schemas (recompute instead).

**Legacy fallback.** A marker with no `provenance` is valid; the manager reports **version-level drift
only** via the existing `forgeVersion` comparison and sets `componentsBehind = null` (unknown) until the
project is re-tailored/synced and gains a `sourceRev` (BR-FLEET-003).

**Derived "behind by N".** Never stored. At query time, recompute each resolved component's current
`contentHash` and diff against the folded set; count revisions via Registry history (*see BR-REG /
ADR-0006*). (BR-FLEET-004)

### Fleet index (v0.3 — DEFERRED)

- **Storage:** `~/.claude/forge/fleet.json` (machine-local root, `C6`/`ADR-0003`), via
  `manager/lib/store.mjs` atomic writes. Never under git-tracked `forge/.forge/`; never shipped/committed.
- **Opt-in:** top-level `fleetEnabled` (default **false**). Registration only via `fleet enable` + `init
  --apply`, or `fleet add .` (BR-FLEET-007). `doctor`/`sync` **detect-and-offer** for unregistered markers
  (BR-FLEET-008, invariant #3).
- **Opportunistic refresh:** `doctor`/`sync` update the one row they touch. `fleet scan` is the only crawl:
  it walks `scanRoots` for `**/.claude/.forge.json` at **bounded depth**, skipping `node_modules/` and
  `.git/` (BR-FLEET-011), and reconciles `status`. No daemon (BR-FLEET-010); UI shows "reconciled Nd ago".
- **Cheap gate:** `markerChecksum` (sha256 of marker bytes) lets `status`/`drift` skip unchanged projects
  (BR-FLEET-012) and doubles as a tamper/staleness indicator.
- **Drift reuse:** drift = existing `cmdDoctor` version-drift + checksum loop + `sourceRev` compare. Not
  reinvented (BR-FLEET-012).

### Grade (v0.3)

```
unhealthy  if missingFiles > 0 OR brokenRefs > 0
drift      else if versionBehind OR componentsBehind > 0
healthy    otherwise
```

`userEditedFiles` alone is **never** unhealthy — edits are sacred (BR-FLEET-013, invariant #2).

### Bulk remediation (v0.5 — DEFERRED)

`forge fleet sync [--all|<id>] [--component R]` orchestrates per-project `cmdSync`; **dry-run by default**,
`--apply` required, `--skip-merges` applies only safe auto-upgrades; `pinned` excluded (BR-FLEET-018).
Per file, per the marker's `userEditable` + checksum state:

| File state | Action |
|---|---|
| copied + unedited (checksum matches) | **auto-upgrade** to new bytes; advance marker checksum (BR-FLEET-019) |
| copied + user-edited (checksum drift) | **stage** 3-way merge → `.claude/.forge-merge/{base,yours,new}`; **live file untouched**; mark `needs-manual-merge` (BR-FLEET-020) |
| referenced (symlink, not copied) | refresh `sourceRev` only; no file write (BR-FLEET-019) |
| module ADDED | additive lay-down (skip-if-exists, like `init`) (BR-FLEET-021) |
| module REMOVED | **never auto-delete**; report only (BR-FLEET-021) |

### Lifecycle

`active` (present, reconciled) · `stale` (`markerChecksum` changed since reconcile) · `moved` (path gone,
marker found elsewhere by `generatedAt` match → offer `relink`) · `missing` (path gone, not found) ·
`ignored` (excluded from health rollups) · `pinned` (held on an older line, excluded from sync).
Controls: `relink | forget | prune | ignore | pin` — all index-only, never touch `<project>/` files
(BR-FLEET-015, -016).

## Data structures

### Marker extension (`marker.schema.json` widening — controlled, additive)

```jsonc
// added to properties; "additionalProperties": false stays; "required" UNCHANGED
"provenance": {
  "type": "object",
  "additionalProperties": false,
  "required": ["registrySchema", "sourceRev"],
  "properties": {
    "registrySchema": { "type": "string", "minLength": 1 },
    "sourceRev":      { "type": "string", "pattern": "^sha256:[0-9a-f]+$" }
  }
}
```

Pre-change markers validate unchanged (BR-FLEET-002). The marker's existing `files[]{path, checksum,
userEditable}` is the source for the copied/edited/referenced classification above.

### `~/.claude/forge/fleet.json`

```jsonc
{
  "schema": "forge.fleet.v1",
  "fleetEnabled": false,
  "scanRoots": ["~"],            // machine-local; default $HOME with node_modules/.git skipped
  "lastScanAt": "2026-06-05T…Z",
  "projects": {
    "<id>": {                    // id = sha256(realpath)[:16]
      "path": "/abs/project",
      "tailoredFrom": "0.1.0",   // = marker.forgeVersion
      "profile": "…",
      "modules": ["core", "…"],
      "generatedAt": "…Z",       // copied from marker — relink match key
      "lastSyncedAt": "…Z",
      "lastSeenAt": "…Z",
      "markerChecksum": "sha256:…", // freshness gate (sha256 of marker bytes)
      "status": "active",        // active|stale|moved|missing|ignored|pinned
      "health": {
        "versionBehind": false,
        "componentsBehind": 0,   // null when marker has no provenance (BR-FLEET-003)
        "userEditedFiles": 0,
        "missingFiles": 0,
        "brokenRefs": 0,
        "grade": "healthy"       // healthy|drift|unhealthy
      }
    }
  }
}
```

### Staged merge layout (v0.5)

`<project>/.claude/.forge-merge/<rel-path>/{base,yours,new}` — `base` = marker-recorded original, `yours` =
current live file, `new` = upstream version. Live file is never written by sync (BR-FLEET-020).

## CLI / interface

Verbs follow the noun-first taxonomy (*see BR-CLI / ADR-0015*). Output flows through the `--json` envelope
(`ADR-0004`).

- **v0.2:** provenance is written by `init --apply` and refreshed by `sync` — no new verb.
- **v0.3 (read, DEFERRED):** `forge fleet enable | disable | add <dir> | status | scan | drift
  [--component R] | show <id>`.
- **v0.5 (write, DEFERRED):** `forge fleet sync [--all|<id>] [--component R] [--apply] [--skip-merges] |
  relink <id> | forget <id> | prune | ignore <id> | pin <id>`.

All write verbs are **dry-run by default**; `--apply` required. Drift findings are advisory `WARN`
(`C5`/`ADR-0007`).

## Edge cases & failure modes

- **Corrupt/missing `fleet.json`** → treated as "no data"; `init`/`doctor`/`sync` proceed and never throw
  (BR-FLEET-014, invariant #4). The index rebuilds on next `scan`.
- **No Registry built** → `sourceRev` cannot be recomputed; manager falls back to version-level drift, fail-open.
- **Marker with no `provenance`** → version-level drift only; `componentsBehind = null` (BR-FLEET-003).
- **Project moved** → `missing`, then `moved` + relink offer on `scan` (BR-FLEET-015); never silent relink.
- **Pinned project** → excluded from `fleet sync` even under `--all` (BR-FLEET-016, -018).
- **Marker nested under `node_modules/`** → not discovered by `scan` (BR-FLEET-011).
- **User-edited file during sync** → staged, live file byte-identical (BR-FLEET-020); never clobbered.
- **Removed module** → reported, nothing deleted (BR-FLEET-021).
- **Personal-path leak** → `validate-no-personal-paths` asserts fleet state is never staged (BR-FLEET-017).

## Open questions

- `scanRoots` default: `$HOME` vs an explicit opt-in list at first `fleet enable`. (Privacy-leaning: prompt.)
- Should `stale` rows auto-refresh on `status`, or only on `scan`? (Leaning: refresh the single queried row.)
- `relink` match when two markers share a `generatedAt` (clones): require path-prefix disambiguation. Carried.
- 3-way merge presentation: stage-only (decided) vs offering an optional external merge-tool launch. Carried.

## Traceability

- **BRs:** BR-FLEET-001..004 (provenance), -005..017 (fleet read/lifecycle), -018..024 (fleet write/merge).
- **ADRs:** ADR-0009 (provenance `sourceRev`), ADR-0010 (opt-in cache, no daemon); ADR-0005/0006 (identity,
  revision history), ADR-0008 (live-symlink seam → why version alone is insufficient), ADR-0007/C5
  (advisory), ADR-0003/C6 (storage split), ADR-0014/C4 (module contract & self-validator).
- **EVALs:** EVAL-FLEET-001 (sourceRev + schema), -002 (legacy fallback), -003 (drift detection), -004
  (user-edits-sacred merge staging), -005 (fail-open corrupt fleet.json), -006 (opt-in default-off), -007
  (cache disposable / marker wins), -008 (row schema + staleness), -009 (bounded scan), -010 (moved/relink),
  -011 (lifecycle controls / pin excluded), -012 (no-personal-paths), -013 (sync orchestration + upgrade),
  -014 (added additive / removed report-only).
