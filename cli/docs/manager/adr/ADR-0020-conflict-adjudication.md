# ADR-0020: Conflict adjudication (the per-project conflict queue)

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (Slice 3 — surfaces dedup conflicts as a project-level queue; consumes the existing judge/eval signals; the lockfile is deferred to Slice 5)

## Context

ADR-0017 gave Forge a federated CATALOG with a dedup step that classifies every candidate against the
existing catalog/library into `unique | exact-dup | uid-collision | near-dup`, and a conflict JUDGE that
emits the closed verdict taxonomy `keep | replace | both | quarantine` with a winning uid (catalog.md
§5–§6; BR-CAT-001/002/003). ADR-0018 added SLICES + per-project SUBSCRIPTIONS (the read-view), and
ADR-0019 added the per-project COMPOSITION — the adopted set keyed by `(uid, sourceId)`. ADR-0019 §7
named the seam explicitly: because an adopted entry is keyed by `(uid, sourceId)`, **the same uid can be
visible (and adopted) from two places**, and "Slice 3 detects that and the composition health flips from
'resolved / in sync' to a blocked state."

This ADR fills that seam. The dedup vocabulary and the judge verdict ALREADY EXIST inside one admission;
what is missing is a PROJECT-LEVEL view that:

1. surfaces, across a project's read-view, every uid that resolves to **>= 2 distinct candidate
   records** — i.e. a dedup `uid-collision` or `near-dup` across the library-local + subscribed-slice
   sources — as a CONFLICT the operator can see and adjudicate;
2. lets the project set a per-criticality **adjudication policy** (whether a conflict blocks the
   composition or may auto-resolve);
3. records a human **resolve** (the T2 pick) that, on apply, updates the composition so the winner is
   adopted and its losing peers are dropped;
4. and does all of this **deterministically** — collecting conflicts and CONSUMING any already-recorded
   judge verdict + eval scores, never invoking the judge agent or any model.

Two pressures shape the design, and both are inherited constraints, not new choices:

- **The judge verdict is PRODUCED elsewhere, CONSUMED here.** The conflict judge (catalog.md §5.2/§6,
  `bundles/catalog-judge.md`) runs inside `forge catalog admit`/`forge catalog judge` and records its
  verdict into the sidecar `.forge/catalog-verdicts.json`. Per METHOD §7 (deterministic collection +
  LLM judgment), the project-level conflict operator is the DETERMINISTIC-COLLECTION half: it reads that
  sidecar and attaches the recorded verdict to the matching conflict; it MUST NOT call the judge or any
  model. Re-judging here would duplicate a calibrated, gated capability and put a model on the hot path.
- **`replace` is irreversible and human-gated (T2).** BR-CAT-003 already makes a `replace` — superseding
  an already-admitted LIBRARY resource — an autonomous-draft + human-apply action. The conflict queue is
  a per-PROJECT adoption surface (it edits the composition, not the library), so most resolves never
  touch the library at all. But any resolve that WOULD replace an already-admitted library resource stays
  squarely a T2 human action; the policy's "auto" mode must NOT be a back door around BR-CAT-003.

Three forks were locked before this ADR (recorded here, not re-litigated):

- **A conflict is exactly a read-view uid with >= 2 distinct candidates — reuse dedup, do not invent a
  new classifier.** The conflict set is DERIVED from the existing catalog record production (the same one
  `slice list` / `compose list` reuse), filtered to the read-view, grouping the `uid-collision`/`near-dup`
  peers of a uid into its candidates.
- **The CLI is deterministic-collection only — it never invokes the judge/any model.** The judge verdict
  is consumed from the recorded sidecar if present, never produced here (METHOD §7).
- **Policy defaults to all-block; resolve is a human T2 pick.** Conservative by default (consistent with
  sources untrusted, ADR-0017; slices unsubscribed, ADR-0018; resources unadopted, ADR-0019). A resolve
  is the human decision; "auto" relaxes the per-conflict pick for non-replace composition picks only, and
  never self-applies a library `replace` (BR-CAT-003).

## Decision

### 1. A CONFLICT is a read-view uid with >= 2 distinct candidate records

A project-level **conflict** is a uid that resolves to two or more DISTINCT candidate records in the
project's catalog read-view (ADR-0018) — exactly the dedup `uid-collision` (same uid, different bytes) or
`near-dup` (similar but not identical) classes of catalog.md §5.1, observed ACROSS the read-view's sources
rather than inside one admission. `unique` and `exact-dup` are not conflicts (no model call, no
adjudication). The conflict set is **DERIVED**, never stored: the operator reuses the catalog record
production, filters to the read-view, and groups a uid's `uid-collision`/`near-dup` peers into its
candidate list. A uid with a single read-view candidate is not a conflict.

A conflict carries:

- `uid` — the conflicting resource uid `"<kind>:<id>"` (ADR-0005).
- `kind` — the resource kind.
- `criticality` — `safety | compliance | normal` (ADR-0013), used by the policy (§3).
- `candidates[]` — each `{ sourceId|null, version, score:number|null, metrics:[{k,v}]|[],
  security:scanState }`. `sourceId` is the source the candidate came from, or `null` for the
  library-local copy.
- `judge` — `{ verdict, winner, rationale }` read from the recorded verdict sidecar for this uid, or
  `null` when no verdict is recorded (§2).
- `suggested` — the suggested winner sourceId (§4), or `null` ("needs human").
- `choice` — the recorded human pick sourceId (or `null` for library-local), or absent/unset.
- `state` — `manual | auto | blocking` (§3).

### 2. Eval + judge signals are CONSUMED if recorded, never produced

The operator attaches signals it can read deterministically; it invents none:

- **Eval scores.** If the eval-harness (`manager/eval-harness.mjs`) has a real score for a candidate, it
  is attached as `score` (and any metrics as `metrics`). If no real score exists, `score = null` and the
  UI shows "—". Scores are NEVER fabricated.
- **Judge verdict.** The recorded verdict for the uid is read from the sidecar `.forge/catalog-verdicts.json`
  (the same store `forge catalog judge`/`audit` writes, BR-CAT-001) and attached as
  `judge = { verdict, winner, rationale }`. If no verdict is recorded, `judge = null` and the surface
  shows a calm "no judge verdict recorded" note. The operator MUST NOT invoke `bundles/catalog-judge.md`
  or any model to produce a verdict — this is the deterministic-collection half of METHOD §7. The closed
  taxonomy (BR-CAT-001) and the untrusted-DATA rule (BR-CAT-002) bind the PRODUCER; here the verdict is
  consumed as already-recorded evidence.

### 3. Per-criticality adjudication policy; conflict state

The project sets an adjudication **policy** per criticality — `{ normal, compliance, safety }`, each
`"auto" | "block"`. The **DEFAULT is all-block**. A conflict's `state` is derived:

> `state(c)` = `choice != null` → **`manual`** ; else `policy[c.criticality] == "auto"` → **`auto`** ;
> else **`blocking`**.

A conflict is **BLOCKING** iff `state == "blocking"`. The composition is "blocked" while any read-view
conflict is blocking (the Slice 2 seam, §6); otherwise the composition health is OK.

`"auto"` relaxes the per-conflict human pick for a conflict that has a graceful suggested winner (§4) and
whose resolution is a composition-level adoption pick. **It is NOT a back door around BR-CAT-003:** a
resolve that would REPLACE an already-admitted LIBRARY resource is a T2 human action even under `"auto"` —
the CLI records the human's explicit `--winner` choice with `--apply` and never auto-picks a library
replace without the human. `"auto"` governs only the per-project composition pick, never a library
replace.

### 4. Suggested winner falls back gracefully; resolve is the human T2 pick

- **`suggested`** is computed deterministically with a graceful fallback: the eval-highest candidate
  (when real scores exist) → else the recorded judge `winner` (when a verdict is recorded) → else `null`
  ("needs human"). It is a HINT, never an automatic decision; an absent eval/judge signal yields `null`,
  not a fabricated pick.
- **`resolve`** records the human's `--winner <sourceId|"library">` choice for a conflict uid — a T2 pick
  (ADR-0017 §7). On `--apply` it ALSO updates the composition (`.forge/composition.json`) so the winner's
  `(uid, sourceId)` is adopted and the losing peers for that uid are removed, REUSING the ADR-0019
  composition helpers (`manager/compose.mjs`) rather than duplicating adopt/remove. Resolve is idempotent.
  When the resolve would supersede an already-admitted library resource, it is the human's deliberate
  `--apply` (BR-CAT-003) — the CLI never self-applies it.

### 5. Per-project adjudication — `.forge/adjudication.json` (`forge.adjudication.v1`)

The policy and the human choices are persisted under the active root, validated by
`schemas/adjudication.schema.json` (mirroring the `composition.json` idiom of ADR-0019 §4):

```jsonc
{
  "schema": "forge.adjudication.v1",
  "version": 1,
  "policy": { "normal": "block", "compliance": "block", "safety": "block" },
  "choices": [
    { "uid": "skill:run-eval", "winner": "acme-skills" },  // human picked the source candidate
    { "uid": "agent:reviewer", "winner": null }            // human picked the library-local copy
  ]
}
```

Only the POLICY and the CHOICES are stored; the conflict SET itself is derived (§1) and never persisted.
Reads/writes go through `manager/lib/store.mjs` (`readJson` / `writeJsonAtomic`) and are **ADDITIVE and
never destructive**: `resolve` sets/clears one choice; `policy --set` sets one or more dimensions; neither
rewrites unrelated state, and the file is created on first `--apply`. Preview by default, write on
`--apply`, fail-open at the boundary — the same contract ADR-0018/0019 set.

### 6. CLI surface — the `conflict` verb group (`manager/conflict.mjs`)

A new verb group mirroring the `compose` operator idiom (dry-run by default, `--apply` to write,
C3-envelope output via `manager/lib/json-out.mjs`, findings via `manager/lib/findings.mjs`, fail-open at
the boundary). Module contract: `run(subcmd, args, ctx) -> { ok, data, findings, summary }`, dispatched
from `bin/forge.mjs` via a `CONFLICT_VERBS` set + a `conflictUsage()` banner next to `COMPOSE_VERBS`.

- `forge conflict list [--json]` → `data { adjudicationPath, policy, conflicts:[ <CONFLICT> ],
  counts:{ total, blocking, auto, manual } }`. Derives conflicts from the catalog record set (REUSING
  `manager/catalog.mjs` as slices/compose do), filtered to the read-view, grouping `uid-collision`/`near-dup`
  peers into candidates; attaches the recorded judge verdict + eval scores (§2); computes `suggested` and
  `state` from the policy + choices (§3–§4).
- `forge conflict resolve <uid> --winner <sourceId|"library"> [--apply]` → records `{ uid, winner }` in
  `choices` (the T2 pick). On `--apply` ALSO updates the composition (the winner's `(uid, sourceId)`
  adopted, losing peers removed) by REUSING `manager/compose.mjs`. Idempotent.
- `forge conflict policy [--set normal=auto|block] [--set compliance=...] [--set safety=...] [--apply]` →
  get (no `--set`) or set the policy. Values are validated against `auto|block`.

It REUSES the catalog record production and the composition helpers; it reimplements no scanning,
read-view, dedup, or adoption logic, and it invokes NO model.

### 7. Seams left / not built now

- **No re-judging.** This operator never produces a verdict; if a conflict has no recorded verdict, its
  `judge` is `null` and the human decides (or runs `forge catalog judge` separately). Producing verdicts
  stays with the admission pipeline.
- **Slice 5 — the lockfile.** A resolved composition is the lockfile's input; the recorded choices here
  feed that resolution but do not replace it.

## Consequences

**Positive**
- The project gets a single, deterministic view of every duplicate-uid conflict across its read-view,
  reusing the existing dedup vocabulary rather than inventing a parallel classifier.
- No model is on the project-level hot path: conflicts are collected deterministically and the
  already-recorded judge/eval signals are consumed as evidence (METHOD §7).
- Policy-default-block keeps the conservative posture of the whole catalog stack; the project opts INTO
  auto-resolution per criticality, deliberately.
- Resolve edits only the per-project composition by default; the irreversible library `replace` stays a
  deliberate T2 human apply (BR-CAT-003), so "auto" cannot become a back door.
- Eval/judge signals are consumed only when REAL; `suggested` falls back to `null` ("needs human") rather
  than fabricating a winner, so the surface never overstates confidence.

**Negative**
- A fifth per-project on-disk shape now exists (`adjudication.json`) alongside the source manifest, the
  lockfile, the subscription set, and the composition.
- A conflict's `judge` is often `null` until someone runs the admission/judge path; the project view
  shows "no judge verdict recorded" rather than computing one — the cost of keeping the model off the
  hot path.

**Neutral**
- The conflict set is DERIVED, not stored, so there is no conflict cache to keep in sync — the same
  reasoning ADR-0018 used for derived slices and ADR-0019 used for the derived composition join.
- Adjudication is a presentation/intent concern over the composition; it does not change ADMISSION
  (ADR-0017), the read-view (ADR-0018), dedup, or the judge — those are untouched.

## Alternatives considered

- **Re-run the judge at conflict-list time to fill in missing verdicts.** Rejected (LOCKED fork:
  deterministic-collection only): it would put a model on the project-level hot path, duplicate a
  calibrated + gated capability (catalog.md §6.2), and violate METHOD §7's split. The verdict is produced
  by the admission/judge path and CONSUMED here.
- **Default the policy to "auto" (resolve conflicts automatically by eval/judge winner).** Rejected: it
  inverts the conservative default the whole stack uses (untrusted sources, unsubscribed slices, unadopted
  resources) and would silently pick winners — including, at the edge, a library replace — without a human.
  Default all-block; opt INTO auto per criticality.
- **Let policy "auto" self-apply a library `replace`.** Rejected (LOCKED — BR-CAT-003): a `replace` of an
  already-admitted library resource is irreversible and human-gated. "auto" relaxes the per-conflict pick
  for composition-level adoption only; a library replace always requires the human's explicit `--winner`
  + `--apply`.
- **Fabricate a `suggested` winner when no eval/judge signal exists (e.g. newest version, or first
  source).** Rejected: that overstates confidence and would nudge a human toward an unjustified pick. With
  no real signal, `suggested = null` ("needs human") — the same "do not fabricate scores" discipline the
  eval surface uses.
- **Invent a new conflict classifier instead of reusing dedup.** Rejected: dedup already produces
  `uid-collision`/`near-dup` deterministically (catalog.md §5.1); a parallel classifier would drift from
  the admission-time taxonomy and double the surface to maintain. A conflict is exactly a read-view uid
  with >= 2 distinct candidates.
- **Store the resolved conflict set / the derived candidates on disk.** Rejected: like slices (ADR-0018)
  and the composition join (ADR-0019), the conflict set is a pure function of records the operator already
  produces; persisting it would create a cache to keep in sync. Only the policy + the human choices —
  irreducible state — are stored.
- **Put the policy on the existing `/settings` route / a global file.** Rejected: `/settings` is the MCP
  settings page, and the adjudication policy is per-PROJECT state (like subscriptions and the
  composition), so it lives under the active root in `.forge/adjudication.json` and on the `/conflicts`
  surface.

## Related

- ADR-0005 (contentHash is the sole identity primitive — conflicts key on uids `"<kind>:<id>"`; the
  candidates differ by `contentHash`, the dedup discriminator)
- ADR-0009 (marker provenance via a single minimal field — candidates reference the minimal `source`
  provenance; adjudication duplicates none of it)
- ADR-0013 (criticality safety-lock — the `safety | compliance | normal` tag the adjudication policy keys
  on; the conservative default mirrors its err-toward-safety stance)
- ADR-0017 (federated catalog — the dedup classes `uid-collision`/`near-dup` (§5.1), the closed judge
  verdict taxonomy (§6), and the T2 human-applied `replace` gate (§7) this consumes; BR-CAT-001/002/003)
- ADR-0018 (slices + per-project subscriptions — the read-view across which conflicts are detected)
- ADR-0019 (per-project composition — the adopted set whose `(uid, sourceId)` key surfaces the conflict
  (§7), and the `compose adopt`/`remove` helpers `resolve --apply` reuses)
- docs/specs/catalog.md §"Conflict adjudication" + BR-CAT-010.. (the normative rules); BR-CAT-001/002/003
  (the closed verdict taxonomy, untrusted-DATA rule, and T2 `replace` gate this defers to)
- docs/METHOD.md §3 (autonomy ladder / T2), §7 (deterministic collection + LLM judgment — the split this
  operator's collection half lives on)
- schemas/adjudication.schema.json (the `.forge/adjudication.json` shape)
- manager/conflict.mjs (the conflict operator: list/resolve/policy), manager/compose.mjs (the composition
  helpers `resolve --apply` reuses), manager/catalog.mjs (the catalog record production it reuses),
  manager/eval-harness.mjs (the eval scores it consumes when real), manager/lib/store.mjs (atomic,
  additive persistence)
