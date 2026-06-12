# fixture: fleet-project

A minimal **tailored project tree** (not a forge library) used by
`tests/manager/eval-fleet.test.mjs` to exercise the Phase-v0.3 READ fleet cases
(EVAL-FLEET-003/005/006) and the provenance cases (EVAL-FLEET-001/002).

Contents:

- `.claude/.forge.json` — the project marker (`<project>/.claude/.forge.json`), the
  per-project source of truth (ADR-0010). It carries the v0.2 `provenance` block
  (`registrySchema` + `sourceRev`) and one tracked `files[]` entry whose `checksum`
  is a placeholder zero-hash (the tests recompute it against the on-disk copy when
  they need a real value).
- `.claude/agents/code-reviewer.md` — a copied, user-editable artifact recorded in
  `files[]`. A test may edit it in its sandbox copy to simulate user drift (which is
  sacred — never unhealthy, BR-FLEET-013) without touching this frozen fixture.

This tree is COPIED into an `os.tmpdir()` sandbox per test; the frozen fixture is
never mutated in place.
