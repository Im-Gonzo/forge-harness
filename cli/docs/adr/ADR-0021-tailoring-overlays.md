# ADR-0021: Tailoring overlays (per-adopted-resource modifiers)

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (Slice 4 — records per-adopted-resource overlays as INTENTIONS + a deterministic resolved preview; application is deferred to Slice 5 compose --write)

> **Release-facing copy.** This is the tailoring-overlays decision as cited by the shipped harness assets
> and the `tailor` CLI verb group (`manager/tailor.mjs`). The full design-stage record — alternatives
> considered, locked forks, and the manager corpus cross-references — lives in
> [docs/manager/adr/ADR-0021-tailoring-overlays.md](../manager/adr/ADR-0021-tailoring-overlays.md). The
> companion SPEC section is [docs/specs/catalog.md](../specs/catalog.md) §"Tailoring & overlays".

## Context

ADR-0019 added the per-project COMPOSITION — the adopted set keyed by `(uid, sourceId)` — and ADR-0020
surfaced project-level CONFLICTS + the adjudication policy. They leave one operator question open: **how
does THIS project bend an adopted resource to fit — without forking it or mutating the shared library?**
A project wants to pin a known-good version, flip a frontmatter field (`model → opus`), layer a small
project fragment on top of a rule, gate a skill to a path glob, detach a body for local edits, or turn a
resource off — all WITHOUT a library write and without editing real `.claude/` files until ready. ADR-0019
§7 named this seam ("per-project tailoring layers ON TOP of an entry"); this ADR fills it.

Three forks were locked before this ADR:

- **Tailoring is a SEPARATE additive store — it does NOT modify the composition's schema.** Overlays live
  in their own `.forge/tailoring.json` (`forge.tailoring.v1`) beside `.forge/composition.json`, keyed by
  the SAME `(uid, sourceId)` identity. ADR-0019's schema is UNCHANGED; tailoring attaches by key.
- **Only an ADOPTED resource may be tailored.** A tailored `(uid, sourceId)` MUST be present in the
  composition; the operator validates against `.forge/composition.json` (reusing `manager/compose.mjs`) and
  never widens that gate.
- **Overlays are RECORDED INTENTIONS; the resolved preview is a VIEW, never a write.** The CLI folds
  overlays over the base record into a deterministic resolved preview and does nothing else in Slice 4 — it
  never mutates the library or any file outside the tailoring store. Application is Slice 5 (`compose
  --write`).

## Decision

### 1. A TAILORING OVERLAY is a per-adopted-resource modifier

A single `{ type, detail }` modifier recorded against an ADOPTED resource. `type` is a closed set, each
with a short type-specific `detail` (prototype `OVERLAY_META`):

| `type`     | `detail` meaning                                   | example                       |
| ---------- | -------------------------------------------------- | ----------------------------- |
| `pin`      | a version to lock to                               | `"v3.2.0"`                    |
| `override` | a frontmatter field change, `"field → value"`      | `"model → opus"`              |
| `layer`    | a fragment layered on top of the body              | `"+ project rule fragment"`   |
| `gate`     | a conditional activation (e.g. a path glob)        | `"paths: src/**"`             |
| `fork`     | the body detached for local edits (detail optional)| `"body detached"` / `""`      |
| `disable`  | the resource is turned off (detail optional)       | `""`                          |

A resource MAY carry multiple overlays. `detail` is required for `pin`/`override`/`layer`/`gate`, optional
(MAY be `""`) for `fork`/`disable`.

### 2. Idempotent dedupe per overlay type

`pin`/`override`/`disable`/`fork` keep at most ONE per type — a second add of that type REPLACES the prior
`detail` (latest wins). `layer`/`gate` MAY repeat, deduped by the pair `(type, detail)`. `remove` drops
matching overlay(s) by `type`, optionally narrowed by `detail`; absent is a no-op. `add`/`remove` are
idempotent.

### 3. The RESOLVED PREVIEW is a deterministic, display-only VIEW

`resolved = { model, residency, activation, body, status, version }`, computed by FOLDING the overlays over
the base catalog record. It is a VIEW — never written to the library or any `.claude/` file:

| overlay      | fold                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `pin`        | `version` = the pin detail                                                    |
| `override`   | parse `"field → value"`; set that field (e.g. `model = "opus"`)               |
| `gate`       | `activation` = the gate detail (else `"default"`)                             |
| `fork`       | `body` = `"forked · local edits"`                                             |
| `layer`      | `body` = `"source + project layer"`                                           |
| `disable`    | `status` = `"disabled"`                                                       |
| _(none)_     | the field tracks its source (the base record value)                           |

An unknown/unparseable detail LEAVES the base value and adds an INFO finding — it never errors, guesses, or
fabricates a resolved value. The preview is a pure function of the base record + overlays (no cache).

### 4. Tailorability is gated by the COMPOSITION (only adopted resources)

A resource is tailorable iff its `(uid, sourceId)` is ADOPTED (present in `.forge/composition.json`,
ADR-0019). `forge tailor add` validates membership by REUSING `manager/compose.mjs`, never widens the gate,
and never adopts as a side effect. An overlay for a `(uid, sourceId)` no longer adopted (an ORPHAN) is
REPORTED (WARN) and dropped from the listed set, but is NEVER deleted from disk — removal is always an
explicit `forge tailor remove` (the orphans-reported-not-deleted contract of ADR-0019 §5).

### 5. Per-project tailoring — `.forge/tailoring.json` (`forge.tailoring.v1`)

The overlays are persisted under the active root, validated by `schemas/tailoring.schema.json` (mirroring
`composition.json`, ADR-0019 §4), a SEPARATE additive store beside it:

```jsonc
{
  "schema": "forge.tailoring.v1",
  "version": 1,
  "tailored": [
    { "uid": "skill:code-review", "sourceId": "acme-skills", "overlays": [
        { "type": "pin", "detail": "v3.2.0" },
        { "type": "override", "detail": "model → opus" },
        { "type": "gate", "detail": "paths: src/**" } ] },
    { "uid": "rule:no-secrets", "sourceId": "acme-internal", "overlays": [
        { "type": "layer", "detail": "+ acme PII addendum" } ] }
  ]
}
```

Only the `(uid, sourceId)` key + its overlays are stored; the resolved preview is DERIVED (§3), never
persisted. Reads/writes go through `manager/lib/store.mjs` and are ADDITIVE and never destructive (`add`
records/replaces one overlay; `remove` drops matching overlays), preview by default, written on `--apply`,
fail-open — the contract ADR-0018/0019/0020 set; the file is created on first `--apply`. The composition
schema is UNCHANGED.

### 6. CLI surface — the `tailor` verb group (`manager/tailor.mjs`)

Mirrors the `compose`/`conflict` operator idiom (dry-run by default, `--apply` to write, C3-envelope
output, findings, fail-open). Contract `run(subcmd, args, ctx) -> { ok, data, findings, summary }`,
dispatched from `bin/forge.mjs` via a `TAILOR_VERBS` set + `tailorUsage()` next to `CONFLICT_VERBS`:

- `forge tailor list [--json]` → `data { tailoringPath, tailored:[ { uid, sourceId, kind,
  overlays:[{type,detail}], resolved:{...} } ], counts:{ tailored, overlays } }`. JOINS each entry to its
  catalog record (REUSING `manager/catalog.mjs`) for `kind` + base values, computes the resolved preview
  (§3), drops not-adopted entries (WARN, retained on disk, §4).
- `forge tailor add <uid> --type <t> --detail <s> [--source <id>] [--apply]` → validate ADOPTED (§4) + valid
  `type`; record the overlay with the per-type dedupe rule (§2). `--detail` optional for `fork`/`disable`.
- `forge tailor remove <uid> --type <t> [--detail <s>] [--source <id>] [--apply]` → remove matching
  overlay(s) by `type`, optionally narrowed by `detail`. Idempotent.

It REUSES the catalog record production + composition read helpers; it reimplements no scanning, read-view,
dedup, adoption, or conflict logic, and invokes NO model.

## Consequences

- A project can bend an adopted resource to fit (pin/override/layer/gate/fork/disable) without forking the
  library or editing real `.claude/` files — per-project intent, the analogue of ADR-0019/0020's per-project
  state.
- Keeping tailoring a SEPARATE additive store leaves ADR-0019's composition schema untouched; tailoring
  attaches by `(uid, sourceId)` rather than extending the adopted entry.
- Preview-by-default defers the irreversible/disk-touching half (application) to Slice 5 behind a deliberate
  gate; recording an overlay is cheap and reversible.
- The resolved preview is a pure function of base record + overlays — no cache to keep in sync (the
  reasoning ADR-0018/0019/0020 used for derived slices, composition join, and conflict set). Unknown detail
  yields an INFO finding and keeps the base value, so the preview never fabricates.
- Tailoring does NOT change ADMISSION (ADR-0017), the read-view (ADR-0018), the composition (ADR-0019),
  adjudication (ADR-0020), dedup, or the judge — those are untouched; identity stays `contentHash`
  (ADR-0005), provenance the minimal `source` (ADR-0009).

## Related

- [docs/manager/adr/ADR-0021-tailoring-overlays.md](../manager/adr/ADR-0021-tailoring-overlays.md) — the
  full design-stage record (alternatives, locked forks, manager corpus xrefs).
- [docs/adr/ADR-0017-federated-catalog.md](./ADR-0017-federated-catalog.md) — sources, catalog-until-admitted;
  tailoring is per-project intent beside that path.
- [docs/adr/ADR-0018-slices-and-subscriptions.md](./ADR-0018-slices-and-subscriptions.md) — the read-view
  that gates adoptability, which gates tailorability.
- [docs/adr/ADR-0019-project-composition.md](./ADR-0019-project-composition.md) — the adopted set keyed by
  `(uid, sourceId)` that tailoring attaches to (the §7 seam this fills); the `compose` read helpers `tailor`
  reuses to validate adoption.
- [docs/adr/ADR-0020-conflict-adjudication.md](./ADR-0020-conflict-adjudication.md) — the sibling per-project
  store and the separate-additive-store + do-not-fabricate precedent this mirrors.
- [docs/specs/catalog.md](../specs/catalog.md) §"Tailoring & overlays" + BR-CAT-014.. — the normative rules.
- `schemas/tailoring.schema.json` — the `.forge/tailoring.json` shape.
- `manager/tailor.mjs` (the tailoring operator), `manager/compose.mjs` (the composition read helpers it
  reuses), `manager/catalog.mjs` (the catalog record production it reuses), `manager/lib/store.mjs` (atomic,
  additive persistence).
