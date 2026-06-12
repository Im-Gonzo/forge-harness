# ADR-0019: Per-project composition (the adopted set)

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (contract + skeleton this phase; conflicts, overlays/tailoring, and the lockfile are deferred to later slices)

## Context

ADR-0017 gave Forge a federated CATALOG (external repos as *sources*, synced into a discoverable
superset, ADMITTED into the active LIBRARY). ADR-0018 then added SLICES + per-project SUBSCRIPTIONS so a
project's catalog READ-VIEW is a deliberate choice — the union of every library-local record
(`source === null`) and every source record whose slice id `"<sourceId>/<kind>"` the project subscribed
to. Together those answer "where does a resource come from", "how is it safely activated", and "what does
THIS project SEE".

They leave one operator question open: **what does THIS project actually USE?** The read-view is the set
a project is willing to look at; it is not a statement of intent. A project still needs to record the
specific resources it has chosen FROM that read-view — its working set — separately from the global,
git-tracked LIBRARY that admission curates. Two pressures make this its own concern:

1. **Adopt is not admit.** Admission (ADR-0017 §3) is the one-way `catalog → library` gate: it runs the
   validate → security-scan → dedup → judge → test pipeline and the T2 human gates, and it promotes a
   record into the owned, in-tree LIBRARY for everyone. Choosing to USE an already-visible resource in
   ONE project is a far lighter, per-project act: no pipeline, no T2 gate, no library write. Folding the
   two together would either over-gate a trivial selection or under-gate a library promotion.

2. **The working set is per-project, not global.** Which resources a project leans on is project state,
   exactly like its subscriptions (ADR-0018 §3) and its `.forge/sources.lock` — it must not leak into the
   git-tracked library or into a sibling project.

We want a **COMPOSITION** abstraction: the per-active-root set of resources a project has ADOPTED from
its read-view. This is the seam later slices build on — conflicts (Slice 3), overlays/tailoring
(Slice 4), and the resolved lockfile (Slice 5) all attach to the composition — so the shape and the
guarantees are locked here.

Three forks were locked before this ADR (recorded here, not re-litigated):

- **Composition is ADDITIVE, beside admit/library — adopt ≠ admit.** Adopt records a per-project
  selection. It does NOT write the library, run the admission pipeline, or touch the T2 gate. The
  existing `catalog admit → library` path is UNCHANGED.
- **Adoptability is gated by the READ-VIEW.** A resource is adoptable ONLY if it is in the project's
  ADR-0018 read-view (library-local, or a record whose slice the project subscribed to). Adopt reuses,
  and never widens, that gate.
- **An adopted entry is keyed by `(uid, sourceId)`.** A resource can be visible from more than one place
  — the library-local copy (`sourceId === null`) and/or one or more subscribed sources — so the pair, not
  the bare uid, identifies an adoption.

## Decision

### 1. A COMPOSITION is the per-project set of ADOPTED resources

- A project's **composition** is the set of resources it has ADOPTED from its read-view — its declared
  working set, distinct from the global LIBRARY.
- An **adopted entry** is the pair `(uid, sourceId)` where `uid` is the resource uid `"<kind>:<id>"`
  (ADR-0005) and `sourceId` is the source id it was adopted from, or **`null`** for the library-local
  copy. The pair (not the bare uid) is the identity, so the same uid adopted from the library and from a
  source are two distinct entries — the seam Slice 3 needs to surface a conflict.
- The composition is **per-active-root project state**, persisted UNDER the active root (not in the
  git-tracked library), exactly as subscriptions are (ADR-0018 §3).

### 2. Adoptability is gated by the catalog READ-VIEW

A resource is adoptable iff it is in the project's ADR-0018 read-view:

> **read-view = { records where source === null }  ∪  { records whose slice id ∈ subscribed }**

`compose adopt` reuses that gate verbatim — it asks the catalog operator's record production for the
records, filters to the read-view (the same union `slice list` computes), and refuses to adopt anything
outside it. Adopt therefore never widens the read-view: a record from an unsubscribed slice is not
adoptable until its slice is subscribed (ADR-0018 §4), and admission is irrelevant to adoptability (a
resource need not be admitted to be adopted, and admitting one does not adopt it).

When a uid resolves ONLY from a source (no library-local copy) and `--source` is omitted, adopt is
AMBIGUOUS and ERRORS asking for `--source <id>`; it never guesses. When `--source` is omitted and a
library-local copy exists, the entry is the library-local one (`sourceId === null`).

### 3. Adopt is ADDITIVE and independent of admission — adopt ≠ admit

- `compose adopt` records `{ uid, sourceId }` in the composition. It does NOT run the admission pipeline
  (validate → security-scan → dedup → judge → test), does NOT consult the T2 gate, and does NOT write the
  library. The `catalog admit → library` path is UNCHANGED and remains the only way a record becomes an
  owned, in-tree LIBRARY artifact.
- Identity stays `contentHash` (ADR-0005); provenance stays the minimal `source` object (ADR-0009). The
  composition references resources by `(uid, sourceId)`; it copies no bytes and duplicates no provenance.

### 4. Per-project composition — `.forge/composition.json` (`forge.composition.v1`)

The adopted set is persisted under the active root, validated by `schemas/composition.schema.json`:

```jsonc
{
  "schema": "forge.composition.v1",
  "version": 1,
  "adopted": [
    { "uid": "skill:run-eval", "sourceId": null },        // the library-local copy
    { "uid": "agent:reviewer", "sourceId": "acme-skills" } // adopted from a subscribed source
  ]
}
```

- Reads/writes go through `manager/lib/store.mjs` (`readJson` / `writeJsonAtomic`). Writes are
  **ADDITIVE and never destructive**: `adopt` adds one `(uid, sourceId)` entry (idempotent — a no-op if
  already present); `remove` drops the matching entry (idempotent — a no-op if absent). Neither rewrites
  unrelated state, and the file is created on first `--apply` only.
- A newly visible resource defaults **UNADOPTED** (opt-in), exactly as a newly discovered slice defaults
  unsubscribed (ADR-0018 §3).

### 5. Orphaned entries are REPORTED, never silently deleted

`compose list` JOINS each adopted entry back to its catalog record (reusing the same record production
`slice list` uses) to resolve its `kind`, `version`, and `criticality`. An entry whose resource is no
longer in the read-view — its slice was unsubscribed, or the record vanished — is an **orphan**: it is
surfaced as a WARN finding and DROPPED from the listed set, but it is **NOT removed** from
`composition.json`. Removal is always an explicit `compose remove`, so an accidental unsubscribe (or a
transient empty catalog) never silently discards a deliberate adoption.

### 6. CLI surface — the `compose` verb group (`manager/compose.mjs`)

A new verb group, mirroring the `slice` operator idiom (dry-run by default, `--apply` to write,
C3-envelope output via `manager/lib/json-out.mjs`, findings via `manager/lib/findings.mjs`, fail-open at
the boundary):

- `forge compose list [--json]` → JOIN the adopted set to its catalog records and return
  `data { compositionPath, adopted:[ { uid, kind, sourceId, version, criticality } ], counts:{ adopted, sources } }`.
  Sorted deterministically (by uid, then sourceId). Orphans are reported (§5), never deleted.
- `forge compose adopt <uid> [--source <id>] [--apply]` — validate read-view membership (§2), record
  `{ uid, sourceId }` (idempotent). Preview by default, write on `--apply`.
- `forge compose remove <uid> [--source <id>] [--apply]` — remove the matching entry (idempotent — absent
  is a no-op). Preview by default, write on `--apply`.

`compose.mjs` exports `run(subcmd, args, ctx) -> { ok, data, findings, summary }` and is dispatched from
`bin/forge.mjs` via the same idiom as `slice` (a `COMPOSE_VERBS` set + a `composeUsage()` banner). It
REUSES the catalog operator's record production rather than reimplementing any scanning or read-view
logic.

### 7. Seams left for later slices (NOT built now)

The composition is the attach point for the rest of the project-side flow; this ADR leaves clean,
unbuilt seams:

- **Slice 3 — conflicts.** The `(uid, sourceId)` key means the same uid can be adopted from two places;
  Slice 3 detects that and the composition health flips from "resolved / in sync" to a blocked state.
  v0.7 has no conflict detection — the health is always OK.
- **Slice 4 — overlays / tailoring.** Per-project tailoring of an adopted resource layers ON TOP of an
  entry; the entry shape reserves room for it without defining it now.
- **Slice 5 — the lockfile.** A resolved, pinned composition (the project analogue of
  `.forge/sources.lock`) is derived FROM the adopted set; the composition is its input, not its
  replacement.

## Consequences

**Positive**
- A project's working set is a deliberate, per-project choice recorded separately from the global
  library — the project analogue of ADR-0018's per-project subscriptions.
- Adopt is cheap and reversible: no pipeline, no T2 gate, no library write — so selecting a resource to
  use is decoupled from the heavyweight act of promoting it into the owned library.
- Reusing the read-view gate keeps one source of truth for visibility: a project can only adopt what it
  can already see, and admission stays orthogonal.
- Orphans-reported-not-deleted makes the file safe against an accidental unsubscribe or a transient empty
  catalog; deliberate removal is the only way an entry leaves the file.
- The `(uid, sourceId)` key and the additive single-file shape leave clean seams for conflicts, overlays,
  and the lockfile without committing to their shapes now.

**Negative**
- A fourth per-concern on-disk shape now exists alongside the source manifest, the lockfile, and the
  subscription set (`composition.json` is per-project state, distinct from the git-tracked library
  manifests).
- An adopted entry can be orphaned by an unsubscribe; the project must `compose remove` it to clean the
  file (the cost of never silently deleting a deliberate choice).

**Neutral**
- The composition references resources by `(uid, sourceId)`; it persists no bytes and no derived
  metadata (kind/version/criticality are JOINED at list time from the catalog records), so there is no
  composition cache to keep in sync — the same reasoning ADR-0018 used for derived slices.
- Adoption is a presentation/intent concern — it does not change ADMISSION (ADR-0017) or the read-view
  (ADR-0018): an adopted resource is still inert until admitted, and adopting one neither subscribes a
  slice nor admits a record.

## Alternatives considered

- **Make adopt a form of admit (one gate)** — rejected (LOCKED fork: adopt ≠ admit): admission is a
  global, irreversible, pipeline-gated library promotion; per-project selection is a light, reversible,
  per-project act. Folding them either over-gates a trivial selection or under-gates a library write, and
  it would let a single project's choice mutate the shared library. Keeping them separate preserves
  ADR-0017's catalog-vs-library model and adds the missing "what does THIS project use" layer beside it.
- **Gate adoptability on admission instead of the read-view** — rejected: an admitted record is global
  library state, not a per-project choice; gating adoption on it would force a global write to express a
  local intent and would make the read-view (ADR-0018) irrelevant to what a project can use. The
  read-view is exactly the "what can this project see" gate, so it is the right gate for "what can this
  project use".
- **Key an adopted entry by the bare uid** — rejected (LOCKED fork: key is `(uid, sourceId)`): a uid can
  be visible from the library-local copy AND one or more sources, so the bare uid cannot distinguish
  which copy was adopted and could not express the duplicate-adoption case Slice 3 must detect. The
  `(uid, sourceId)` pair is the minimal key that stays unambiguous.
- **Auto-prune orphaned entries on list** — rejected: an entry can be orphaned by a transient empty
  catalog or an accidental unsubscribe; silently deleting it would discard a deliberate adoption on a
  reversible condition. Reporting (WARN) + dropping from the listed view, while leaving the file intact
  until an explicit `compose remove`, is the additive-never-destructive contract ADR-0018 set.
- **Store the composition in the git-tracked library / a global file** — rejected: the working set is
  per-PROJECT state, so it lives under the active root (mirrors `.forge/subscriptions.json` and
  `.forge/sources.lock`); a global file would leak one project's choices into another.

## Related

- ADR-0005 (contentHash is the sole identity primitive — adopted entries reference uids `"<kind>:<id>"`
  that ADR-0005 defines; adoption copies no bytes and changes no identity)
- ADR-0009 (marker provenance via a single minimal field — adoption references the minimal `source`
  provenance, never duplicating it; the precedent for persisting only irreducible state)
- ADR-0010 (opt-in machine-local cache — the opt-in / project-local-state precedent)
- ADR-0017 (federated catalog — sources, catalog-until-admitted, the one-way admit gate; adopt is
  ADDITIVE beside that path and never runs the admission pipeline or T2 gate)
- ADR-0018 (slices + per-project subscriptions — the read-view that gates adoptability; composition is
  the per-project intent layer built on top of that per-project visibility layer)
- docs/specs/catalog.md §"Composition & adoption" + BR-CAT-007.. (the normative rules)
- schemas/composition.schema.json (the `.forge/composition.json` shape)
- manager/compose.mjs (the composition operator: list/adopt/remove), manager/slices.mjs (the read-view
  derivation it reuses), manager/catalog.mjs (the catalog record production both reuse),
  manager/lib/store.mjs (atomic, additive persistence)
