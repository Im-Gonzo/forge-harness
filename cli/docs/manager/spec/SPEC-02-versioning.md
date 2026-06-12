# SPEC-02 — Per-artifact versioning

Status: design-stage · Phase: v0.2 (triple + advisory drift) / v0.6 (roll-up automation) · Implements:
BR-VER-001..008 · Decided-by: ADR-0005, ADR-0006, ADR-0007, ADR-0008

## Summary

Each artifact carries a **three-part identity**: `contentHash` (machine truth, drives drift), `revision`
(monotonic integer, the ordering cursor), and `version` (semver, human intent). The global `VERSION`
stops being hand-maintained and becomes a **deterministic fold** over artifact revisions/hashes. The triple
`forge/VERSION` `0.1.0-design` / `package.json` `0.1.0` / `plugin.json` `0.1.0` is **aligned**, not drifted:
the `-design` pre-release suffix is stripped before comparison, so the core versions all read `0.1.0`. The
bump gate — "content changed but `revision` not bumped" — is **advisory
(WARN)**, because the live-symlink seam (ADR-0008) leaves no event to block on and a solo dev must not be
deadlocked (ADR-0007). An optional `version:` frontmatter key may mirror the registry for humans; the
registry wins on conflict.

## Design

**The triple (BR-VER-001).** `contentHash` is recomputed every scan (SPEC-01). `revision` advances by
exactly 1 only when a bump is *authored* — it is never auto-incremented by the scan, because the scan
cannot know whether a content change is "accepted". `version` is set by the human via the bump level.

**Semver levels (BR-VER-002).** MAJOR = behavior/contract; MINOR = additive; PATCH = cosmetic. The level
is the human's claim; no script verifies it (which is why the gate is advisory). Bundles' integer `version`
maps `N → "N.0.0"` (BR-VER-008) so all artifacts speak semver.

**Authoring a bump (BR-VER-003).** `forge registry bump <uid> --major|--minor|--patch`:
1. recompute `contentHash`; 2. `revision += 1`; 3. apply the semver level; 4. set `updatedAt`;
5. append one `registry.log.jsonl` line `{ts,uid,from{hash,rev,ver},to{hash,rev,ver},reason,evalStatus}`;
6. write `registry.json` (only with the implied `--write`; dry-run prints the planned change).

**The `VERSION` roll-up (BR-VER-004).** `forge registry roll-up` folds the sorted-by-`uid` list of
`{revision, contentHash}` into the next `VERSION`. The fold is **pure** (same tree → same `VERSION`). v0.2
ships only the *assertion* side (below); the *compute-and-write* automation is v0.6.

**Drift & gate checks in `validate-registry`:**
- **Triple drift (BR-VER-007 / BR-REG-008):** read `forge/VERSION`, `package.json.version`, and
  `plugin.json` version; the `-design` pre-release suffix is **stripped** from each (per
  `bin/forge.mjs#forgeVersion`) **before** the equality test, so `0.1.0-design` and `0.1.0` are the same
  release. **Drift = the stripped CORE versions differ** (e.g. `0.2.0` vs `0.1.0`); only then → **WARN**
  naming all three **raw** values. The real repo (`0.1.0-design` / `0.1.0` / `0.1.0`) is therefore aligned,
  not drifted. Promotable to ERROR once roll-up is authoritative (v0.6).
- **Bump gate (BR-VER-006) — content-only drift:** for each record with an **unchanged structural identity**
  (`{kind,id,path,status,modules}`), compare the committed `contentHash` to a fresh scan; if it differs AND
  `revision` is unchanged → **advisory WARN** `"<uid>: content changed but revision not bumped — run forge
  registry build --write"`. It is **never** escalated to a stale ERROR (that is structural drift, SPEC-01).
  Advisory: exit 0 under default; under `--strict` the WARN fails the exit like any other advisory finding.

**Per-artifact changelog (BR-VER-005).** Not a separate file — it is `registry.log.jsonl` filtered by
`uid`. `forge registry show <uid>` surfaces it.

## Data structures

Per-artifact version fields (subset of the SPEC-01 record):

```jsonc
{ "contentHash": "<64-hex>", "revision": 2, "version": "0.2.0" }
```

Log entry (the changelog unit):

```jsonc
{ "ts":"…", "uid":"agent:code-reviewer",
  "from": { "hash":"…", "rev":1, "ver":"0.1.0" },
  "to":   { "hash":"…", "rev":2, "ver":"0.2.0" },
  "reason":"bump --minor", "evalStatus":"U" }
```

Roll-up fold (reference shape, v0.6):

```
VERSION = fold( artifacts.sort(by uid).map(a => [a.revision, a.contentHash]) )
// pure: identical input list → identical VERSION
```

Optional advisory frontmatter (BR-VER-008), ignored by existing validators:

```yaml
version: 0.2.0   # mirrors registry semver; registry authoritative on conflict
```

## CLI / interface

```
forge registry bump <uid> --major|--minor|--patch   # author a bump: ++revision, set semver, +log line
forge registry roll-up                               # compute next global VERSION (v0.6; read-only preview earlier)
forge registry show <uid>                            # includes the filtered changelog
```

`lint/validate-registry.mjs` adds the **triple-drift WARN** and the **bump-gate WARN** (both advisory,
C5), in the standard finding shape with `source:"validate-registry"`.

## Edge cases & failure modes

- **Hash changed, revision changed, but no log line** — treated as registry corruption: ERROR (the bump
  path must always log; BR-VER-003).
- **`version:` frontmatter conflicts with registry** — registry wins (BR-VER-008); a WARN may note the
  mismatch but never fails a validator.
- **New artifact** — seeded `revision: 1`, `version: "0.1.0"`; not a "content changed but not bumped" WARN
  (there is no prior committed hash to compare).
- **`-design` suffix** — stripped before comparison so `0.1.0-design` and `0.1.0` are the **same** release
  (aligned, no finding). Only a difference in the stripped **core** version counts as drift; when it does,
  the WARN names the raw (un-stripped) values.
- **All three core versions agree (after strip)** — drift check returns clean (no finding).

## Open questions

- The exact fold function (e.g. derive PATCH from Σrevisions, MINOR/MAJOR from semver maxima) is left to
  v0.6 so it can be chosen against real change history; only its *purity* and *determinism* are pinned now.
- Should `roll-up` write back to all three files (`VERSION`, `package.json`, `plugin.json`) or only
  `VERSION` and let a separate sync mirror it? Carried to v0.6 with Bundle F (BR-INT).

## Traceability

Implements BR-VER-001..008. Decided by ADR-0005, ADR-0006, ADR-0007, ADR-0008. Verified by
EVAL-VER-001..008. Cross-refs: SPEC-01 (record fields, log, staleness), Bundle F (ADR-0007 advisory-gate
policy, BR-INT storage), C1, C5.
