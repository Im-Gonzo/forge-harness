# ADR-0020: Conflict adjudication (the per-project conflict queue)

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (Slice 3 — surfaces dedup conflicts as a project-level queue; consumes the existing judge/eval signals; the lockfile is deferred to Slice 5)

> **Release-facing copy.** This is the conflict-adjudication decision as cited by the shipped harness
> assets and the `conflict` CLI verb group (`manager/conflict.mjs`). The full design-stage record —
> alternatives considered, locked forks, and the manager corpus cross-references — lives in
> [docs/manager/adr/ADR-0020-conflict-adjudication.md](../manager/adr/ADR-0020-conflict-adjudication.md).
> The companion SPEC section is [docs/specs/catalog.md](../specs/catalog.md) §"Conflict adjudication".

## Context

ADR-0017 gave Forge a dedup step that classifies candidates into `unique | exact-dup | uid-collision |
near-dup`, and a conflict JUDGE that emits the closed verdict `keep | replace | both | quarantine` with a
winning uid (catalog.md §5–§6; BR-CAT-001/002/003). ADR-0018 added the per-project read-view, and
ADR-0019 added the per-project COMPOSITION (the adopted set keyed by `(uid, sourceId)`). ADR-0019 §7 named
the seam: because an adopted entry is keyed by `(uid, sourceId)`, the same uid can be visible (and
adopted) from two places, and Slice 3 detects that and flips the composition health from "resolved" to
"blocked".

This ADR fills the seam with a project-level CONFLICT view that (1) surfaces every read-view uid resolving
to >= 2 distinct candidate records (a dedup `uid-collision`/`near-dup` across the read-view's sources),
(2) lets the project set a per-criticality adjudication policy, (3) records a human resolve that updates
the composition on apply, and (4) does all of this DETERMINISTICALLY — collecting conflicts and CONSUMING
any already-recorded judge verdict + eval scores, never invoking the judge agent or any model.

Three forks were locked before this ADR:

- **A conflict is exactly a read-view uid with >= 2 distinct candidates — reuse dedup, don't invent a
  classifier.** Derived from the catalog record production (the one `slice list`/`compose list` reuse),
  filtered to the read-view, grouping a uid's `uid-collision`/`near-dup` peers into its candidates.
- **The CLI is deterministic-collection only — it never invokes the judge/any model** (METHOD §7). The
  judge verdict is consumed from the recorded sidecar if present, never produced here.
- **Policy defaults to all-block; resolve is a human T2 pick.** Conservative by default (consistent with
  sources untrusted, slices unsubscribed, resources unadopted); "auto" relaxes the per-conflict pick for
  non-replace composition picks only and never self-applies a library `replace` (BR-CAT-003).

## Decision

### 1. A CONFLICT is a read-view uid with >= 2 distinct candidate records

A project-level conflict is a uid resolving to two or more DISTINCT candidate records in the read-view
(ADR-0018) — exactly the dedup `uid-collision` (same uid, different bytes) or `near-dup` (similar, not
identical) classes (catalog.md §5.1), observed ACROSS the read-view's sources. `unique`/`exact-dup` are
not conflicts. The set is DERIVED, never stored: reuse the catalog record production, filter to the
read-view, group a uid's `uid-collision`/`near-dup` peers into its candidate list.

A conflict carries `uid`, `kind`, `criticality` (`safety | compliance | normal`, ADR-0013),
`candidates[]` (`{ sourceId|null, version, score:number|null, metrics:[{k,v}]|[], security:scanState }`),
`judge` (`{ verdict, winner, rationale }` from the recorded sidecar, or `null`), `suggested`
(sourceId or `null`), `choice` (the recorded human pick), and `state` (`manual | auto | blocking`).

### 2. Eval + judge signals are CONSUMED if recorded, never produced

The operator attaches only signals it can read deterministically:

- **Eval scores** from `manager/eval-harness.mjs` when a REAL score exists; otherwise `score = null` and
  the UI shows "—". Scores are NEVER fabricated.
- **Judge verdict** read from the sidecar `.forge/catalog-verdicts.json` (the store `forge catalog
  judge`/`audit` writes, BR-CAT-001), attached as `judge`. If none is recorded, `judge = null` and the
  surface shows a calm "no judge verdict recorded" note. The operator MUST NOT invoke
  `bundles/catalog-judge.md` or any model — this is the deterministic-collection half of METHOD §7. The
  closed taxonomy (BR-CAT-001) and untrusted-DATA rule (BR-CAT-002) bind the PRODUCER; here the verdict
  is consumed as already-recorded evidence.

### 3. Per-criticality adjudication policy; conflict state

The project sets a policy per criticality — `{ normal, compliance, safety }`, each `"auto" | "block"`,
**DEFAULT all-block**. State is derived:

> `state(c)` = `choice != null` → **`manual`** ; else `policy[c.criticality] == "auto"` → **`auto`** ;
> else **`blocking`**. A conflict is BLOCKING iff `state == "blocking"`.

The composition is "blocked" while any read-view conflict is blocking (the Slice 2 seam); else OK.
`"auto"` relaxes the per-conflict pick for a conflict with a graceful suggested winner whose resolution is
a composition adoption pick. It is **NOT a back door around BR-CAT-003**: a resolve that would REPLACE an
already-admitted LIBRARY resource is a T2 human action even under `"auto"` — recorded via the human's
explicit `--winner` + `--apply`, never self-applied.

### 4. Suggested winner falls back gracefully; resolve is the human T2 pick

`suggested` is the eval-highest candidate → else the recorded judge `winner` → else `null` ("needs
human"); it is a HINT, never an automatic decision, and is never fabricated. `resolve` records the
human's `--winner <sourceId|"library">` choice (a T2 pick, ADR-0017 §7); on `--apply` it ALSO updates
`.forge/composition.json` so the winner's `(uid, sourceId)` is adopted and the losing peers for that uid
are removed, REUSING `manager/compose.mjs`. Resolve is idempotent; a resolve superseding an
already-admitted library resource is the human's deliberate `--apply` (BR-CAT-003), never self-applied.

### 5. Per-project adjudication — `.forge/adjudication.json` (`forge.adjudication.v1`)

The policy + human choices are persisted under the active root, validated by
`schemas/adjudication.schema.json` (mirroring `composition.json`, ADR-0019 §4):

```jsonc
{
  "schema": "forge.adjudication.v1",
  "version": 1,
  "policy": { "normal": "block", "compliance": "block", "safety": "block" },
  "choices": [
    { "uid": "skill:run-eval", "winner": "acme-skills" },
    { "uid": "agent:reviewer", "winner": null }
  ]
}
```

Only the POLICY and CHOICES are stored; the conflict SET is derived (§1), never persisted. Reads/writes
go through `manager/lib/store.mjs` and are ADDITIVE and never destructive (`resolve` sets/clears one
choice; `policy --set` sets one or more dimensions), preview by default, written on `--apply`, fail-open —
the same contract ADR-0018/0019 set; the file is created on first `--apply`.

### 6. CLI surface — the `conflict` verb group (`manager/conflict.mjs`)

Mirrors the `compose` operator idiom (dry-run by default, `--apply` to write, C3-envelope output,
findings, fail-open). Contract `run(subcmd, args, ctx) -> { ok, data, findings, summary }`, dispatched
from `bin/forge.mjs` via a `CONFLICT_VERBS` set + `conflictUsage()` next to `COMPOSE_VERBS`:

- `forge conflict list [--json]` → `data { adjudicationPath, policy, conflicts:[ <CONFLICT> ],
  counts:{ total, blocking, auto, manual } }`. Derives conflicts from the catalog record set (REUSING
  `manager/catalog.mjs`), filtered to the read-view, grouping peers into candidates; attaches the recorded
  judge verdict + eval scores; computes `suggested` + `state`.
- `forge conflict resolve <uid> --winner <sourceId|"library"> [--apply]` → records `{ uid, winner }`; on
  `--apply` updates the composition by reusing `manager/compose.mjs`. Idempotent.
- `forge conflict policy [--set normal=auto|block] [--set compliance=...] [--set safety=...] [--apply]` →
  get (no `--set`) or set the policy; values validated against `auto|block`.

It REUSES the catalog record production and the composition helpers; it reimplements no scanning,
read-view, dedup, or adoption logic, and invokes NO model.

## Consequences

- A single deterministic view of every duplicate-uid conflict across the read-view, reusing the existing
  dedup vocabulary rather than a parallel classifier.
- No model on the project-level hot path: conflicts are collected deterministically and the
  already-recorded judge/eval signals consumed as evidence (METHOD §7).
- Policy-default-block keeps the conservative posture of the whole catalog stack; the project opts INTO
  auto-resolution per criticality.
- Resolve edits only the per-project composition by default; the irreversible library `replace` stays a
  deliberate T2 human apply (BR-CAT-003), so "auto" cannot become a back door.
- `suggested` falls back to `null` ("needs human") rather than fabricating a winner when no real
  eval/judge signal exists.
- Adjudication does NOT change ADMISSION (ADR-0017), the read-view (ADR-0018), dedup, or the judge — those
  are untouched. The conflict set is derived, not stored, so there is no cache to keep in sync.

## Related

- [docs/manager/adr/ADR-0020-conflict-adjudication.md](../manager/adr/ADR-0020-conflict-adjudication.md)
  — the full design-stage record (alternatives, locked forks, manager corpus xrefs).
- [docs/adr/ADR-0017-federated-catalog.md](./ADR-0017-federated-catalog.md) — the dedup classes, the
  closed judge verdict taxonomy, and the T2 `replace` gate this consumes (BR-CAT-001/002/003).
- [docs/adr/ADR-0018-slices-and-subscriptions.md](./ADR-0018-slices-and-subscriptions.md) — the read-view
  across which conflicts are detected.
- [docs/adr/ADR-0019-project-composition.md](./ADR-0019-project-composition.md) — the adopted set whose
  `(uid, sourceId)` key surfaces the conflict (§7), and the `compose` helpers `resolve --apply` reuses.
- [docs/specs/catalog.md](../specs/catalog.md) §"Conflict adjudication" + BR-CAT-010.. — the normative
  rules; BR-CAT-001/002/003 — the closed verdict taxonomy, untrusted-DATA rule, and T2 `replace` gate
  this defers to.
- `schemas/adjudication.schema.json` — the `.forge/adjudication.json` shape.
- `manager/conflict.mjs` (the conflict operator), `manager/compose.mjs` (the composition helpers it
  reuses), `manager/catalog.mjs` (the catalog record production it reuses), `manager/eval-harness.mjs`
  (the eval scores it consumes when real), `manager/lib/store.mjs` (atomic, additive persistence).
