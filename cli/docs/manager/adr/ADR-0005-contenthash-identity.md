# ADR-0005: Artifact identity is `contentHash` (sha256) — the sole identity primitive

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.2

## Context

Forge today has exactly one notion of version: a single `VERSION` string (`0.1.0-design`) read from
`forge/VERSION`. There is no per-artifact identity, so the manager cannot answer "what changed since
vN?", "is this tailored project's copy of `code-reviewer` the current one?", or "is this eval still valid
for the artifact it scored?". Each of those questions needs a stable, content-derived fingerprint per
artifact, computed the same way everywhere.

Three constraints bound the choice:

1. **Zero runtime dependencies** (foundational invariant 1) — the primitive must come from `node:crypto`,
   not a hashing library.
2. **One shared hasher** — `bin/forge.mjs` already computes `sha256hex()` of marker file content
   (`createHash('sha256').update(s,'utf8')`), and `marker.schema.json` already stores checksums as
   `sha256:[0-9a-f]+`. A second, differently-normalized hash would silently diverge.
3. **Cross-dimension reuse** — fleet `sourceRev`, efficiency cache keys, and eval `pinnedHash` must all
   derive from the *same* number, or the dimensions disagree about "did this change?".

## Decision

**`contentHash` — `sha256` over an artifact's canonical bytes — is the only identity primitive in the
manager.** Everything else derives from it.

- Format: the stored string is `"<hex>"` (64 lowercase hex chars) in the registry's `contentHash` field;
  the marker keeps its existing `"sha256:<hex>"` checksum form. Both come from one helper,
  `forge/manager/lib/hash.mjs#sha256hex(bytes)`, extracted so `bin/forge.mjs` and every validator call the
  identical function (this matches the `createHash('sha256')` already in `bin/forge.mjs`).
- **Canonical bytes** are the raw UTF-8 file bytes for file-backed artifacts (agents, skills' `SKILL.md`,
  commands, rules, bundles, validators, engine scripts). For a hook (which is an *id* in `hooks/hooks.json`,
  not a file — see `validate-manifests.mjs`), the canonical bytes are the deterministic JSON serialization
  of that hook's entry (stable key order, no surrounding whitespace).
- **No identity is derived from path, mtime, or git sha.** Paths move; mtimes are not reproducible; git
  shas cover the whole tree, not one artifact. Only content decides identity.
- `revision` and `semver` (`ADR-0006`), fleet `sourceRev` (`SPEC-04`), and eval `pinnedHash` (`SPEC-07`)
  are **functions of `contentHash`**, never independent inputs.

## Consequences

**Positive**
- Drift detection is exact and dependency-free: recompute the hash, compare to the registry.
- The same fold that fixes `VERSION` drift (`ADR-0006`) has a well-defined input per artifact.
- Eval staleness ("was this score produced against the current bytes?") is a hash equality, not a guess.
- One hasher means fleet/efficiency/eval cannot disagree about change.

**Negative**
- A purely cosmetic edit (whitespace, a typo fix) changes the hash. Mitigated by `semver` carrying human
  intent (`PATCH`) on top of the hash, so cosmetic churn is *recorded* as cosmetic, not hidden.
- Canonicalization of the non-file hook case must be pinned precisely or two runs hash differently; the
  serialization rule above is normative (`BR-VER`).

**Neutral**
- The marker's `sha256:` prefix and the registry's bare-hex form coexist; both are the same digest, just
  printed differently. The shared helper exposes both renderings.

## Alternatives considered

- **git blob sha** — rejected: requires git to be present and clean, ties identity to a VCS, and a
  staged-but-uncommitted edit has no blob sha. Forge must work on a dirty tree.
- **mtime / size** — rejected: non-reproducible, trivially wrong on checkout, useless for "same content?".
- **A monotonic id assigned at first sight** — rejected as the *identity* primitive: it cannot detect that
  two artifacts have identical content, and it cannot survive a registry rebuild from scratch. (It survives
  as `revision`, a *derived ordering cursor* in `ADR-0006`, not as identity.)

## Related

ADR-0006 (versioning fold built on this), ADR-0008 (scan-on-demand recomputes the hash), C1 (identity
invariant), BR-REG, BR-VER, SPEC-01, SPEC-02.
