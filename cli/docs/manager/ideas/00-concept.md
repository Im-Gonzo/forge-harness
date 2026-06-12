# 00 — Concept: the missing layer

## The thesis

Forge today is a **static integrity verifier with no sense of time or identity.** Its existing machinery
is genuinely strong:

- a **composition graph** (`manifests/profiles.json` → `modules.json` → components),
- **cross-reference integrity** (`validate-xref`, `validate-memory-integrity`),
- **shape conformance** (11 zero-dep validators auto-discovered by `lint/run-all.mjs`),
- **governance-prose conformance** (5 meta-tests in `tests/meta/`),
- a per-project **marker** (`.claude/.forge.json`) with sha256 checksums + `userEditable` flags,
- the `pass@k`/`pass^k` **eval discipline** (`run-eval`/`author-eval`),
- and `forge doctor` (a per-project, read-only health check).

But forge **cannot answer the management questions**:

| Question | Forge today | The manager |
|---|---|---|
| What changed since vN, and by how much? | nothing — one global `VERSION` string | per-artifact `contentHash` + `revision` + `semver` |
| What does this artifact cost in context? | hand-measured once (`~2,550 tok`) | context-budget accounting |
| Does this reviewer actually catch bugs? | prose says it should; never measured | behavioral eval (planted-defect + clean cases) |
| Which projects use this harness, how stale? | crawl the filesystem by hand | fleet index + drift query |
| Which artifacts never fire / earn their keep? | unknown | telemetry + dead-artifact detection |
| Is `react-reviewer` (a referenced agent) real? | **dangling ref slips through** `validate-xref` | dependency graph with prose-ref resolution |

The **Harness Manager is the layer that answers those** — identity, versioning, monitoring, optimization,
efficiency, analysis — built *on top of* forge's existing static base, reusing its primitives (the
composition graph, the sha256 checksums, the auto-discovery runners, the eval discipline).

## The six concerns → six dimensions

The user's stated needs map cleanly onto six design dimensions, each with its own SPEC/BR/EVAL set:

1. **Track the harness** → **Registry** (`SPEC-01`): a catalog of every artifact with identity.
2. **Versioning** → **Versioning** (`SPEC-02`): `contentHash` + `revision` + `semver`, `VERSION` roll-up.
3. **Analysis / dependency awareness** → **Dependency graph** (`SPEC-03`): typed edges incl. prose refs.
4. **Track tailored instances** → **Fleet & provenance** (`SPEC-04`): which project ran which version.
5. **Monitoring** → **Telemetry** (`SPEC-05`): hook fires/denies, invocations, durations.
6. **Optimization / efficiency** → **Efficiency** (`SPEC-06`) + **Eval-of-harness** (`SPEC-07`):
   context cost, dead-artifact detection, value-density, and behavioral effectiveness.

A seventh, integrating dimension — **Architecture/CLI/data model** (`SPEC-00`, `SPEC-08`, `SPEC-09`) —
binds them into one coherent `forge`-native tool with a `forge status` dashboard.

## What "good" looks like

A single command — `forge status` — composes all dimensions into an at-a-glance read of harness health:
version drift, changed artifacts, dangling refs, fleet drift, telemetry rollup, eval coverage, and
optimization flags. Everything else (`forge registry …`, `forge fleet …`, `forge analyze …`,
`forge eval-harness …`) drills into one dimension. The manager *feels like forge*, not a bolt-on:
noun-first subcommands on the existing CLI, zero new dependencies, fail-open, additive.

See `01-proportionality.md` before estimating effort — most of this is **deferred by design**.
