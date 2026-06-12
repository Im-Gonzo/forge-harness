# ADR-0006: Versioning — `contentHash` + monotonic `revision` + `semver`; `VERSION` becomes a roll-up

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.2 (per-artifact triple + advisory drift); v0.6 (roll-up automation)

## Context

A single hand-maintained `VERSION` string cannot describe a harness of ~93 artifacts that change
independently. It also drifts: today `forge/VERSION` is `0.1.0-design` while `package.json` and
`plugin.json` both say `0.1.0` — three sources of one truth, already disagreeing. We need (a) machine
truth that drives drift detection, (b) a cheap ordering cursor, and (c) a human-meaningful statement of
*what kind* of change happened — and we need the global `VERSION` to stop being a thing a human keeps in
sync by hand.

The constraint from `ADR-0008` shapes this: forge installs the library by **live symlink**, so an
artifact's content can change with **no install event** to hang a version bump on. The scheme must work
when nobody told it a change happened.

## Decision

Every artifact carries a **three-part identity**, and the global `VERSION` becomes a **computed roll-up**.

1. **`contentHash`** (`ADR-0005`) — machine truth. Drives drift. Not human-facing.
2. **`revision`** — a **monotonic integer**, `+1` each time an artifact's `contentHash` change is
   *accepted* (a bump is authored). It is the cheap ordering cursor used by `changed --since` and the
   roll-up fold. It is **not** semver and never resets.
3. **`version`** — per-artifact **semver** `MAJOR.MINOR.PATCH`, the *human intent* of a change:
   - **MAJOR** — behavior/contract change (a reviewer's rubric changes; an agent's routing changes; a
     hook's decision changes). Consumers must re-read.
   - **MINOR** — additive (a new rule lane, a new section) that does not change existing behavior.
   - **PATCH** — cosmetic (typo, formatting, comment) with no behavioral effect.
4. **`VERSION` roll-up** — the global release version is a **deterministic fold** over artifact
   `revision`/`contentHash` pairs (sorted by `uid`), not a hand-edited string. `forge registry roll-up`
   computes the next `VERSION`; `validate-registry` asserts the committed `VERSION` equals the fold and
   equals `package.json.version` equals the `plugin.json` version, flagging today's drift.
5. **Authority** — on any conflict between the registry's `version` and an *optional* advisory `version:`
   frontmatter key on an artifact, **the registry wins** (`BR-VER`). The frontmatter is a human-readable
   mirror only.

## Consequences

**Positive**
- The `0.1.0-design`/`0.1.0`/`0.1.0` drift becomes a *detected, named* error instead of silent rot.
- "What changed since vN" is answerable by `revision` comparison; "what *kind* of change" by `semver`.
- The roll-up removes a manual sync step a solo dev forgets.

**Negative**
- Three fields per artifact is more bookkeeping than one string. Mitigated: `contentHash`/`revision` are
  machine-maintained; only `semver` asks for a human judgment, and only via `forge registry bump`.
- Semver intent (MAJOR vs MINOR) is a human call a script cannot fully verify; the bump *gate* is
  therefore advisory (`ADR-0007`), not enforced classification.

**Neutral**
- Bundles already carry an integer `version` (e.g. `1`); they map `N → "N.0.0"` so semver is uniform.
- The roll-up *automation* is deferred to v0.6; v0.2 ships the per-artifact triple and the drift WARN.

## Alternatives considered

- **Semver only (drop `revision`)** — rejected: semver alone can't order two changes that a human labels
  the same level, and `changed --since` needs a total order. `revision` supplies it cheaply.
- **Hash only (drop semver)** — rejected: a hash can't tell a typo fix from a contract change; the human
  signal (the whole point of "did the behavior change?") is lost.
- **Keep hand-maintained `VERSION`** — rejected: it is *already* drifted three ways; this ADR exists to
  fix exactly that.

## Related

ADR-0005 (the hash this folds over), ADR-0007 (the bump gate is advisory), ADR-0008 (why scan-based),
C1, C5, BR-VER, BR-REG, SPEC-02, SPEC-01.
