# ADR-0018: Catalog slices and per-project subscriptions

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (contract + skeleton this phase; named "packs" a documented FUTURE extension)

## Context

ADR-0017 gave Forge a federated CATALOG: external repos register as *sources*, their resources are
synced into a discoverable superset, and curated ones are ADMITTED into the active LIBRARY. That ADR
answered "where does a resource come from" and "how is it safely activated", but left two operator
questions open:

1. **How does a user browse a source's contribution at a useful granularity?** A source can carry tens
   of resources across many kinds. Listing them as one flat heap — or, at the other extreme, toggling
   each resource one at a time — are both poor ergonomics. The operator wants to reason about a source's
   contribution in coherent, named groups.
2. **What does THIS project want to see?** The catalog read-view today is "everything discoverable". As
   sources multiply, an undifferentiated read-view becomes noise, and it silently surfaces UNTRUSTED
   source content into a project's working set the moment a source is registered — at odds with the
   untrusted-by-default stance ADR-0017 took for sources themselves.

We want a **SLICE** abstraction (a named group of one source's catalog records) plus a **per-project
SUBSCRIPTION** state (which slices this project opted into), so the catalog read-view is the project's
deliberate choice rather than the union of everything anyone ever registered. This shapes an on-disk
file and a CLI/web surface that later Build agents are bound to, so the choices are locked here.

Two forks were locked before this ADR (recorded here, not re-litigated):

- **v1 grouping is BY REGISTRY KIND, not by author-declared "packs".** A slice in v1 is exactly one
  source's records of a single registry kind (`agent`/`skill`/`command`/`rule`/`hook`/`bundle`/
  `validator`/`mcp`/`meta-test`/`engine`). Author-declared, named "packs" (a source curating its own
  cross-kind bundles) are a documented FUTURE extension, deferred.
- **Subscriptions are OPT-IN.** A newly discovered slice defaults UNSUBSCRIBED; the operator must
  deliberately subscribe before its records enter the read-view. Library-local records belong to no
  slice and are ALWAYS in the read-view.

## Decision

### 1. A SLICE is a named group of ONE source's catalog records (v1: by kind)

- A **slice** groups the catalog records of a **single source** by a grouping key. In v1 the grouping
  key is the **registry kind**, so a slice is "all of source X's records of kind K".
- **Slice id** = `"<sourceId>/<kind>"` — the source id (`manifests/sources.json#sources[].id`) and the
  singular registry kind joined by a single **forward slash**. Resource uids already use the colon form
  `"<kind>:<id>"` (ADR-0005 / the registry record), so `/` is chosen deliberately to keep a slice id
  unambiguous against a resource uid.
- A slice's **display name** is the kind; its **count** is the number of that source's catalog records
  of that kind.
- Slices are **derived, not stored.** They are computed deterministically from the existing catalog
  records (the same record production ADR-0017's catalog operator already owns — `manager/slices.mjs`
  REUSES that seam and never re-scans). There is no slice manifest; the only persisted state is the
  per-project subscription set (§3).

### 2. Library-local records belong to NO slice and are ALWAYS visible

A catalog record whose `source` is `null` (an owned, in-tree LIBRARY artifact, ADR-0017 §1) is not part
of any source and so cannot be sliced or unsubscribed. Library-local records are ALWAYS in the catalog
read-view, independent of any subscription. Only SOURCE records (those carrying `source.sourceId`)
participate in slices.

### 3. Per-project subscriptions — `.forge/subscriptions.json` (`forge.subscriptions.v1`)

The set of slices a project opted into is **per-active-root project state**, persisted UNDER the active
root (not in the git-tracked library), validated by `schemas/subscriptions.schema.json`:

```jsonc
{
  "schema": "forge.subscriptions.v1",
  "version": 1,
  "subscribed": [
    "acme-skills/skill",                 // "<sourceId>/<kind>"
    "acme-skills/agent"
  ]
}
```

- A newly discovered slice defaults **UNSUBSCRIBED** (opt-in). The file lists only the slices a human
  deliberately subscribed; an absent or unlisted slice is unsubscribed.
- Reads/writes go through `manager/lib/store.mjs` (`readJson` / `writeJsonAtomic`). Writes are
  **ADDITIVE and never destructive**: `subscribe` adds one id (idempotent — a no-op if already present);
  `unsubscribe` removes one id (idempotent — a no-op if absent). Neither rewrites unrelated state, and
  the file is created on first `--apply` only.

### 4. The catalog READ-VIEW is library-local ∪ subscribed-slice records

The catalog read-view a project sees is, deterministically:

> **read-view = { records where source === null }  ∪  { records whose slice id ∈ subscribed }**

A source record is visible iff its slice id (`"<sourceId>/<kind>"`) is in the subscription set;
library-local records are always visible. This makes the read-view the project's deliberate choice and
keeps untrusted source content out until explicitly opted into — the read-view analogue of ADR-0017's
"syncing has zero activation side-effects".

### 5. CLI surface — the `slice` verb group (`manager/slices.mjs`)

A new verb group, mirroring the `source` operator idiom (dry-run by default, `--apply` to write,
C3-envelope output via `manager/lib/json-out.mjs`, findings via `manager/lib/findings.mjs`, fail-open at
the boundary):

- `forge slice list [--source <id>] [--json]` — derive slices by grouping the catalog records by
  source + kind, mark each `subscribed` from `.forge/subscriptions.json`, and return
  `data { subscriptionsPath, sources:[ { sourceId, slices:[ { id, kind, name, count, subscribed } ] } ] }`.
- `forge slice subscribe <sliceId> [--apply]` — add the id (idempotent); preview by default, write on
  `--apply`.
- `forge slice unsubscribe <sliceId> [--apply]` — remove the id (idempotent); preview by default, write
  on `--apply`.

`slices.mjs` exports `run(subcmd, args, ctx) -> { ok, data, findings, summary }` and is dispatched from
`bin/forge.mjs` via `delegateInherit` next to the existing `source` case (a `SLICE_VERBS` set + a
`sliceUsage()` banner). It REUSES the catalog operator's record production rather than reimplementing
any scanning.

## Consequences

**Positive**
- The catalog read-view becomes a deliberate, per-project choice; untrusted source content stays out
  until opted into — consistent with ADR-0017's untrusted-by-default stance.
- By-kind grouping is fully **deterministic collection** (no model call, no author trust required) — a
  slice is a pure function of the catalog records the operator already produces.
- Subscriptions are one small additive file with one schema; library-local records are unaffected
  (they belong to no slice and need no opt-in).
- The slice id `"<sourceId>/<kind>"` is unambiguous against resource uids (`"<kind>:<id>"`).

**Negative**
- A third per-concern on-disk shape now exists alongside the source manifest and the catalog
  (`subscriptions.json` is per-project state, distinct from the git-tracked library manifests).
- By-kind grouping cannot express an author's intended cross-kind grouping; that ergonomic gap is the
  motivation for the deferred "packs" extension.

**Neutral**
- Slices are derived, not persisted; only the subscription set is on disk, so there is no slice cache to
  garbage-collect or keep in sync.
- The read-view filter is a presentation/discovery concern — it does not change ADMISSION (ADR-0017): an
  unsubscribed slice's records are still admittable by uid; subscription only governs what the read-view
  surfaces.

## Alternatives considered

- **Author-declared "packs" as the v1 grouping** — rejected (LOCKED fork #1, deferred not killed):
  packs require trusting source-authored grouping metadata, which is untrusted content (ADR-0017 §5a)
  and would need its own validation/scan path. By-kind grouping is deterministic and trust-free, so v1
  ships it; packs become a documented future extension layered ON TOP of the same subscription store.
- **Subscriptions default ON (opt-out)** — rejected (LOCKED fork #2): defaulting to subscribed would
  surface untrusted source content into every project's read-view on registration, contradicting the
  untrusted-by-default stance ADR-0017 took for sources. Opt-in keeps the read-view a deliberate choice.
- **Per-resource subscription toggles** — rejected: toggling individual resources is poor ergonomics at
  scale and produces a large, churning subscription file; the slice is the right granularity for a
  read-view choice (individual resources are still selectable at ADMIT time).
- **Store subscriptions in the git-tracked library / a global file** — rejected: subscriptions are
  per-PROJECT state, so they live under the active root (mirrors `.forge/sources.lock` being
  project/machine state, not library state); a global file would leak one project's read-view choices
  into others.
- **A persisted slice manifest** — rejected: slices are reconstructable from the catalog records
  (the same reasoning ADR-0009/ADR-0017 used to reject duplicating reconstructable provenance); only the
  irreducible state (the subscription set) is persisted.

## Related

- ADR-0005 (contentHash is the sole identity primitive — slices group records that ADR-0005 identifies;
  resource uids `"<kind>:<id>"` motivate the `"/"` separator in slice ids)
- ADR-0009 (marker provenance via a single field — the precedent for persisting only irreducible,
  non-reconstructable state)
- ADR-0010 (opt-in machine-local cache — the opt-in / project-local-state precedent)
- ADR-0017 (federated catalog — sources, catalog-until-admitted, untrusted-by-default; slices group the
  catalog records it produces, and subscriptions extend its untrusted-by-default stance to the read-view)
- docs/specs/catalog.md §"Slices & subscriptions" + BR-CAT-004.. (the normative rules)
- schemas/subscriptions.schema.json (the `.forge/subscriptions.json` shape)
- manager/slices.mjs (the slice operator: list/subscribe/unsubscribe), manager/catalog.mjs (the catalog
  record production it reuses), manager/lib/store.mjs (atomic, additive persistence)
