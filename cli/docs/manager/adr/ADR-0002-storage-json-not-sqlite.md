# ADR-0002: Storage engine — flat JSON + append-only JSONL, not `node:sqlite`

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.2

## Context

The manager persists several kinds of state: the registry (a catalog), a per-artifact change log, a fleet
index, telemetry events, eval-run results, and an analyze cache. Node 22 ships `node:sqlite` (behind an
experimental flag), which is tempting for the log-ish, query-ish workloads. We must choose a storage
engine that honors the foundational invariants — **zero runtime dependencies** and **git-diffable truth**
(the registry is *versioned with the code it describes*, C6/ADR-0003) — and that a future, larger version
could swap without rewriting every dimension.

## Decision

**State is flat JSON (snapshots) plus append-only JSONL (event logs). We reject `node:sqlite`. All access
goes through one `forge/manager/lib/store.mjs` seam so a future backend is a drop-in.**

- **Two file shapes only.** A *snapshot* (`registry.json`, `fleet.json`) is a single JSON document written
  atomically. A *log* (`registry.log.jsonl`, telemetry events) is append-only, one JSON object per line.
- **`node:sqlite` is rejected**, for reasons that are exactly the manager's premises:
  1. **Experimental on Node 22** — it requires `--experimental-sqlite` and can change/emit warnings; a
     personal harness must not depend on an unstable flag (invariant 1, zero-dep spirit).
  2. **Binary and merge-hostile** — a `.sqlite` file cannot be reviewed in a diff and conflicts cannot be
     resolved by hand. The registry's whole purpose (`ideas/00`) is *git-diffable* identity; a binary
     blob defeats it. JSON/JSONL diffs cleanly.
  3. **Opaque** — `cat registry.json` and `tail registry.log.jsonl` are the debugging story. A solo dev
     should never need a query tool to read their own harness state.
  JSONL gives an audit trail (append-only ⇒ a natural changelog, BR-REG/BR-VER) without a lock-file or a
  schema migration step.
- **One abstraction seam.** `store.mjs` exposes `readJson(uid)`, `writeJsonAtomic(uid, obj)`,
  `appendJsonl(uid, obj)`, `readJsonl(uid)`, and root resolution (ADR-0003). No manager module touches
  `fs` for state directly. If a future many-projects version wants sqlite, it re-implements *this seam*,
  not seven call sites.
- **Atomicity.** Snapshot writes are **write-temp-then-rename** (`writeFileSync(tmp); renameSync(tmp,
  final)`) so a crash never leaves a half-written `registry.json`. JSONL appends use an advisory `.lock`
  (best-effort `O_CREAT|O_EXCL`); on contention the event is **dropped, not blocked** (fail-open,
  invariant 4) — telemetry/audit lines are lossy by design, never a barrier.
- **Schema versioning.** Every state file carries a top-level `schemaVersion` string (mirroring
  `bin/forge.mjs`'s `INSTALL_STATE_VERSION` convention), so the store can refuse/upgrade an unknown shape
  rather than corrupt it. Asserted by a meta-test (ADR-0014/BR-INT).

## Consequences

**Positive**
- Zero new dependency surface; runs on any Node `>=18` (the JSONL/atomic-rename path uses only `node:fs`).
- Registry truth is reviewable in PRs — the feature that makes versioning meaningful.
- A crashed/contended writer degrades to a dropped event or a no-op, never to a corrupted store.

**Negative**
- Large logs (telemetry at high volume) are read-whole-file; there is no indexed query. Acceptable at
  `n=1` scale and bounded by retention/prune (telemetry caps lines; analyze caches by hash). The
  `store.mjs` seam is the upgrade path if this ever bites.
- Append-under-contention can drop an event. This is the *intended* trade (fail-open > exactness for
  best-effort telemetry); the registry log is single-writer (`registry build`) so it is not exposed to it.

**Neutral**
- JSON snapshots use stable key order + sorted arrays so diffs are minimal and deterministic
  (prerequisite for the idempotent-build rule, BR-REG).

## Alternatives considered

- **`node:sqlite`** — rejected per the three reasons above (experimental flag, binary/merge-hostile,
  opaque). The seam keeps it available later if scale ever justifies it.
- **A single big JSON for everything** — rejected: couples git-tracked truth and machine-local cache into
  one file, breaking the storage split (ADR-0003) and making privacy non-structural.
- **An npm embedded DB (lowdb/lmdb/etc.)** — rejected outright: violates zero-dep (invariant 1).
- **Plain `.log` text lines** — rejected: not machine-parseable into the findings/event shapes the
  `--json` envelope needs (ADR-0004); JSONL is the minimal structured form.

## Related

ADR-0003 (where these files live; the git/machine split), ADR-0004 (the JSONL/findings feed the
envelope), ADR-0001 (modules reach storage only via the `store.mjs` seam). C2, C3, C6, BR-INT, BR-REG,
BR-TEL, SPEC-09.
