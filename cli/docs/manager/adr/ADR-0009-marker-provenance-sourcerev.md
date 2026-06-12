# ADR-0009: Marker provenance via one `provenance.sourceRev` field, not per-component `components[]`

Status: Accepted (design-stage)
Date: 2026-06-05
Phase: v0.2 (provenance write) — provenance is the cheap, non-deferred half of Bundle B

## Context

A tailored project's marker (`<project>/.claude/.forge.json`) records *which* modules and files were laid
down, but not *which exact revision of the global library* they were tailored from. Without that, the
manager cannot answer the one question fleet visibility exists to answer: **"is this project in sync with
the current harness, and if not, by how much?"** The marker's per-file `checksum` only describes the
*project's own copy* (and its purpose is to detect user edits so they stay sacred — invariant #2); it says
nothing about whether the *upstream* component those bytes came from has since changed.

The original Bundle-B design proposed a per-component `components[]: [{uid, contentHash, revision}, …]`
array embedded in every marker — a frozen snapshot of every artifact the project resolved to at tailor
time. Three forces argue against it:

1. **Marker bloat / duplication.** That array duplicates data that already lives authoritatively in the
   Registry (`registry.json`, Bundle A) and is fully *reconstructable* from `registry + profile + modules`.
   A marker is a small idempotency record; it should not carry a copy of the catalog.
2. **`marker.schema.json` is `"additionalProperties": false`.** Every field added to the marker is a
   **controlled schema change**, not a free annotation. The cost of widening the schema should buy as much
   as possible — one fold-hash buys the whole "in sync?" answer; a `components[]` array buys the same
   answer at far greater width.
3. **The expensive detail is rarely needed and always derivable.** "Component R is N revisions behind" is a
   *query-time* concern surfaced by `forge fleet drift`, not per-project state that must be persisted.

`contentHash` (sha256) is the sole identity primitive (`ADR-0005`); the Registry already records every
component's `contentHash` and revision history (Bundle A). So a project's exact upstream state is fully
captured by a single deterministic fold over the hashes of the components its modules resolve to.

## Decision

Extend the marker with **one optional object field**:

```jsonc
"provenance": {
  "registrySchema": "forge.registry.v1",   // which registry schema produced the fold
  "sourceRev": "sha256:…"                   // the fold-hash, defined below
}
```

`sourceRev` is computed as:

> Resolve the project's `{profile, modules}` to its full set of components (the same resolution `init`
> performs). For each resolved component, read its `contentHash` from the Registry (see **BR-REG / ADR-0005**).
> Build the map `{uid → contentHash}`, **sort by `uid`**, serialize canonically, and `sha256` it.
> `sourceRev = "sha256:" + sha256hex(canonical(sorted({uid: contentHash})))`.

One cheap hash answers "is this project in sync?": recompute `sourceRev` against today's Registry and
compare to the stored value — equal means the upstream component set is byte-identical to tailor time.

- **The change is ADDITIVE** (new *optional* field; the marker's `required` set is unchanged, so every
  existing valid marker stays valid) **BUT it requires widening `schemas/marker.schema.json`**, which is
  `"additionalProperties": false` today. This is called out explicitly as a **controlled schema change**
  (not a free addition); it is the *only* marker shape change Bundle B makes. See **SPEC-04 §Data structures**.
- **Legacy markers without `provenance`** are valid and are treated as **version-level drift only**: the
  manager falls back to the existing `forgeVersion` comparison (the `cmdDoctor` version-drift check) and
  cannot report component-level drift until the project is re-tailored or synced and gains a `sourceRev`.
- **Per-component "N revisions behind" is NOT stored.** It is reconstructed *on demand* at query time by
  recomputing each resolved component's current `contentHash` from the Registry and diffing against the set
  folded into `sourceRev`, using the Registry's revision history (Bundle A) to count revisions. The marker
  stays minimal; the detail is derived only when `forge fleet drift` asks for it.

`sourceRev` is written by `forge init --apply` (v0.2) and refreshed by `forge sync` whenever it re-lays a
component or reconciles a project (v0.5). Writing it never requires the fleet to be enabled — provenance is
a property of the marker itself, independent of the (opt-in, deferred) fleet index (`ADR-0010`).

## Consequences

**Positive**
- One field, one hash answers the core sync question; the marker stays a small idempotency record.
- No duplication of Registry data; provenance is consistent with `contentHash`-as-sole-identity (`ADR-0005`).
- Component-level "behind by N" is available *when asked* without persisting it everywhere.
- Forward-compatible: legacy markers degrade gracefully to version-level drift, never error.

**Negative**
- Requires a controlled widening of `marker.schema.json` (the `additionalProperties:false` cost is paid
  once, deliberately).
- `sourceRev` is only meaningful relative to a Registry; on a machine with no built Registry the manager
  must fall back to version-level drift (handled, fail-open).
- Reconstructing per-component "behind by N" reads the Registry's revision history at query time (cheap,
  but not free); acceptable because it is on-demand, not on every marker write.

**Neutral**
- `registrySchema` is recorded so a future registry-schema migration can detect and recompute stale folds
  rather than silently mis-comparing.
- The fold is order-independent by construction (sort by `uid`), so `sourceRev` is reproducible across
  machines given the same Registry.

## Alternatives considered

- **Per-component `components[]` array in the marker** — rejected: bloats every marker, duplicates the
  Registry, and pays the `additionalProperties:false` schema cost for data that is reconstructable.
- **Store nothing; derive sync purely from `forgeVersion`** — rejected: too coarse. With the live-symlink
  seam (`ADR-0008`), library content can change with no `VERSION` bump, so `forgeVersion` alone cannot
  detect component drift. `sourceRev` closes exactly that gap.
- **A per-project lockfile (`forge.lock`) listing every resolved component** — rejected: that *is* the
  rejected `components[]` array under another name, with an extra file and its own drift surface.

## Related

- ADR-0005 (contentHash is the sole identity primitive — `sourceRev` derives from it)
- ADR-0006 (revision history that powers on-demand "behind by N")
- ADR-0008 (live-symlink seam: why `forgeVersion` alone is insufficient)
- ADR-0010 (fleet opt-in cache that *consumes* `sourceRev`)
- BR-FLEET-001..004 (provenance rules); BR-REG (Registry `contentHash`); SPEC-04 (design)
- EVAL-FLEET-001 (sourceRev computed correctly), EVAL-FLEET-002 (legacy marker → version-level drift only)
