# ADR-0018: Catalog slices and per-project subscriptions

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (contract + skeleton this phase; named "packs" a documented FUTURE extension)

> **Release-facing copy.** This is the slices/subscriptions decision as cited by the shipped harness
> assets and the `slice` CLI verb group (`manager/slices.mjs`). The full design-stage record —
> alternatives considered, locked forks, and the manager corpus cross-references — lives in
> [docs/manager/adr/ADR-0018-slices-and-subscriptions.md](../manager/adr/ADR-0018-slices-and-subscriptions.md).
> The companion SPEC section is [docs/specs/catalog.md](../specs/catalog.md) §"Slices & subscriptions".

## Context

ADR-0017 gave Forge a federated CATALOG (external repos as *sources*, synced into a discoverable
superset, admitted into the active LIBRARY). It left two operator questions open: how to browse a
source's contribution at a useful granularity, and what THIS project actually wants to see. As sources
multiply, an undifferentiated "everything discoverable" read-view becomes noise and silently surfaces
UNTRUSTED source content into a project's working set — at odds with ADR-0017's untrusted-by-default
stance. We want a **SLICE** (a named group of one source's catalog records) plus a **per-project
SUBSCRIPTION** state, so the catalog read-view is the project's deliberate choice.

Two forks were locked before this ADR:

- **v1 grouping is BY REGISTRY KIND, not author-declared "packs".** A v1 slice is one source's records
  of a single registry kind. Author-declared cross-kind "packs" are a documented FUTURE extension.
- **Subscriptions are OPT-IN.** A newly discovered slice defaults UNSUBSCRIBED. Library-local records
  belong to no slice and are ALWAYS in the read-view.

## Decision

### 1. A SLICE is one source's catalog records, grouped (v1: by kind)

A slice groups a single source's catalog records by kind. **Slice id** = `"<sourceId>/<kind>"` — the
source id (`manifests/sources.json#sources[].id`) and the singular registry kind joined by a forward
slash. (Resource uids use the colon form `"<kind>:<id>"`, ADR-0005, so `/` keeps a slice id
unambiguous against a uid.) A slice's display name is the kind; its count is the number of that source's
catalog records of that kind. Slices are **derived, not stored** — computed deterministically from the
catalog records the operator already produces (`manager/slices.mjs` reuses that seam; there is no slice
manifest).

### 2. Library-local records belong to NO slice and are ALWAYS visible

A catalog record whose `source` is `null` (an owned in-tree LIBRARY artifact) is in no slice and cannot
be unsubscribed — it is ALWAYS in the read-view. Only SOURCE records (carrying `source.sourceId`)
participate in slices.

### 3. Per-project subscriptions — `.forge/subscriptions.json` (`forge.subscriptions.v1`)

The slices a project opted into are per-active-root state under the active root, validated by
`schemas/subscriptions.schema.json`:

```jsonc
{ "schema": "forge.subscriptions.v1", "version": 1, "subscribed": ["acme-skills/skill", "acme-skills/agent"] }
```

A newly discovered slice defaults **UNSUBSCRIBED** (opt-in). Reads/writes go through
`manager/lib/store.mjs` (`readJson` / `writeJsonAtomic`) and are **ADDITIVE and never destructive**:
`subscribe` adds one id (idempotent), `unsubscribe` removes one id (idempotent); neither rewrites
unrelated state, and the file is created on first `--apply`.

### 4. The catalog READ-VIEW is library-local ∪ subscribed-slice records

> **read-view = { records where source === null }  ∪  { records whose slice id ∈ subscribed }**

A source record is visible iff its slice id is in the subscription set; library-local records are always
visible. This keeps untrusted source content out of the read-view until explicitly opted into — the
read-view analogue of ADR-0017's "syncing has zero activation side-effects".

### 5. CLI surface — the `slice` verb group (`manager/slices.mjs`)

Mirrors the `source` operator idiom (dry-run by default, `--apply` to write, C3-envelope output,
findings, fail-open):

- `forge slice list [--source <id>] [--json]` →
  `data { subscriptionsPath, sources:[ { sourceId, slices:[ { id, kind, name, count, subscribed } ] } ] }`.
- `forge slice subscribe <sliceId> [--apply]` — add the id (idempotent), preview by default.
- `forge slice unsubscribe <sliceId> [--apply]` — remove the id (idempotent), preview by default.

It REUSES the catalog operator's record production rather than reimplementing scanning.

## Consequences

- The read-view becomes a deliberate per-project choice; untrusted source content stays out until opted
  into — consistent with ADR-0017's untrusted-by-default stance.
- By-kind grouping is fully deterministic (no model call, no author trust required).
- One small additive file with one schema; library-local records are unaffected.
- By-kind grouping cannot express an author's intended cross-kind grouping — the gap the deferred
  "packs" extension addresses.
- Subscription governs the read-view only; it does NOT change ADMISSION (ADR-0017) — an unsubscribed
  slice's records remain admittable by uid.

## Related

- [docs/manager/adr/ADR-0018-slices-and-subscriptions.md](../manager/adr/ADR-0018-slices-and-subscriptions.md)
  — the full design-stage record (alternatives, locked forks, manager corpus xrefs).
- [docs/adr/ADR-0017-federated-catalog.md](./ADR-0017-federated-catalog.md) — the federated catalog this
  builds on (sources, catalog-until-admitted, untrusted-by-default).
- [docs/specs/catalog.md](../specs/catalog.md) §"Slices & subscriptions" + BR-CAT-004.. — the normative
  rules.
- `schemas/subscriptions.schema.json` — the `.forge/subscriptions.json` shape.
- `manager/slices.mjs` (slice operator), `manager/catalog.mjs` (catalog record production it reuses),
  `manager/lib/store.mjs` (atomic, additive persistence).
