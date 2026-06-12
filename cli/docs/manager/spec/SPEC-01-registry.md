# SPEC-01 — Registry & inventory

Status: design-stage · Phase: v0.2 · Implements: BR-REG-001..010 · Decided-by: ADR-0005, ADR-0006,
ADR-0008, ADR-0014

## Summary

The registry is the manager's spine: a **generated** catalog of every harness artifact, keyed by
`uid = "<kind>:<id>"`, carrying identity (`contentHash`/`revision`/`version`), `status`, `criticality`,
the `modules[]` reverse-index, the `dependsOn[]` graph slot (SPEC-03), and an `eval{}` linkage slot. It
lives git-tracked at `forge/.forge/registry.json` with an append-only `registry.log.jsonl` audit trail. It
is **never hand-edited**: `forge registry build` scans the library and writes it; `lint/validate-registry.mjs`
rebuilds in memory and ERRORs if the committed copy is stale. The registry fixes the `VERSION` triple-drift
(`0.1.0-design`/`0.1.0`/`0.1.0`) by reading version from one place.

## Design

**Scan surface (BR-REG-003).** `build` walks: `agents/`, `skills/`, `commands/`, `rules/` (any depth),
`bundles/`, validators in `lint/`, meta-tests in `tests/meta/`, engine scripts under `bootstrap/`, and
hooks declared in `hooks/hooks.json`. Kind→path resolution reuses `validate-manifests.mjs`'s mapping,
extracted to shared libs so the registry and the composition validator can never disagree:

- `forge/manager/lib/resolve-kind.mjs` — the `componentCandidates(kind,name)` mapping plus the inverse
  (path → `{kind,id}`) for scanning; hook resolution against `hooks/hooks.json` ids (the
  `loadDeclaredHookIds()` logic).
- `forge/manager/lib/frontmatter.mjs` — parse YAML-ish frontmatter (`owner`, `description`, `tags`,
  `criticality`, optional advisory `version:`), tolerant of unknown keys (BR-VER-008).
- `forge/manager/lib/hash.mjs` — the single `sha256hex(bytes)` (ADR-0005), shared with `bin/forge.mjs`.

**Record assembly.** For each discovered artifact: compute `contentHash` (raw file bytes; for a hook, the
canonical JSON of its `hooks.json` entry — ADR-0005); read frontmatter for `owner`/`description`/`tags`/
`criticality`; set `modules[]` by reverse-indexing `manifests/modules.json` (`module → components` becomes
`uid → [modules]`); set `dependsOn[]` from SPEC-03 (empty until v0.3); carry `version`/`revision` forward
from the committed record (or seed `revision: 1`, `version: "0.1.0"` for a new artifact — BR-VER-001).

**Status (BR-REG-005).** `active` (default for an on-disk, in-module artifact); `planned` (named in a
manifest, no file — the `validate-manifests` "(planned)" set); `experimental`/`deprecated` from
frontmatter. **Orphan** (on disk, in no module) is a *flag*, not a status; SPEC-03 refines it with the
inbound-edge test (BR-DEP-006).

**Staleness (BR-REG-002, ADR-0008).** Because `forge install` symlinks the library live, content changes
with no event. `validate-registry` therefore rebuilds in memory and compares to the committed
`registry.json`, **split by the kind of drift**:

- **Structural drift → ERROR.** A uid was added or removed, OR a shared artifact's structural identity
  (`{kind,id,path,status,modules}`) changed. The committed catalog is wrong → ERROR
  `"registry stale, run forge registry build --write"`, exit 1.
- **Content-only drift → advisory WARN.** Same structural identity, but the committed `contentHash` no
  longer equals the fresh-scan hash → advisory WARN (the bump gate, SPEC-02), exit 0 (non-strict); never an
  ERROR.

It additionally asserts the `VERSION` triple (BR-REG-008) and the advisory bump/drift gates (SPEC-02).

**Determinism (BR-REG-006).** Records sorted by `uid`; object keys emitted in a fixed order; timestamps
(`createdAt`/`updatedAt`) preserved from the committed record when content is unchanged, so two builds of
an unchanged tree are byte-identical and append no log line.

## Data structures

`forge/.forge/registry.json`:

```jsonc
{
  "schemaVersion": 1,
  "VERSION": "0.1.0",                       // mirror; authority + drift check in SPEC-02
  "generatedAt": "2026-06-05T00:00:00Z",
  "artifacts": [
    {
      "uid": "agent:code-reviewer",
      "kind": "agent",                      // agent|skill|command|rule|hook|bundle|validator|meta-test|engine
      "id": "code-reviewer",
      "path": "agents/code-reviewer.md",    // for hooks: "hooks/hooks.json#<id>"
      "contentHash": "<64-hex sha256>",     // ADR-0005
      "revision": 1,                        // monotonic int (BR-VER-001)
      "version": "0.1.0",                   // semver intent (BR-VER)
      "status": "active",                   // active|deprecated|experimental|planned
      "criticality": "normal",              // safety|compliance|normal — stored, owned by Bundle D (ADR-0013)
      "owner": "forge",
      "description": "…",
      "tags": ["review"],
      "modules": ["review"],                // reverse-index of modules.json
      "dependsOn": [],                      // uids; SPEC-03 (v0.3)
      "eval": {},                           // linkage slot; payload owned by Bundle E
      "createdAt": "2026-06-05T00:00:00Z",
      "updatedAt": "2026-06-05T00:00:00Z"
    }
  ],
  "danglingRefs": []                        // SPEC-03 (v0.3)
}
```

`forge/.forge/registry.log.jsonl` — one line per mutation (BR-REG-007):

```jsonc
{"ts":"…","uid":"agent:code-reviewer","from":{"hash":"…","rev":1,"ver":"0.1.0"},"to":{"hash":"…","rev":2,"ver":"0.2.0"},"reason":"bump --minor","evalStatus":"U"}
```

## CLI / interface

```
forge registry build [--write]            # scan; dry-run unless --write (C4)
forge registry ls [--kind <kind>]         # list records (read-only)
forge registry show <uid>                 # one record + its changelog (read-only)
forge registry changed [--since <ref>]    # uids whose revision advanced since <ref> (read-only)
forge registry diff <refA> <refB>         # record-level diff between two registry states (read-only)
```

`lint/validate-registry.mjs [--strict] [root]` — auto-discovered (ADR-0014). Emits `{level,path,line,
message,source:"validate-registry"}` (C2). Errors: **structurally** stale registry (uid added/removed or a
changed `{kind,id,path,status,modules}`). Warns: VERSION triple drift (SPEC-02), content-only bump gate
(SPEC-02), dangling refs (SPEC-03, ERROR under `--strict`).

Module contract (C4): `forge/manager/registry.mjs` exports `run(subcmd,args,ctx)` + `summarize(state)`;
all state I/O via `manager/lib/store.mjs`; fail-open; dry-run by default.

## Edge cases & failure modes

- **Malformed/unreadable artifact** — fail-open (BR-REG-010): record a single finding, skip the file,
  continue. The build never aborts on one bad file.
- **Planned component (no file)** — `status: "planned"`, not an error (BR-REG-005); matches
  `validate-manifests`'s "(planned)" behavior so a design-stage tree is clean.
- **Hook with no `hooks.json` entry** — recorded `planned` (mirrors the manifests validator), not a file
  miss.
- **First-ever build (no committed registry)** — every artifact is new: `revision: 1`, seeded timestamps;
  `validate-registry` cannot be "stale" against a non-existent file, so it reports "uncommitted registry —
  run build --write" as a WARN.
- **Empty asset dirs** (today's tree) — scan yields mostly `planned` records; deterministic and non-empty
  because manifests name components.

## Open questions

- Should `meta-test` and `engine` artifacts carry `criticality` by default `compliance` (they gate the
  harness)? Deferred to Bundle D (ADR-0013) — registry only *stores* the value.
- `diff <refA> <refB>` against git refs requires reading a historical `registry.json`; v0.2 may restrict
  `diff` to the committed-vs-working pair and defer arbitrary-ref diff to v0.3.

## Traceability

Implements BR-REG-001..010. Decided by ADR-0002, ADR-0003, ADR-0005, ADR-0006, ADR-0008, ADR-0013,
ADR-0014, ADR-0015. Verified by EVAL-REG-001..010. Cross-refs: SPEC-02 (versioning fields), SPEC-03
(`dependsOn`/`danglingRefs`/orphans), Bundle F BR-INT (storage + module contract), Bundle E (eval slot).
