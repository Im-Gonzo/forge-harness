# ADR-0019: Per-project composition (the adopted set)

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (contract + skeleton this phase; conflicts, overlays/tailoring, and the lockfile are deferred to later slices)

> **Release-facing copy.** This is the composition/adoption decision as cited by the shipped harness
> assets and the `compose` CLI verb group (`manager/compose.mjs`). The full design-stage record —
> alternatives considered, locked forks, and the manager corpus cross-references — lives in
> [docs/manager/adr/ADR-0019-project-composition.md](../manager/adr/ADR-0019-project-composition.md).
> The companion SPEC section is [docs/specs/catalog.md](../specs/catalog.md) §"Composition & adoption".

## Context

ADR-0017 gave Forge a federated CATALOG (sources, synced into a discoverable superset, ADMITTED into the
active LIBRARY). ADR-0018 added SLICES + per-project SUBSCRIPTIONS so a project's catalog READ-VIEW is a
deliberate choice (library-local records ∪ subscribed-slice records). Together they answer "where does a
resource come from", "how is it safely activated", and "what does THIS project SEE". They leave open:
**what does THIS project actually USE?** A project needs to record the resources it has chosen FROM its
read-view — its working set — separately from the global, git-tracked LIBRARY that admission curates.

We want a **COMPOSITION**: the per-active-root set of resources a project has ADOPTED from its read-view.
This is the seam later slices build on (conflicts, overlays/tailoring, the lockfile), so the shape and
guarantees are locked here.

Three forks were locked before this ADR:

- **Composition is ADDITIVE, beside admit/library — adopt ≠ admit.** Adopt records a per-project
  selection; it does NOT write the library, run the admission pipeline, or touch the T2 gate. The
  `catalog admit → library` path is UNCHANGED.
- **Adoptability is gated by the READ-VIEW.** A resource is adoptable ONLY if it is in the project's
  ADR-0018 read-view. Adopt reuses, and never widens, that gate.
- **An adopted entry is keyed by `(uid, sourceId)`.** A uid can be visible from the library-local copy
  (`sourceId === null`) and/or one or more subscribed sources, so the pair — not the bare uid —
  identifies an adoption.

## Decision

### 1. A COMPOSITION is the per-project set of ADOPTED resources

A project's composition is the set of resources it has ADOPTED from its read-view — its declared working
set, distinct from the global LIBRARY. An **adopted entry** is the pair `(uid, sourceId)`, where `uid` is
the resource uid `"<kind>:<id>"` (ADR-0005) and `sourceId` is the source id it was adopted from, or
**`null`** for the library-local copy. The pair (not the bare uid) is the identity. The composition is
per-active-root state under the active root (not the git-tracked library), exactly as subscriptions are
(ADR-0018 §3).

### 2. Adoptability is gated by the catalog READ-VIEW

A resource is adoptable iff it is in the project's ADR-0018 read-view:

> **read-view = { records where source === null }  ∪  { records whose slice id ∈ subscribed }**

`compose adopt` reuses that gate verbatim and refuses anything outside it — a record from an unsubscribed
slice is not adoptable until its slice is subscribed, and admission is irrelevant to adoptability. When a
uid resolves ONLY from a source and `--source` is omitted, adopt is AMBIGUOUS and ERRORS asking for
`--source <id>`; when `--source` is omitted and a library-local copy exists, the entry is the
library-local one (`sourceId === null`).

### 3. Adopt is ADDITIVE and independent of admission — adopt ≠ admit

`compose adopt` records `{ uid, sourceId }` in the composition. It does NOT run the admission pipeline,
consult the T2 gate, or write the library. The `catalog admit → library` path is UNCHANGED and remains
the only way a record becomes an owned, in-tree LIBRARY artifact. Identity stays `contentHash`
(ADR-0005); provenance stays the minimal `source` object (ADR-0009) — the composition references
resources by `(uid, sourceId)`, copying no bytes.

### 4. Per-project composition — `.forge/composition.json` (`forge.composition.v1`)

The adopted set is persisted under the active root, validated by `schemas/composition.schema.json`:

```jsonc
{
  "schema": "forge.composition.v1",
  "version": 1,
  "adopted": [
    { "uid": "skill:run-eval", "sourceId": null },
    { "uid": "agent:reviewer", "sourceId": "acme-skills" }
  ]
}
```

Reads/writes go through `manager/lib/store.mjs` (`readJson` / `writeJsonAtomic`) and are **ADDITIVE and
never destructive**: `adopt` adds one entry (idempotent), `remove` drops the matching entry (idempotent);
neither rewrites unrelated state, and the file is created on first `--apply`. A newly visible resource
defaults **UNADOPTED** (opt-in).

### 5. Orphaned entries are REPORTED, never silently deleted

`compose list` JOINS each adopted entry to its catalog record to resolve `kind`/`version`/`criticality`.
An entry whose resource is no longer in the read-view (its slice was unsubscribed, or the record vanished)
is an **orphan**: surfaced as a WARN finding and dropped from the listed set, but **NOT removed** from
`composition.json`. Removal is always an explicit `compose remove`.

### 6. CLI surface — the `compose` verb group (`manager/compose.mjs`)

Mirrors the `slice` operator idiom (dry-run by default, `--apply` to write, C3-envelope output, findings,
fail-open):

- `forge compose list [--json]` →
  `data { compositionPath, adopted:[ { uid, kind, sourceId, version, criticality } ], counts:{ adopted, sources } }`.
  Sorted deterministically (by uid, then sourceId); orphans reported, never deleted.
- `forge compose adopt <uid> [--source <id>] [--apply]` — validate read-view membership, record
  `{ uid, sourceId }` (idempotent), preview by default.
- `forge compose remove <uid> [--source <id>] [--apply]` — remove the matching entry (idempotent),
  preview by default.

It REUSES the catalog operator's record production rather than reimplementing scanning or read-view logic.

## Consequences

- A project's working set is a deliberate, per-project choice recorded separately from the global library
  — the project analogue of ADR-0018's per-project subscriptions.
- Adopt is cheap and reversible (no pipeline, no T2 gate, no library write), decoupling "use this
  resource" from the heavyweight act of promoting it into the owned library.
- Reusing the read-view gate keeps one source of truth for visibility; admission stays orthogonal.
- Orphans-reported-not-deleted makes the file safe against an accidental unsubscribe or a transient empty
  catalog; deliberate removal is the only way an entry leaves the file.
- Adoption does NOT change ADMISSION (ADR-0017) or the read-view (ADR-0018): an adopted resource is still
  inert until admitted, and adopting one neither subscribes a slice nor admits a record.
- The `(uid, sourceId)` key and additive single-file shape leave clean seams for conflicts (Slice 3),
  overlays/tailoring (Slice 4), and the lockfile (Slice 5) without committing to their shapes now.

## Related

- [docs/manager/adr/ADR-0019-project-composition.md](../manager/adr/ADR-0019-project-composition.md)
  — the full design-stage record (alternatives, locked forks, manager corpus xrefs).
- [docs/adr/ADR-0017-federated-catalog.md](./ADR-0017-federated-catalog.md) — the federated catalog and
  the one-way admit gate this builds beside.
- [docs/adr/ADR-0018-slices-and-subscriptions.md](./ADR-0018-slices-and-subscriptions.md) — the read-view
  that gates adoptability.
- [docs/specs/catalog.md](../specs/catalog.md) §"Composition & adoption" + BR-CAT-007.. — the normative
  rules.
- `schemas/composition.schema.json` — the `.forge/composition.json` shape.
- `manager/compose.mjs` (composition operator), `manager/slices.mjs` (read-view derivation it reuses),
  `manager/catalog.mjs` (catalog record production both reuse), `manager/lib/store.mjs` (atomic, additive
  persistence).
