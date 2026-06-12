# ADR-0021: Tailoring overlays (per-adopted-resource modifiers)

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (Slice 4 — records per-adopted-resource overlays as INTENTIONS + a deterministic resolved preview; application is deferred to Slice 5 compose --write)

## Context

ADR-0017 gave Forge a federated CATALOG (external repos as *sources*, synced into a discoverable superset,
ADMITTED into the owned LIBRARY). ADR-0018 added SLICES + per-project SUBSCRIPTIONS (the read-view).
ADR-0019 added the per-project COMPOSITION — the adopted set keyed by `(uid, sourceId)` — answering "what
does THIS project USE". ADR-0020 surfaced project-level CONFLICTS (a read-view uid with >= 2 distinct
candidates) and the adjudication policy + human choices. Together those answer where a resource comes from,
what a project sees, what it uses, and which copy wins when a uid is ambiguous.

They leave one operator question open: **how does THIS project bend an adopted resource to fit, without
forking it or mutating the shared library?** A project routinely wants to pin a known-good version, flip a
frontmatter field (`model → opus`, `criticality → safety`), layer a small project-specific fragment on top
of a rule, gate a skill to a path glob, detach a body for local edits, or simply turn a resource off — all
WITHOUT promoting a new library record and without editing real `.claude/` files until it is ready. ADR-0019
§7 named this exact seam: "Per-project tailoring of an adopted resource layers ON TOP of an entry; the entry
shape reserves room for it without defining it now." This ADR defines it.

Two pressures shape the design, and both are inherited constraints, not new choices:

- **Tailoring is per-PROJECT intent over an ADOPTED resource — not a library change.** Like subscriptions
  (ADR-0018) and the composition (ADR-0019), what a project tailors is per-active-root state that must not
  leak into the git-tracked library or a sibling project. A tailored override of `model → opus` in one
  project must not rewrite the library record everyone else reads.
- **Recording an intention is NOT applying it.** Slice 4 records overlays and computes a deterministic
  RESOLVED PREVIEW — a VIEW. Materializing those overlays into the real `.claude/` tree (writing the
  pinned version, the overridden frontmatter, the layered fragment) is the Slice 5 `compose --write`
  territory, where application is gated and reconciled against what is already on disk. Folding the two
  together would either put a half-built writer on the hot path now or smear preview and apply into one
  irreversible step. Preview-by-default is the same contract the whole stack uses.

Three forks were locked before this ADR (recorded here, not re-litigated):

- **Tailoring is a SEPARATE additive store — it does NOT modify the composition's schema.** Overlays live
  in their own `.forge/tailoring.json` (`forge.tailoring.v1`), beside `.forge/composition.json`, keyed by
  the SAME `(uid, sourceId)` identity. ADR-0019's composition schema is UNCHANGED; tailoring attaches to it
  by key, it does not extend it.
- **Only an ADOPTED resource may be tailored.** A tailored entry's `(uid, sourceId)` MUST be present in the
  composition; the operator validates against `.forge/composition.json` (reusing the `manager/compose.mjs`
  read helpers) and never widens that gate. You cannot tailor what you have not adopted.
- **Overlays are RECORDED INTENTIONS; the resolved preview is a VIEW, never a write.** The CLI folds the
  overlays over the base catalog record to compute a deterministic resolved preview, and that is all it does
  in Slice 4. It never mutates the library or any file outside the tailoring store. Application is Slice 5.

## Decision

### 1. A TAILORING OVERLAY is a per-adopted-resource modifier

A **tailoring overlay** is a single `{ type, detail }` modifier recorded against an ADOPTED resource. The
overlay `type` is drawn from a closed set, each with a short, type-specific `detail` string (prototype
`OVERLAY_META`, `forge-design/prototype/forge-harness/project/proto-data.js`):

| `type`     | `detail` meaning                                   | example                       |
| ---------- | -------------------------------------------------- | ----------------------------- |
| `pin`      | a version to lock to                               | `"v3.2.0"`                    |
| `override` | a frontmatter field change, `"field → value"`      | `"model → opus"`              |
| `layer`    | a fragment layered on top of the body              | `"+ project rule fragment"`   |
| `gate`     | a conditional activation (e.g. a path glob)        | `"paths: src/**"`             |
| `fork`     | the body detached for local edits (detail optional)| `"body detached"` / `""`      |
| `disable`  | the resource is turned off (detail optional)       | `""`                          |

A resource MAY carry MULTIPLE overlays (e.g. a `pin` + an `override` + a `gate`). `detail` is required for
`pin`/`override`/`layer`/`gate`; it is OPTIONAL (MAY be `""`) for `fork`/`disable`.

### 2. Idempotent dedupe per overlay type

Adding overlays is idempotent under a per-type rule that keeps the store small and unambiguous:

- **`pin` / `override` / `disable` / `fork` keep at most ONE per type.** Adding a second overlay of that
  type REPLACES the prior one's `detail` (the latest detail per type wins). A resource has one pin, one
  override slot, one disable, one fork — not a stack of them.
- **`layer` / `gate` MAY repeat**, deduped by the pair `(type, detail)`. Two layers with different fragments
  coexist; adding the same `(layer, detail)` twice is a no-op.

`remove` drops the matching overlay(s) by `type`, optionally narrowed by `detail`; absent is a no-op. Both
`add` and `remove` are idempotent.

### 3. The RESOLVED PREVIEW is a deterministic, display-only VIEW

`resolved` is computed by FOLDING the overlays over the base catalog record (the same record production
`compose list` joins). It is a VIEW — never written to the library or any `.claude/` file. Its shape:

```jsonc
{ "model": "...", "residency": "...", "activation": "...", "body": "...", "status": "...", "version": "..." }
```

The folding rules are simple and documented:

| overlay      | fold                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `pin`        | `version` = the pin detail                                                    |
| `override`   | parse `"field → value"`; set that field (e.g. `model = "opus"`)               |
| `gate`       | `activation` = the gate detail (else `"default"`)                             |
| `fork`       | `body` = `"forked · local edits"`                                             |
| `layer`      | `body` = `"source + project layer"`                                           |
| `disable`    | `status` = `"disabled"`                                                       |
| _(none)_     | the field tracks its source (the base record value)                           |

An **unknown or unparseable** detail (e.g. an `override` with no `→`) LEAVES the base value and adds an
**INFO** finding — it never errors, never guesses, and never fabricates a resolved value. The preview is a
pure function of the base record + the overlays, so it is deterministic and needs no cache.

### 4. Tailorability is gated by the COMPOSITION (only adopted resources)

A resource is tailorable iff its `(uid, sourceId)` is ADOPTED — present in `.forge/composition.json`
(ADR-0019). `forge tailor add` validates membership by REUSING the `manager/compose.mjs` read helpers; it
never widens the gate and never adopts as a side effect (tailor ≠ adopt, just as adopt ≠ admit). An overlay
recorded for a `(uid, sourceId)` that is no longer adopted (an ORPHAN — the resource was `compose remove`d
or unsubscribed) is REPORTED as a WARN and dropped from the listed set, but is NEVER deleted from disk —
the same orphans-reported-not-deleted contract ADR-0019 §5 set for the composition. Removal is always an
explicit `forge tailor remove`.

### 5. Per-project tailoring — `.forge/tailoring.json` (`forge.tailoring.v1`)

The overlays are persisted under the active root, validated by `schemas/tailoring.schema.json` (mirroring
the `composition.json` idiom of ADR-0019 §4), a SEPARATE additive store beside `composition.json`:

```jsonc
{
  "schema": "forge.tailoring.v1",
  "version": 1,
  "tailored": [
    {
      "uid": "skill:code-review",
      "sourceId": "acme-skills",
      "overlays": [
        { "type": "pin", "detail": "v3.2.0" },
        { "type": "override", "detail": "model → opus" },
        { "type": "gate", "detail": "paths: src/**" }
      ]
    },
    { "uid": "rule:no-secrets", "sourceId": "acme-internal",
      "overlays": [ { "type": "layer", "detail": "+ acme PII addendum" } ] }
  ]
}
```

Only the `(uid, sourceId)` key and its overlays are stored; the resolved preview is DERIVED (§3), never
persisted. Reads/writes go through `manager/lib/store.mjs` (`readJson` / `writeJsonAtomic`) and are
**ADDITIVE and never destructive**: `add` records/replaces one overlay (§2); `remove` drops matching
overlays; neither rewrites unrelated state, and the file is created on first `--apply`. Preview by default,
write on `--apply`, fail-open at the boundary — the same contract ADR-0018/0019/0020 set. The composition
schema is UNCHANGED.

### 6. CLI surface — the `tailor` verb group (`manager/tailor.mjs`)

A new verb group mirroring the `compose`/`conflict` operator idiom (dry-run by default, `--apply` to write,
C3-envelope output via `manager/lib/json-out.mjs`, findings via `manager/lib/findings.mjs`, fail-open at the
boundary). Module contract: `run(subcmd, args, ctx) -> { ok, data, findings, summary }`, dispatched from
`bin/forge.mjs` via a `TAILOR_VERBS` set + a `tailorUsage()` banner next to `CONFLICT_VERBS`.

- `forge tailor list [--json]` → `data { tailoringPath, tailored:[ { uid, sourceId, kind,
  overlays:[{type,detail}], resolved:{...} } ], counts:{ tailored, overlays } }`. JOINS each tailored entry
  to its catalog record (REUSING `manager/catalog.mjs` as `compose`/`conflict` do) for `kind` + the base
  values, computes the resolved preview (§3), and drops entries whose resource is no longer adopted (WARN,
  retained on disk, §4).
- `forge tailor add <uid> --type <t> --detail <s> [--source <id>] [--apply]` → validate the resource is
  ADOPTED (§4) and `type` is valid; record the overlay with the per-type dedupe rule (§2). `--detail` is
  optional for `fork`/`disable`. Preview by default, write on `--apply`.
- `forge tailor remove <uid> --type <t> [--detail <s>] [--source <id>] [--apply]` → remove matching
  overlay(s) by `type`, optionally narrowed by `detail`. Idempotent (absent is a no-op).

It REUSES the catalog record production and the composition read helpers; it reimplements no scanning,
read-view, dedup, adoption, or conflict logic, and it invokes NO model.

### 7. Seams left / not built now

- **Slice 5 — application (`compose --write`).** The resolved preview is the input to materializing the
  overlays into the real `.claude/` tree (writing the pinned version, the overridden frontmatter, the
  layered fragment, the fork). Slice 4 records the intention and previews it; Slice 5 applies it, reconciled
  against what is on disk. Nothing here writes outside `.forge/tailoring.json`.
- **The lockfile.** A resolved + pinned composition (the project analogue of `.forge/sources.lock`) consumes
  the tailoring overlays alongside the adopted set and the resolved conflicts; the tailoring store is one of
  its inputs, not its replacement.

## Consequences

**Positive**
- A project can bend an adopted resource to fit — pin, override, layer, gate, fork, disable — without
  forking the library or editing real `.claude/` files, recorded as per-project intent (the project analogue
  of ADR-0019's per-project adoption and ADR-0020's per-project choices).
- Keeping tailoring a SEPARATE additive store means ADR-0019's composition schema is untouched and the two
  concerns evolve independently; tailoring attaches by `(uid, sourceId)` rather than extending the adopted
  entry.
- Preview-by-default keeps the irreversible/disk-touching half (application) deferred to Slice 5 behind a
  deliberate gate; recording an overlay is cheap and reversible.
- The resolved preview is a pure function of the base record + overlays, so there is no preview cache to
  keep in sync (the same reasoning ADR-0018 used for derived slices, ADR-0019 for the derived composition
  join, and ADR-0020 for the derived conflict set).
- Unknown/unparseable detail yields an INFO finding and leaves the base value, so the preview never overstates
  or fabricates a resolved value — the same do-not-fabricate discipline ADR-0020 used for `suggested`/scores.

**Negative**
- A sixth per-project on-disk shape now exists (`tailoring.json`) alongside the source manifest, the
  lockfile, the subscription set, the composition, and the adjudication store.
- An overlay can be orphaned by a `compose remove`/unsubscribe; the project must `tailor remove` it to clean
  the file (the cost of never silently deleting a deliberate overlay).
- The resolved preview is a SIMPLIFIED view (e.g. `layer` renders `"source + project layer"` rather than the
  composed body); the real composition happens at apply time (Slice 5), so the preview is indicative, not the
  byte-exact result.

**Neutral**
- Tailoring is a presentation/intent concern over the composition; it does NOT change ADMISSION (ADR-0017),
  the read-view (ADR-0018), the composition (ADR-0019), conflict adjudication (ADR-0020), dedup, or the
  judge — those are untouched. Identity stays `contentHash` (ADR-0005); provenance stays the minimal
  `source` object (ADR-0009); tailoring copies no bytes and duplicates no provenance.

## Alternatives considered

- **Add an `overlays` field to the composition's adopted entry (one store).** Rejected (LOCKED fork:
  separate additive store): it would change ADR-0019's `composition.json` schema, couple two concerns that
  evolve at different rates, and force every composition reader to understand overlays. A separate
  `tailoring.json` keyed by the SAME `(uid, sourceId)` attaches tailoring to the composition without
  extending it — the same separation ADR-0020 used for `adjudication.json`.
- **Apply overlays to the real `.claude/` files at `tailor add` time.** Rejected (LOCKED fork: recorded
  intention + preview, application deferred to Slice 5): writing the pinned version / overridden frontmatter
  / layered fragment is an irreversible, on-disk, reconciliation-heavy step that belongs in a gated
  `compose --write`. Slice 4 records the intention and computes a deterministic preview; folding apply in now
  would put a half-built writer on the hot path and erase the preview/apply boundary the rest of the stack
  keeps.
- **Let any read-view resource be tailored (not just adopted ones).** Rejected (LOCKED fork: only adopted
  resources are tailorable): tailoring is intent over a resource the project has chosen to USE; tailoring a
  merely-visible resource would record overlays against something the project has not committed to and would
  blur the composition's "what does this project USE" meaning. Adoption is the gate, validated against
  `composition.json`.
- **Allow a free-form overlay `type`.** Rejected: a closed set (`pin|override|layer|gate|fork|disable`,
  prototype `OVERLAY_META`) keeps the folding rules total and the UI's per-type buttons exhaustive; an open
  set would have no defined fold and would drift. Unknown DETAIL is tolerated (INFO finding, base value
  kept); an unknown TYPE is not.
- **Stack multiple pins/overrides per type.** Rejected: a resource has one effective version and one
  effective value per frontmatter field, so `pin`/`override`/`disable`/`fork` keep the latest detail per
  type (idempotent replace); only `layer`/`gate`, which are genuinely additive, may repeat (deduped by
  `(type, detail)`). This keeps the store minimal and the fold unambiguous.
- **Persist the resolved preview on disk.** Rejected: like the derived slices (ADR-0018), the composition
  join (ADR-0019), and the conflict set (ADR-0020), the resolved preview is a pure function of records +
  overlays the operator already produces; persisting it would create a cache to keep in sync. Only the
  irreducible state — the `(uid, sourceId)` overlays — is stored.
- **Auto-prune orphaned overlays on list.** Rejected: an overlay can be orphaned by a transient empty
  catalog, an accidental unsubscribe, or a `compose remove`; silently deleting it would discard a deliberate
  overlay on a reversible condition. Reporting (WARN) + dropping from the listed view, while leaving the file
  intact until an explicit `tailor remove`, is the additive-never-destructive contract ADR-0018/0019 set.

## Related

- ADR-0005 (contentHash is the sole identity primitive — tailored entries reference uids `"<kind>:<id>"`;
  tailoring copies no bytes and changes no identity)
- ADR-0009 (marker provenance via a single minimal field — tailoring references the minimal `source`
  provenance via `(uid, sourceId)` and duplicates none of it)
- ADR-0013 (criticality safety-lock — an `override` of `criticality → safety` is recorded as an intention;
  any safety-lock enforcement happens at application/admission, not here)
- ADR-0017 (federated catalog — sources, catalog-until-admitted; tailoring is per-project intent beside that
  path and never runs the admission pipeline or T2 gate)
- ADR-0018 (slices + per-project subscriptions — the read-view that gates adoptability, which in turn gates
  tailorability)
- ADR-0019 (per-project composition — the adopted set keyed by `(uid, sourceId)` that tailoring attaches to;
  the §7 seam this ADR fills, the orphans-reported-not-deleted contract it reuses, and the
  `manager/compose.mjs` read helpers `tailor` reuses to validate adoption)
- ADR-0020 (conflict adjudication — the sibling per-project store `adjudication.json`, the separate-additive-store
  precedent, and the deterministic-collection + do-not-fabricate discipline this mirrors for the resolved preview)
- docs/specs/catalog.md §"Tailoring & overlays" + BR-CAT-014.. (the normative rules)
- schemas/tailoring.schema.json (the `.forge/tailoring.json` shape)
- forge-design/prototype/forge-harness/project/proto-data.js (`OVERLAY_META`, the resource `overlays`) +
  proto-project.jsx (`TailoringView`/`TailorDetail`) — the surface this ADR formalizes
- manager/tailor.mjs (the tailoring operator: list/add/remove), manager/compose.mjs (the composition read
  helpers it reuses to gate tailorability), manager/catalog.mjs (the catalog record production it reuses for
  the base record), manager/lib/store.mjs (atomic, additive persistence)
