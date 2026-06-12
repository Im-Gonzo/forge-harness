# ADR-0022: Project lockfile (the resolved composition manifest)

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (Slice 5 — the resolved per-project lockfile `forge.lock`: the adopted set JOINED with overlays + adjudication choices + pins + a deterministic content hash; MANIFEST-ONLY — materializing the composition into a project's `.claude/` stays the bootstrap composer's job, documented here as a future step)

## Context

ADR-0017 gave Forge a federated CATALOG (external repos as *sources*, synced into a discoverable
superset, ADMITTED into the owned LIBRARY) and a machine-local `.forge/sources.lock` that pins each
SOURCE's resolved commit (catalog.md §2.2, `forge.sources.lock.v1`). ADR-0018 added SLICES + per-project
SUBSCRIPTIONS (the read-view). ADR-0019 added the per-project COMPOSITION — the adopted set keyed by
`(uid, sourceId)` (`.forge/composition.json`). ADR-0020 surfaced project-level CONFLICTS and recorded the
adjudication policy + human choices (`.forge/adjudication.json`). ADR-0021 added per-adopted-resource
TAILORING OVERLAYS as recorded intentions + a deterministic resolved preview (`.forge/tailoring.json`).
Together those answer where a resource comes from, what a project sees, what it uses, which copy wins when
a uid is ambiguous, and how the project bends an adopted resource to fit.

They leave one operator question open, and three of those ADRs named it explicitly as the seam Slice 5
fills (ADR-0019 §7, ADR-0020 §7, ADR-0021 §7): **what is the single, resolved, git-committable statement
of exactly what this project has composed — the adopted set FOLDED with its overlays, its adjudication
choices, and each entry's pinned version/commit, plus a deterministic fingerprint so two machines can
agree they resolved the same thing?** The composition, the adjudication, and the tailoring stores each
hold one irreducible slice of intent; none is the resolved whole, and none is a stable digest a teammate
or CI can diff. This ADR defines that resolved whole: **`forge.lock`, the project lockfile.**

`forge.lock` is the PROJECT analogue of `package-lock.json`: a resolved manifest, committed at the project
root, that records the exact composed set + a content hash so a checkout reproduces the same composition.
It is DISTINCT from `.forge/sources.lock`, which pins SOURCE commits (the machine-local cache, never
committed, ADR-0017 §2.2). One pins where the *bytes* came from; the other records what the *project*
resolved. Both are "lockfiles", and conflating them is exactly the trap this ADR forecloses.

Two pressures shape the design, and both are inherited constraints, not new choices:

- **Writing the lockfile is NOT materializing the composition.** `lock write` records the RESOLVED
  manifest — it MUST NOT generate or modify any real `.claude/` file, the git-tracked library, or any
  resource content. Materializing the composition into a project's `.claude/` tree (writing the pinned
  version, the overridden frontmatter, the layered fragment) is the EXISTING bootstrap composer's job and
  is EXPLICITLY OUT OF SCOPE for this slice — it is documented as a future step (§7), not built here. The
  resolved preview ADR-0021 §3 computes is indicative input to that future apply, not a write.
- **The lockfile is DERIVED from existing stores — it adds no new authoritative state.** `forge.lock` is a
  pure JOIN over the composition (ADR-0019), the tailoring overlays (ADR-0021), the adjudication choices
  (ADR-0020), and each entry's pinned version/commit (from the catalog record / `sources.lock`). The
  operator REUSES the read helpers of `manager/compose.mjs`, `manager/tailor.mjs`, and `manager/conflict.mjs`
  — it duplicates no scanning, read-view, dedup, adoption, conflict, or tailoring logic. The lockfile is
  the only place the resolved whole is persisted, and it is persisted because a CONTENT HASH and a
  git-committable artifact are the point; everything inside it is reproducible from its inputs.

Three forks were locked before this ADR (recorded here, not re-litigated):

- **`forge.lock` is the PROJECT lockfile, DISTINCT from `.forge/sources.lock`.** It lives at the ACTIVE
  PROJECT ROOT (`<activeRoot>/forge.lock`), is git-committable (like `package-lock.json`), and records the
  RESOLVED COMPOSITION. `.forge/sources.lock` pins SOURCE commits, lives under `.forge/`, and is
  machine-local (never committed, ADR-0017 §2.2). The two are not merged and not interchangeable.
- **`lock write` is MANIFEST-ONLY — it never touches `.claude/`.** It writes ONLY `forge.lock`. It MUST
  NOT materialize/generate or modify any real `.claude/` file, the library, or any resource content.
  Materialization is the bootstrap composer's job (out of scope, §7).
- **The content hash is DETERMINISTIC and EXCLUDES `generatedAt`.** The hash is a digest over the CANONICAL
  resolved entries (sorted, overlays sorted, the `generatedAt` timestamp EXCLUDED), so the SAME composition
  yields the SAME hash across machines and times. `generatedAt` is recorded for humans but never feeds the
  hash.

## Decision

### 1. `forge.lock` is the RESOLVED COMPOSITION manifest

A project's **lockfile** (`forge.lock`, schema `forge.lock.v1`) is the single resolved statement of what
the project has composed: the ADOPTED set (ADR-0019 composition) JOINED with the TAILORING overlays
(ADR-0021), the ADJUDICATION choices (ADR-0020), and each entry's pinned `version`/`commit` (from the
catalog record / `sources.lock`), plus a DETERMINISTIC content `hash` over the resolved entries. It is the
project analogue of `package-lock.json`: a git-committable manifest at the project root that lets a
checkout (and CI, and a teammate) reproduce — and DIFF — the same composition.

```jsonc
{
  "schema": "forge.lock.v1",
  "version": 1,
  "generatedAt": "2026-06-09T00:00:00Z",   // ISO-8601 from the CLI runtime clock; NEVER feeds the hash
  "hash": "a1b2c3d4",                       // deterministic digest over the canonical entries (§3)
  "entries": [
    {
      "uid": "skill:code-review",            // the resource uid "<kind>:<id>" (ADR-0005)
      "sourceId": "acme-skills",             // the source it was adopted from, or null (library-local)
      "kind": "skill",                       // the resource kind (JOINED from the catalog record)
      "version": "v3.2.0",                   // resolved version (a `pin` overlay wins, else the record version)
      "commit": "9f1c…",                     // the pinned source commit (from sources.lock), or null
      "overlays": [                          // the ADR-0021 overlays for this (uid, sourceId), sorted
        { "type": "override", "detail": "model → opus" },
        { "type": "pin", "detail": "v3.2.0" }
      ],
      "adjudication": "acme-skills"          // the recorded winner sourceId for this uid, or null (none/library)
    }
  ]
}
```

- `entries` is the resolved set: one entry per composed `(uid, sourceId)` in the project's composition,
  with its overlays, adjudication winner, and pins JOINED in. It is the resolved whole — the composition,
  tailoring, and adjudication stores remain the irreducible inputs.
- `forge.lock` lives at `<activeRoot>/forge.lock` (the project root), NOT under `.forge/` and NOT in the
  git-tracked library. It is intended to be COMMITTED (like `package-lock.json`).

### 2. `forge.lock` is DISTINCT from `.forge/sources.lock`

The two lockfiles answer different questions and never merge:

| | `.forge/sources.lock` (ADR-0017 §2.2) | `forge.lock` (this ADR) |
|---|---|---|
| schema | `forge.sources.lock.v1` | `forge.lock.v1` |
| pins | each SOURCE's resolved git `commit` | the resolved PROJECT COMPOSITION (adopted + overlays + adjudication + pins) |
| location | `.forge/sources.lock` (under `.forge/`) | `<activeRoot>/forge.lock` (project root) |
| git | machine-local, NEVER committed (the cache lives outside any work tree, ADR-0010 / C6) | git-committable (committed, like `package-lock.json`) |
| owner | `manager/source.mjs` (`forge source sync`) | `manager/lock.mjs` (`forge lock …`) |

`forge.lock` CONSUMES `sources.lock`'s per-entry `commit` (the pinned source sha) as one input — that is
the only relationship. It does not replace, extend, or modify `sources.lock`.

### 3. The content `hash` is deterministic and EXCLUDES `generatedAt`

`hash` is a deterministic digest (sha256, first 8–16 hex via `node:crypto`) computed over the CANONICAL
resolved entries:

- entries are sorted by `uid`, then `sourceId` (the same deterministic order ADR-0019's `compose list`
  uses); each entry's `overlays` are sorted (by `type`, then `detail`);
- the digest is taken over a stable serialization of that canonical set (the resolved fields:
  `uid`, `sourceId`, `kind`, `version`, `commit`, sorted `overlays`, `adjudication`);
- `generatedAt` is **EXCLUDED** from the digest.

Therefore the SAME composition yields the SAME hash across machines and across times — `generatedAt`
differs run-to-run, but the hash does not. Re-writing an unchanged composition is idempotent: same
entries → same hash. This is what lets two checkouts (or a CI run) assert "we resolved the same thing"
without comparing timestamps. `generatedAt` is an ISO-8601 timestamp from the CLI runtime clock (the
standard JS `Date` API is available in the CLI itself; only Workflow scripts forbid it) — it is recorded
for humans and is the ONE field the hash ignores.

### 4. `lock write` is MANIFEST-ONLY — it never materializes `.claude/`

`forge lock write` RESOLVES the composition (§1) and, on `--apply`, writes `<activeRoot>/forge.lock`
atomically (`manager/lib/store.mjs`). It writes ONLY that manifest. It MUST NOT:

- generate, materialize, or modify any real `.claude/` file (agents, skills, commands, rules, hooks, …);
- write or mutate the git-tracked LIBRARY or any resource content;
- run the admission pipeline, the read-view, dedup, the judge, or any model;
- modify the composition, adjudication, or tailoring stores it READS.

Materializing the resolved composition into a project's `.claude/` tree — writing the pinned version, the
overridden frontmatter, the layered fragment, the fork — is the EXISTING bootstrap composer's job and is
EXPLICITLY OUT OF SCOPE (§7). `forge.lock` is the manifest that future step will CONSUME; producing it does
not perform it. Preview by default, write on `--apply`, fail-open at the boundary — the same contract
ADR-0018/0019/0020/0021 set.

### 5. The resolved whole is DERIVED by reusing the existing read helpers

The operator builds `entries` by JOINING the existing per-project stores, REUSING their read helpers
rather than duplicating any logic:

- **the adopted set + kind + version** from `manager/compose.mjs` (`compose list`, ADR-0019);
- **the overlays + the resolved (pin) version** from `manager/tailor.mjs` (`tailor list`, ADR-0021) — a
  `pin` overlay wins the resolved `version`, else the catalog record version (the §3 folding);
- **the adjudication choices** (the recorded winner sourceId per uid) from `manager/conflict.mjs`
  (`conflict list` / the adjudication store, ADR-0020);
- **each entry's pinned source `commit`** from the catalog record / `.forge/sources.lock` (ADR-0017 §2.2).

`forge.lock` is the ONLY place the resolved whole is persisted; everything in it is reproducible from those
inputs, which is why the lockfile carries a content hash rather than becoming a new source of truth (the
same derived-not-authoritative discipline ADR-0018/0019/0020/0021 used for slices, the composition join,
the conflict set, and the resolved preview). The operator invokes NO model.

### 6. CLI surface — the `lock` verb group (`manager/lock.mjs`)

A new verb group mirroring the `compose`/`conflict`/`tailor` operator idiom (dry-run by default, `--apply`
to write, C3-envelope output via `manager/lib/json-out.mjs`, findings via `manager/lib/findings.mjs`,
fail-open at the boundary). Module contract: `run(subcmd, args, ctx) -> { ok, data, findings, summary }`,
dispatched from `bin/forge.mjs` via a `LOCK_VERBS` set + a `lockUsage()` banner next to `TAILOR_VERBS`.

- `forge lock show [--json]` → `data { lockPath, exists, lock:<forge.lock contents>|null, committed,
  inSync }`. Read-only. `committed` is a best-effort "is `forge.lock` tracked by git?" (else `false`);
  `inSync` is `true` iff the current file's `hash` equals a freshly-resolved hash (§3).
- `forge lock write [--apply]` → RESOLVE the composition (§5), compute `entries` + `hash` (§3), and on
  `--apply` write `<activeRoot>/forge.lock` atomically. Preview (no `--apply`) returns the would-be lock
  without writing. Additive/idempotent: re-writing an unchanged composition yields the same hash. NEVER
  touches `.claude/` (§4).
- `forge lock diff [--json]` → `data { changes:[ { op:"~"|"+"|"-", uid, sourceId, from?, to?, note? } ],
  summary }` comparing the CURRENT `forge.lock` against the freshly-resolved composition (what `write`
  would produce). `"+"` = newly resolved entry not in the lock; `"-"` = in the lock but no longer resolved;
  `"~"` = version / overlay / adjudication changed. This is the "bump & re-resolve" / diff-on-update
  preview.

It REUSES the compose/tailor/conflict read helpers and the catalog record production; it reimplements no
scanning, read-view, dedup, adoption, conflict, or tailoring logic, and it invokes NO model.

### 7. Seams left / not built now

- **Materialization (the bootstrap composer).** Applying the resolved `forge.lock` into a project's real
  `.claude/` tree — writing the pinned version, the overridden frontmatter, the layered fragment, the fork,
  reconciled against what is already on disk — is the EXISTING bootstrap composer's job. This slice produces
  the manifest the composer will CONSUME; it does not perform the materialization. OUT OF SCOPE here, by the
  locked fork.
- **Lock-driven CI / drift gates.** A future check could fail CI when `forge.lock` is stale
  (`inSync === false`) or uncommitted; this ADR ships the `show`/`diff` signals that such a gate would read,
  but builds no gate.

## Consequences

**Positive**
- A project gets a single, resolved, git-committable statement of exactly what it composed — the adopted
  set folded with its overlays, adjudication choices, and pins — the project analogue of `package-lock.json`
  and the resolved whole the composition/tailoring/adjudication stores each held one slice of.
- The deterministic content hash (excluding `generatedAt`) lets two machines / a CI run agree they resolved
  the same composition by comparing one short digest, not three stores; `inSync` and `diff` make staleness
  honest and a re-resolve previewable.
- Manifest-only keeps the irreversible/disk-touching half (materializing `.claude/`) with the bootstrap
  composer behind a deliberate boundary; producing the lockfile is cheap, reversible, and reproducible from
  its inputs.
- `forge.lock` is DERIVED (a JOIN over existing stores), so it adds no new authoritative state — it is the
  one persisted artifact because a committable hash is the point, not because the data is irreducible.
- Keeping it DISTINCT from `.forge/sources.lock` preserves the clean split between "where the source bytes
  came from" (machine-local, never committed) and "what the project resolved" (committed) — neither lockfile
  is overloaded.

**Negative**
- A sixth per-project on-disk shape now exists (`forge.lock`) alongside the source manifest, the
  `sources.lock`, the subscription set, the composition, the adjudication, and the tailoring stores — but it
  is the one the project commits, and the only resolved whole.
- The lock can go STALE relative to its inputs (a later `compose adopt`, `tailor add`, or `conflict resolve`
  makes `inSync === false`); the project must `lock write --apply` to re-resolve. `lock diff` makes the
  staleness explicit, and the hash makes "did anything actually change" answerable.

**Neutral**
- The resolved whole is DERIVED, not a new authority: deleting `forge.lock` loses only the committed
  fingerprint — `lock write` rebuilds it from the composition/tailoring/adjudication stores (the same
  derived-not-authoritative reasoning ADR-0018/0019/0020/0021 used).
- The lockfile is a resolution/manifest concern over the composition; it does NOT change ADMISSION
  (ADR-0017), the read-view (ADR-0018), the composition (ADR-0019), adjudication (ADR-0020), tailoring
  (ADR-0021), dedup, or the judge — those are untouched. Identity stays `contentHash` (ADR-0005); provenance
  stays the minimal `source` object (ADR-0009); the lockfile references resources by `(uid, sourceId)` and
  copies no bytes.

## Alternatives considered

- **Make `forge.lock` an extension of `.forge/sources.lock` (one lockfile).** Rejected (LOCKED fork:
  distinct lockfiles): the two answer different questions — `sources.lock` pins where SOURCE bytes came from
  (machine-local, never committed, ADR-0017 §2.2 / ADR-0010 / C6), `forge.lock` records what the PROJECT
  resolved (git-committable). Merging them would either leak the project resolution into a machine-local
  uncommitted file or pull synced commits into a committed one, overloading both. They share only that
  `forge.lock` CONSUMES `sources.lock`'s per-entry commit.
- **Include `generatedAt` in the content hash.** Rejected (LOCKED fork: hash excludes the timestamp): a
  timestamped hash would differ on every write of an UNCHANGED composition, defeating the entire point of a
  reproducible fingerprint two machines can compare. The hash is over the canonical resolved entries only;
  `generatedAt` is recorded for humans and ignored by the digest.
- **Materialize the composition into `.claude/` as part of `lock write`.** Rejected (LOCKED fork:
  manifest-only): writing the pinned version / overridden frontmatter / layered fragment into real `.claude/`
  files is an irreversible, on-disk, reconciliation-heavy step that belongs to the EXISTING bootstrap
  composer (§7), not to lockfile production. `lock write` records the resolved manifest the composer will
  consume; folding apply in would put a writer on the hot path and erase the manifest/apply boundary the rest
  of the stack keeps (ADR-0021 §1/§7).
- **Store the resolved entries inside the composition (extend `composition.json`).** Rejected: the resolved
  whole is a JOIN over THREE stores (composition + tailoring + adjudication) plus pins; folding it back into
  one would couple concerns that evolve independently and force every composition reader to understand
  overlays, choices, and pins. `forge.lock` is a SEPARATE manifest (the same separation ADR-0020 used for
  `adjudication.json` and ADR-0021 for `tailoring.json`).
- **Don't persist the lockfile at all — recompute the resolved whole on demand (no file).** Rejected: the
  whole point is a git-committable artifact a checkout / CI / teammate can DIFF and reproduce, and a content
  hash they can compare. A purely derived view (like the conflict set or the resolved preview) cannot be
  committed or diffed against a prior resolution. The lockfile is the one resolved whole that IS persisted —
  precisely because the committable hash is the value.
- **Re-run the judge / re-resolve sources during `lock write`.** Rejected: the operator is a deterministic
  JOIN that CONSUMES already-recorded choices and pins (METHOD §7's deterministic-collection half, the same
  discipline ADR-0020 used for the conflict set); producing verdicts stays with the admission/judge path and
  pinning source commits stays with `forge source sync`. `lock write` invokes no model and resolves no remote.

## Related

- ADR-0005 (contentHash is the sole identity primitive — lock entries reference uids `"<kind>:<id>"`; the
  lockfile copies no bytes and changes no identity)
- ADR-0009 (marker provenance via a single minimal field — lock entries reference the minimal `source`
  provenance via `(uid, sourceId)` + the pinned `commit`, and duplicate none of it)
- ADR-0010 (fleet opt-in machine-local cache — the git-tracked-truth-vs-machine-local-cache split / C6 that
  keeps `.forge/sources.lock` uncommitted, the contrast `forge.lock` commits against)
- ADR-0017 (federated catalog — the SOURCE lockfile `.forge/sources.lock` (`forge.sources.lock.v1`,
  catalog.md §2.2) `forge.lock` is DISTINCT from but CONSUMES the per-entry `commit` of; the catalog record
  production the JOIN reuses)
- ADR-0018 (slices + per-project subscriptions — the read-view that gates what can be adopted, hence what is
  in the lock)
- ADR-0019 (per-project composition — the adopted set keyed by `(uid, sourceId)` the lock resolves; the §7
  seam this ADR fills; the `manager/compose.mjs` read helpers the JOIN reuses)
- ADR-0020 (conflict adjudication — the recorded human choices the lock folds in as each entry's
  `adjudication` winner; the §7 seam this ADR fills; the `manager/conflict.mjs` read helpers reused)
- ADR-0021 (tailoring overlays — the overlays + resolved (pin) version the lock folds in; the §7 seam this
  ADR fills; the `manager/tailor.mjs` read helpers reused; the manifest/apply boundary this mirrors)
- docs/specs/catalog.md §"Project lockfile" + BR-CAT-017.. (the normative rules)
- docs/METHOD.md §7 (deterministic collection — the JOIN is collection only; it produces no verdict and runs
  no model)
- schemas/lock.schema.json (the `forge.lock` shape)
- manager/lock.mjs (the lockfile operator: show/write/diff), manager/compose.mjs / manager/tailor.mjs /
  manager/conflict.mjs (the read helpers the JOIN reuses), manager/catalog.mjs (the catalog record production
  it reuses), manager/lib/store.mjs (atomic, additive persistence)
