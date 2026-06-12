# Business Rules — Per-artifact versioning (BR-VER)

> The normative rules for the three-part identity (`contentHash` + `revision` + `semver`), the `VERSION`
> roll-up, the per-artifact changelog, and the **advisory** bump gate. Decided by ADR-0005, ADR-0006,
> ADR-0007, ADR-0008; detailed by SPEC-02; stored by the registry (BR-REG). **Phase: v0.2** (triple +
> advisory drift) unless a rule notes **v0.6** (roll-up automation).

### BR-VER-001 — Three-part identity per artifact

**Rule:** Every artifact MUST carry all three: `contentHash` (sha256, machine truth, drives drift —
ADR-0005), `revision` (monotonic integer, `+1` per **accepted** hash change, the ordering cursor), and
`version` (semver `MAJOR.MINOR.PATCH`, human intent). None may be omitted; `revision` MUST NOT reset.
**Rationale:** Hash alone can't tell cosmetic from contract change; semver alone can't totally order
changes; the cursor alone can't detect identical content. All three are needed (ADR-0006).
**Acceptance:** Each registry record exposes a numeric `revision`, a valid semver `version`, and a 64-hex
`contentHash`; a fresh artifact starts at `revision: 1`, `version: "0.1.0"` (or its mapped bundle value) —
`EVAL-VER-002`.
**Priority:** MUST
**Refs:** ADR-0005, ADR-0006, SPEC-02, BR-REG

### BR-VER-002 — Semver level semantics

**Rule:** A `version` bump MUST mean: **MAJOR** = behavior/contract change (rubric, routing, hook
decision); **MINOR** = additive, behavior-preserving; **PATCH** = cosmetic (typo, formatting, comment).
`forge registry bump <uid> --major|--minor|--patch` MUST be the only authorized authoring path.
**Rationale:** Consumers (and the fleet drift query) need to know whether a change forces a re-read; the
level is the human signal a hash cannot carry.
**Acceptance:** `bump <uid> --minor` increments the middle semver field and leaves MAJOR unchanged;
`--major` zeroes MINOR/PATCH; `--patch` increments only PATCH — `EVAL-VER-003`.
**Priority:** MUST
**Refs:** ADR-0006, SPEC-02

### BR-VER-003 — `bump` increments revision and logs

**Rule:** `forge registry bump <uid>` MUST `+1` the artifact's `revision`, set the new `version` per the
level flag, update `contentHash`/`updatedAt`, and append one `registry.log.jsonl` entry
`{ts, uid, from{hash,rev,ver}, to{hash,rev,ver}, reason, evalStatus}`.
**Rationale:** A bump is the *acceptance* of a content change; revision and the log advance together so the
per-artifact changelog (BR-VER-005) is complete.
**Acceptance:** After `bump <uid> --patch`, the record's `revision` is `+1`, its `version` PATCH `+1`, and
exactly one log line records the `from`/`to` triple — `EVAL-VER-004`.
**Priority:** MUST
**Refs:** ADR-0006, SPEC-02, BR-REG

### BR-VER-004 — `VERSION` is a deterministic roll-up

**Rule:** The global `VERSION` MUST be a **deterministic fold** over artifact `{revision, contentHash}`
pairs (sorted by `uid`), not a hand-maintained string. `forge registry roll-up` MUST compute the next
`VERSION`; the fold MUST be pure (same tree → same `VERSION`). **Phase: v0.6** for the automation; the v0.2
slice only *reads and asserts* the existing `VERSION` (BR-VER-006).
**Rationale:** A hand-synced global version is prone to drift across the three sources; a deterministic fold
removes the manual step entirely (ADR-0006).
**Acceptance:** `roll-up` on a fixed tree returns a stable `VERSION`, and re-running without changes
returns the identical value — `EVAL-VER-005`.
**Priority:** SHOULD
**Refs:** ADR-0006, SPEC-02

### BR-VER-005 — Per-artifact changelog is the filtered log

**Rule:** An artifact's changelog MUST be exactly the `registry.log.jsonl` entries whose `uid` matches,
in append order. `forge registry show <uid>` SHOULD surface them. No separate per-artifact history file may
be created.
**Rationale:** One append-only trail (BR-REG-007) is the single source; a second history store would drift
from it.
**Acceptance:** After two bumps of one `uid`, `show <uid>` (or the documented changelog accessor) returns
those two entries, in order, and no entries for other uids — `EVAL-VER-006`.
**Priority:** SHOULD
**Refs:** ADR-0002, ADR-0006, SPEC-02, BR-REG

### BR-VER-006 — Advisory bump gate (content-only drift, revision-unchanged)

**Rule:** When an artifact's recomputed `contentHash` differs from the committed record **while its
structural identity (`{kind,id,path,status,modules}`) is unchanged** and its `revision` was **not**
incremented, `validate-registry` MUST emit a **WARN** (NOT an ERROR, NOT a stale-registry ERROR):
`"<uid>: content changed but revision not bumped — run forge registry build --write"`. It MUST honor the
live-symlink seam (ADR-0008): the gate is **scan-based and advisory** because no event choke point exists,
and a solo dev must never be blocked at the default severity (ADR-0007, C5).
**Rationale:** Blocking on this for a team of one creates a deadlock surface whose only escape
(`git --no-verify`) is the very thing forge's `block-no-verify` hook fights; advisory is the proportionate
choice (ideas/01-proportionality.md). Content drift is NOT structural staleness — it is never escalated to
the stale ERROR (BR-REG-002).
**Acceptance:** Given a committed registry whose `contentHash` for `<uid>` no longer matches a fresh scan
while its structural identity and `revision` are unchanged, `validate-registry` emits a WARN naming the uid
and **exits 0 under default** (this finding alone does not block); under `--strict` the advisory WARN fails
the exit (exit 1), like any other advisory finding — `EVAL-VER-007`.
**Priority:** MUST
**Refs:** ADR-0007, ADR-0008, C5, SPEC-02

### BR-VER-007 — VERSION triple-drift severity

**Rule:** `validate-registry` MUST detect drift among `forge/VERSION`, `package.json.version`, and the
`plugin.json` version (BR-REG-008), comparing them **after stripping a `-design` suffix** from each. Drift =
the stripped **core** versions differ; only then is there a finding. Until the roll-up automation lands
(v0.6) this drift MUST be a **WARN**; once `forge registry roll-up` is authoritative the same check MUST be
promotable to ERROR. Because the strip aligns `0.1.0-design` with `0.1.0`, the current tree
(`0.1.0-design`/`0.1.0`/`0.1.0`) is aligned and MUST NOT trigger it.
**Rationale:** Advisory-first (ADR-0007) until the tool that *fixes* the drift exists; a pre-release suffix
is not a real mismatch, so it is not reported.
**Acceptance:** On the drifted fixture (core `0.2.0` vs `0.1.0` vs `0.1.0`) the check emits a WARN listing
all three raw values (exit 0 default, exit 1 under `--strict`); on the real tree, with the `-design` suffix
stripped, the same logic returns clean — `EVAL-VER-001`.
**Priority:** MUST
**Refs:** ADR-0006, ADR-0007, SPEC-02, BR-REG

### BR-VER-008 — Optional advisory `version:` frontmatter; registry authoritative

**Rule:** Artifacts MAY carry an advisory `version:` frontmatter key mirroring the registry semver for
human readability. On any conflict the **registry is authoritative** (ADR-0006). Adding the key MUST be
additive/back-compatible: existing validators ignore unknown frontmatter keys, so no validator may newly
fail because the key is present or absent. Bundles' existing integer `version` MUST map `N → "N.0.0"`.
**Rationale:** A visible version helps humans, but two sources of truth must have a tiebreaker; making the
key optional and ignored-by-default keeps it back-compatible.
**Acceptance:** An artifact whose `version:` frontmatter disagrees with the registry is resolved in favor
of the registry value, and no existing validator errors due to the key's presence/absence; a bundle with
`version: 3` maps to `"3.0.0"` — `EVAL-VER-008`.
**Priority:** MAY
**Refs:** ADR-0006, SPEC-02, BR-REG
