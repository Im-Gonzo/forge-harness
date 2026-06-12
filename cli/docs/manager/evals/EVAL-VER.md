# EVAL-VER — Versioning acceptance specs

> RED-first acceptance specs for per-artifact versioning, the `VERSION` roll-up, and the **advisory**
> bump/drift gates (SPEC-02, BR-VER). All code-graded and deterministic (`pass^k=1.00`). Every case
> **RED**. Phase v0.2 (advisory) unless noted v0.6.

### EVAL-VER-001 — VERSION triple-drift is an advisory WARN

- **Verifies:** BR-VER-007, BR-REG-008
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** The `-design` pre-release suffix is **stripped** before comparing the triple, so
  drift means the **core** versions differ. Given `fixtures/versions-drifted/` (`VERSION` = `0.2.0`,
  `package.json` = `0.1.0`, `plugin.json` = `0.1.0`), When `validate-registry` runs, Then it emits a
  **WARN** (not ERROR) listing all three raw values and does **not** exit 1 on this finding alone (under
  `--strict` the advisory WARN does fail the exit). Given the **real** repo (`0.1.0-design` / `0.1.0` /
  `0.1.0`), Then — because the strip aligns the core versions — **no** drift finding is emitted.
- **Fixture:** `fixtures/versions-drifted/` (drift) + the real repo root (clean after strip).
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-VER-002 — Three-part identity present; sane seed

- **Verifies:** BR-VER-001
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a freshly built registry, When inspecting any record, Then it has a 64-hex
  `contentHash`, a numeric `revision`, and a valid semver `version`; a brand-new artifact seeds
  `revision: 1` and `version: "0.1.0"`.
- **Fixture:** `fixtures/lib-min/` (no prior committed registry).
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-VER-003 — Semver level semantics

- **Verifies:** BR-VER-002
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given an artifact at `version: "1.2.3"`, When `bump <uid> --patch` / `--minor` /
  `--major` run (independently from that base), Then the result is `1.2.4` / `1.3.0` / `2.0.0`
  respectively.
- **Fixture:** `fixtures/lib-min/` with a record seeded at `1.2.3`.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-VER-004 — Bump increments revision and appends one log line

- **Verifies:** BR-VER-003
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a record at `revision: 1, version: "0.1.0"`, When `bump <uid> --patch`
  runs, Then the record becomes `revision: 2, version: "0.1.1"` with refreshed `contentHash`/`updatedAt`,
  and exactly one `registry.log.jsonl` line records the `from`/`to` triple.
- **Fixture:** `fixtures/lib-min/` + committed registry/log.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-VER-005 — Roll-up is deterministic

- **Verifies:** BR-VER-004
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a fixed registry, When `forge registry roll-up` runs twice with no
  intervening change, Then both runs return the identical `VERSION`; given a registry differing only in
  `uid` ordering of the same artifacts, Then the computed `VERSION` is unchanged (sort-by-uid stability).
- **Fixture:** `fixtures/registry-frozen/` (+ a uid-shuffled copy).
- **Phase:** v0.6
- **Status:** RED (deferred)

### EVAL-VER-006 — Per-artifact changelog is the filtered log

- **Verifies:** BR-VER-005
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given two bumps of `uid` A and one bump of `uid` B, When `show A` (or the
  changelog accessor) runs, Then it returns exactly A's two entries in append order and none of B's.
- **Fixture:** `fixtures/lib-min/` + a log with interleaved A/B entries.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-VER-007 — Advisory bump gate (content-only drift)

- **Verifies:** BR-VER-006
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a committed registry whose `contentHash` for `<uid>` no longer matches a
  fresh scan while the record's **structural identity** (`kind`/`id`/`path`/`status`/`modules`) and its
  `revision` are unchanged — i.e. **content-only** drift, not structural — When `validate-registry` runs,
  Then it emits a **WARN** containing `content changed but revision not bumped` and `<uid>` (never escalated
  to a stale ERROR) and **exits 0** under default (advisory); under `--strict` the same advisory WARN fails
  the exit (exit 1).
- **Fixture:** `fixtures/lib-min/` + a committed registry (seeded via
  `node manager/registry.mjs build --write <root>`) with one record's `contentHash` tampered to 64 zeros.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-VER-008 — Frontmatter mirror; registry authoritative; back-compatible

- **Verifies:** BR-VER-008
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given an artifact whose `version:` frontmatter (`9.9.9`) disagrees with the
  registry (`0.2.0`), When the registry resolves the version, Then `0.2.0` (registry) wins; and given the
  same artifact, no existing validator (`validate-agents`/`validate-xref`/etc.) newly fails due to the
  presence of the `version:` key; and a bundle with integer `version: 3` maps to `"3.0.0"`.
- **Fixture:** `fixtures/artifact-version-frontmatter/` + a bundle at `version: 3`.
- **Phase:** v0.2
- **Status:** GREEN
