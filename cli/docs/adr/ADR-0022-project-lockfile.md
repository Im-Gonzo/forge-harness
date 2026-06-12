# ADR-0022: Project lockfile (the resolved composition manifest)

Status: Accepted (design-stage)
Date: 2026-06-09
Phase: v0.7+ (Slice 5 — the resolved per-project lockfile `forge.lock`; MANIFEST-ONLY, materialization stays the bootstrap composer's job)

> **Release-facing copy.** This is the project-lockfile decision as cited by the shipped harness assets and
> the `lock` CLI verb group (`manager/lock.mjs`). The full design-stage record — alternatives considered,
> locked forks, and the manager corpus cross-references — lives in
> [docs/manager/adr/ADR-0022-project-lockfile.md](../manager/adr/ADR-0022-project-lockfile.md). The companion
> SPEC section is [docs/specs/catalog.md](../specs/catalog.md) §"Project lockfile".

## Context

ADR-0019 added the per-project COMPOSITION (the adopted set keyed by `(uid, sourceId)`), ADR-0020 recorded
the adjudication policy + human CHOICES, and ADR-0021 added per-adopted-resource TAILORING OVERLAYS + a
resolved preview. Each holds one irreducible slice of intent; all three named the same open seam (ADR-0019
§7, ADR-0020 §7, ADR-0021 §7): **what is the single, resolved, git-committable statement of exactly what
this project composed — the adopted set FOLDED with its overlays, adjudication choices, and pins, plus a
deterministic fingerprint two machines can agree on?** This ADR defines that: **`forge.lock`, the project
lockfile** — the project analogue of `package-lock.json`, committed at the project root.

`forge.lock` is DISTINCT from `.forge/sources.lock`: one pins where SOURCE *bytes* came from (machine-local,
never committed, ADR-0017 §2.2 / ADR-0010 / C6), the other records what the *project* resolved
(git-committable). `forge.lock` CONSUMES `sources.lock`'s per-entry commit as one input; it does not merge
with or replace it.

Three forks were locked before this ADR:

- **`forge.lock` is the PROJECT lockfile, DISTINCT from `.forge/sources.lock`.** It lives at the active
  project root (`<activeRoot>/forge.lock`), is git-committable, and records the RESOLVED COMPOSITION.
- **`lock write` is MANIFEST-ONLY — it never touches `.claude/`.** It writes ONLY `forge.lock`. Materializing
  the composition into a project's real `.claude/` tree is the EXISTING bootstrap composer's job and is OUT OF
  SCOPE here (a documented future step).
- **The content hash is DETERMINISTIC and EXCLUDES `generatedAt`.** A digest over the CANONICAL resolved
  entries (sorted, overlays sorted, the timestamp excluded), so the SAME composition yields the SAME hash
  across machines and times.

## Decision

### 1. `forge.lock` is the RESOLVED COMPOSITION manifest

The lockfile (`forge.lock`, `forge.lock.v1`) is the single resolved statement of what the project composed:
the ADOPTED set (ADR-0019) JOINED with the TAILORING overlays (ADR-0021), the ADJUDICATION choices
(ADR-0020), and each entry's pinned `version`/`commit` (catalog record / `sources.lock`), plus a
DETERMINISTIC content `hash`. It lives at `<activeRoot>/forge.lock` (the project root, NOT under `.forge/`),
git-committable like `package-lock.json`:

```jsonc
{
  "schema": "forge.lock.v1",
  "version": 1,
  "generatedAt": "2026-06-09T00:00:00Z",   // ISO-8601 from the CLI runtime clock; NEVER feeds the hash
  "hash": "a1b2c3d4",                       // deterministic digest over the canonical entries (§3)
  "entries": [
    { "uid": "skill:code-review", "sourceId": "acme-skills", "kind": "skill",
      "version": "v3.2.0", "commit": "9f1c…",
      "overlays": [ { "type": "override", "detail": "model → opus" }, { "type": "pin", "detail": "v3.2.0" } ],
      "adjudication": "acme-skills" }
  ]
}
```

`entries` is the resolved set — one entry per composed `(uid, sourceId)` with its overlays, adjudication
winner, and pins JOINED in. The composition/tailoring/adjudication stores remain the irreducible inputs.

### 2. `forge.lock` is DISTINCT from `.forge/sources.lock`

| | `.forge/sources.lock` (ADR-0017 §2.2) | `forge.lock` (this ADR) |
|---|---|---|
| schema | `forge.sources.lock.v1` | `forge.lock.v1` |
| pins | each SOURCE's resolved git `commit` | the resolved PROJECT COMPOSITION |
| location | `.forge/sources.lock` | `<activeRoot>/forge.lock` (project root) |
| git | machine-local, NEVER committed (C6) | git-committable (committed) |
| owner | `manager/source.mjs` (`forge source sync`) | `manager/lock.mjs` (`forge lock …`) |

`forge.lock` CONSUMES `sources.lock`'s per-entry `commit` as one input; that is the only relationship.

### 3. The content `hash` is deterministic and EXCLUDES `generatedAt`

`hash` is a deterministic digest (sha256, first 8–16 hex via `node:crypto`) over the CANONICAL resolved
entries: entries sorted by `uid` then `sourceId`, each entry's `overlays` sorted, the digest taken over the
resolved fields (`uid`, `sourceId`, `kind`, `version`, `commit`, sorted `overlays`, `adjudication`) — with
`generatedAt` EXCLUDED. The SAME composition yields the SAME hash across machines and times; re-writing an
unchanged composition is idempotent. `generatedAt` is an ISO-8601 timestamp from the CLI runtime clock (the
standard JS `Date` API is available in the CLI; only Workflow scripts forbid it), recorded for humans and
the ONE field the hash ignores.

### 4. `lock write` is MANIFEST-ONLY — it never materializes `.claude/`

`forge lock write` resolves the composition and, on `--apply`, writes `<activeRoot>/forge.lock` atomically
(`manager/lib/store.mjs`). It writes ONLY that manifest. It MUST NOT generate/materialize/modify any real
`.claude/` file, the git-tracked library, or any resource content; MUST NOT run the admission pipeline, the
read-view, dedup, the judge, or any model; and MUST NOT modify the composition, adjudication, or tailoring
stores it READS. Materializing the resolved composition into a project's `.claude/` tree is the EXISTING
bootstrap composer's job and is OUT OF SCOPE (§7). Preview by default, write on `--apply`, fail-open — the
contract ADR-0018/0019/0020/0021 set.

### 5. The resolved whole is DERIVED by reusing the existing read helpers

`entries` is a JOIN over the existing stores, REUSING their read helpers: the adopted set + kind + version
from `manager/compose.mjs` (ADR-0019); the overlays + resolved (pin) version from `manager/tailor.mjs`
(ADR-0021, a `pin` wins the version, else the record version); the adjudication choices from
`manager/conflict.mjs` (ADR-0020); each entry's pinned source `commit` from the catalog record /
`.forge/sources.lock` (ADR-0017 §2.2). `forge.lock` is the ONLY place the resolved whole is persisted —
everything in it is reproducible from those inputs, which is why it carries a content hash rather than
becoming a new source of truth (the derived-not-authoritative discipline ADR-0018/0019/0020/0021 used). It
invokes NO model.

### 6. CLI surface — the `lock` verb group (`manager/lock.mjs`)

Mirrors the `compose`/`conflict`/`tailor` operator idiom (dry-run by default, `--apply` to write,
C3-envelope output, findings, fail-open). Contract `run(subcmd, args, ctx) -> { ok, data, findings, summary }`,
dispatched from `bin/forge.mjs` via a `LOCK_VERBS` set + `lockUsage()` next to `TAILOR_VERBS`:

- `forge lock show [--json]` → `data { lockPath, exists, lock:<forge.lock contents>|null, committed, inSync }`.
  Read-only. `committed` is best-effort "is `forge.lock` tracked by git?" (else `false`); `inSync` is `true`
  iff the current file's `hash` equals a freshly-resolved hash.
- `forge lock write [--apply]` → resolve the composition (§5), compute `entries` + `hash` (§3); on `--apply`
  write `<activeRoot>/forge.lock` atomically. Preview returns the would-be lock without writing.
  Additive/idempotent. NEVER touches `.claude/` (§4).
- `forge lock diff [--json]` → `data { changes:[ { op:"~"|"+"|"-", uid, sourceId, from?, to?, note? } ],
  summary }` comparing the CURRENT `forge.lock` against the freshly-resolved composition (what `write` would
  produce). `"+"` newly resolved; `"-"` no longer resolved; `"~"` version/overlay/adjudication changed. The
  "bump & re-resolve" preview.

It REUSES the compose/tailor/conflict read helpers + the catalog record production; reimplements no scanning,
read-view, dedup, adoption, conflict, or tailoring logic; invokes NO model.

## Consequences

- A project gets a single, resolved, git-committable statement of what it composed — the project analogue of
  `package-lock.json` and the resolved whole the composition/tailoring/adjudication stores each held one
  slice of.
- The deterministic content hash (excluding `generatedAt`) lets two machines / a CI run agree they resolved
  the same composition by comparing one short digest; `inSync` + `diff` make staleness honest and a
  re-resolve previewable.
- Manifest-only keeps materializing `.claude/` with the bootstrap composer behind a deliberate boundary
  (out of scope, §7); producing the lockfile is cheap, reversible, and reproducible from its inputs.
- `forge.lock` is DERIVED (a JOIN over existing stores), so it adds no new authoritative state — it is the
  one persisted artifact because a committable hash is the point.
- Keeping it DISTINCT from `.forge/sources.lock` preserves the split between "where the source bytes came
  from" (machine-local, never committed) and "what the project resolved" (committed).
- The lockfile is a resolution/manifest concern; it does NOT change ADMISSION (ADR-0017), the read-view
  (ADR-0018), the composition (ADR-0019), adjudication (ADR-0020), tailoring (ADR-0021), dedup, or the judge.
  Identity stays `contentHash` (ADR-0005); provenance stays the minimal `source` (ADR-0009).

## Related

- [docs/manager/adr/ADR-0022-project-lockfile.md](../manager/adr/ADR-0022-project-lockfile.md) — the full
  design-stage record (alternatives, locked forks, manager corpus xrefs).
- [docs/adr/ADR-0017-federated-catalog.md](./ADR-0017-federated-catalog.md) — the SOURCE lockfile
  `.forge/sources.lock` (`forge.sources.lock.v1`) `forge.lock` is DISTINCT from but CONSUMES the per-entry
  `commit` of.
- [docs/adr/ADR-0018-slices-and-subscriptions.md](./ADR-0018-slices-and-subscriptions.md) — the read-view
  that gates what can be adopted, hence what is in the lock.
- [docs/adr/ADR-0019-project-composition.md](./ADR-0019-project-composition.md) — the adopted set the lock
  resolves (the §7 seam this fills); the `compose` read helpers the JOIN reuses.
- [docs/adr/ADR-0020-conflict-adjudication.md](./ADR-0020-conflict-adjudication.md) — the recorded choices
  the lock folds in as each entry's `adjudication` winner; the `conflict` read helpers reused.
- [docs/adr/ADR-0021-tailoring-overlays.md](./ADR-0021-tailoring-overlays.md) — the overlays + resolved
  (pin) version the lock folds in; the `tailor` read helpers reused; the manifest/apply boundary this
  mirrors.
- [docs/specs/catalog.md](../specs/catalog.md) §"Project lockfile" + BR-CAT-017.. — the normative rules.
- `schemas/lock.schema.json` — the `forge.lock` shape.
- `manager/lock.mjs` (the lockfile operator), `manager/compose.mjs` / `manager/tailor.mjs` /
  `manager/conflict.mjs` (the read helpers the JOIN reuses), `manager/catalog.mjs` (the catalog record
  production), `manager/lib/store.mjs` (atomic, additive persistence).
