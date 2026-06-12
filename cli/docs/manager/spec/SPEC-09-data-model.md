# SPEC-09 — Canonical on-disk layout & schemas

Status: design-stage · Phase: v0.2 · Implements: BR-INT-004/005/006, BR-CLI-003/004 · Decided-by:
ADR-0002, ADR-0003, ADR-0004

## Summary

The single source of truth for **where the manager's state lives** and **the shape of every shared
record**: the git-tracked vs machine-local layout (ADR-0003), the registry record (cross-ref Bundle A),
the marker provenance field (cross-ref Bundle B), the telemetry event (cross-ref Bundle C), the eval-
linkage slot (cross-ref Bundle E), and the two Bundle-F-owned shapes that bind everything: the **`--json`
envelope** (C3) and the **unified finding** (C2). Dimension specs own their record *semantics*; this spec
owns the *layout and the cross-cutting shapes*.

## Design

### Canonical on-disk layout (ADR-0003, BR-INT-004)

Two physical roots. Git-tracked truth never mixes with machine-local cache.

```
# ── GIT-TRACKED (root: FORGE_ROOT) — the harness's identity, reviewed in PRs ──
forge/.forge/
  registry.json            # snapshot: the artifact catalog (BR-REG)            [committed]
  registry.log.jsonl       # append-only: per-artifact change log (BR-REG/BR-VER) [committed]
  eval/
    baselines/<uid>.json   # eval baselines per artifact (BR-EVAL)              [committed]
    cases/<EVAL-ID>.json   # the harness's own acceptance cases (BR-EVAL)       [committed]

# ── MACHINE-LOCAL (root: STATE_HOME = ~/.claude/forge/) — private, never committed ──
~/.claude/forge/
  fleet.json               # snapshot: opt-in install index (BR-FLEET)          [machine-local]
  telemetry/
    events.jsonl           # append-only: opt-in usage events (BR-TEL)          [machine-local]
  eval-runs/<ts>.json      # this machine's eval execution outputs (BR-EVAL)    [machine-local]
  analyze/<hash>.json      # cost/optimization cache, keyed by contentHash (BR-EFF) [machine-local]

# ── PER-PROJECT (root: PROJECT_DIR) — existing forge marker, read by the manager ──
<project>/.claude/.forge.json   # marker; gains provenance.sourceRev (BR-FLEET, ADR-0009)
```

Rules (BR-INT-004): the store (`manager/lib/store.mjs`) is the **only** writer; it routes a write to the
correct root by data-kind; every file carries top-level `schemaVersion`; **no machine-local file is ever
authoritative** (it's cache/observation, rebuildable). Privacy is structural — machine-local paths sit
outside any git work tree, so they cannot be `git add`-ed (C6).

### Registry record (owned by Bundle A — cross-ref BR-REG-004; shown here for layout completeness)

Each entry in `registry.json#artifacts[]`:

```json
{ "uid": "agents:code-reviewer", "kind": "agents", "id": "code-reviewer",
  "path": "agents/code-reviewer.md",
  "contentHash": "<64-hex sha256>",            // ADR-0005 (Bundle A owns)
  "revision": 4, "version": "1.2.0", "status": "active",
  "criticality": "normal",                      // STORED here; semantics owned by Bundle D (ADR-0013)
  "owner": "forge", "description": "...", "tags": ["review"],
  "modules": ["review-suite"], "dependsOn": ["skills:run-eval"],   // dependsOn owned by Bundle A (BR-DEP)
  "eval": { /* eval-linkage slot — below */ },
  "createdAt": "<ISO>", "updatedAt": "<ISO>" }
```

`contentHash`/`revision`/`version` semantics → **BR-REG / BR-VER (Bundle A)**; `dependsOn` → **BR-DEP**;
`criticality` → **BR-EFF / ADR-0013 (Bundle D)**. Bundle F fixes only that the record lives in
`forge/.forge/registry.json` with `schemaVersion`, written atomically by the store.

`registry.log.jsonl` line (owned by BR-REG-007, shown for layout): `{ts, uid, from{hash,rev,ver},
to{hash,rev,ver}, reason, evalStatus}`.

### Marker provenance field (cross-ref Bundle B — BR-FLEET / ADR-0009)

The existing per-project marker (`.claude/.forge.json`, `marker.schema.json`) gains one field, written by
`init`:

```json
{ "...existing marker fields...": "...",
  "provenance": { "sourceRev": "<registry revision or roll-up id the harness was built from>" } }
```

Bundle F owns only that this lives in the marker and is read via `ctx.PROJECT_DIR`; the **meaning** of
`sourceRev` (single field, not a per-component `components[]` array) and the fleet drift query are owned by
**ADR-0009 / BR-FLEET (Bundle B)**.

### Telemetry event (cross-ref Bundle C — BR-TEL / ADR-0011)

Each line of `~/.claude/forge/telemetry/events.jsonl` (machine-local, opt-in, redacted-on-write):

```json
{ "ts": "<ISO>", "kind": "hook|validator|task|skill", "name": "block-no-verify",
  "decision": "allow|deny|pass|fail", "durationMs": 12, "schemaVersion": "forge.telemetry.v1" }
```

Bundle F owns only that telemetry is a **machine-local append-only JSONL** under `STATE_HOME` with
`schemaVersion`, written via the store's lossy advisory-lock append (BR-INT-005). Event *fields*,
redaction, and the no-network guarantee are owned by **ADR-0011 / BR-TEL (Bundle C)**.

### Eval-linkage slot (cross-ref Bundle E — BR-EVAL / ADR-0012)

The `eval` slot on a registry record links an artifact to its acceptance status:

```json
"eval": { "pinnedHash": "<contentHash the last eval scored>",   // derives from ADR-0005
          "lastRun": "<ISO|null>", "status": "pass|fail|stale|untested",
          "baseline": "forge/.forge/eval/baselines/<uid>.json" }
```

`stale` ⇔ `pinnedHash !== record.contentHash` (the artifact changed since its last eval). Bundle F owns
only the slot's *presence* and its file pointers into `forge/.forge/eval/`; the **eval semantics**
(catch-rate, pass/fail, baselines) are owned by **ADR-0012 / BR-EVAL (Bundle E)**.

### The `--json` envelope (C3 — owned by Bundle F, ADR-0004)

Every machine-readable command emits exactly this shape, via `manager/lib/json-out.mjs`:

```json
{ "forge":   "0.1.0-design",          // forgeVersion() (raw VERSION; ADR-0005 note)
  "command": "validate",              // the invoked command/group
  "ok":      true,                    // summary.errors === 0 AND no failed/errored child
  "ts":      "2026-06-05T12:00:00Z",  // ISO-8601
  "data":    { /* command-specific payload */ },
  "findings":[ /* Finding[] — the C2 shape below */ ],
  "summary": { "errors": 0, "warnings": 1, "info": 0 /* + command-specific counts */ } }
```

`ok` is computed, never asserted by a child; `data` is the only command-specific part; `findings`/`summary`
are uniform (BR-CLI-004). One writer ⇒ one shape across `validate`/`doctor`/`status`/`registry`/… .

### The unified finding (C2 — owned by Bundle F, ADR-0004)

Every check — parsed from a child validator or emitted by a manager module — is exactly:

```json
{ "level":   "ERROR" | "WARN" | "INFO",
  "path":    "agents/code-reviewer.md",   // repo-relative path the finding concerns
  "line":    12 | null,                   // 1-based line, or null when not line-scoped
  "message": "dangling prose ref: react-reviewer",
  "source":  "validate-xref.mjs" }        // emitter: validator filename or module noun
```

**Parser (the highest-leverage seam, ADR-0004):** child validators print `LEVEL path:line message`; the
parent runner (`run-all.mjs`/`run-meta.mjs`) parses each captured line with
`^(ERROR|WARN|INFO)\s+(\S+?)(?::(\d+))?\s+(.*)$` → the shape above, with `source` = the child's filename.
Non-matching lines are banner/summary text and are excluded from `findings[]` (optionally retained as
`raw` under `--strict`). This is why no child needs a `--json` mode.

## Data structures

JSON Schemas to ship under `forge/schemas/` (alongside the existing `marker.schema.json` etc.), each
auto-validated by the relevant validator:

| Schema | Validates | Owner |
|---|---|---|
| `registry.schema.json` | `registry.json` (record array + top-level `schemaVersion`) | A (Bundle F stub at v0.2) |
| `finding.schema.json` | the C2 finding shape | **F** |
| `envelope.schema.json` | the C3 envelope shape | **F** |
| `fleet.schema.json` | `fleet.json` | B |
| `telemetry-event.schema.json` | a telemetry JSONL line | C |

Bundle F authors `finding.schema.json` and `envelope.schema.json` (the cross-cutting shapes) and a
registry-layout stub; dimension schemas are owned by their bundles.

## Edge cases & failure modes

- **Unknown `schemaVersion`** — the store refuses to parse-as-current and surfaces a WARN finding
  (`forge status` shows the affected panel as `(no data — incompatible schema)`), never corrupts the file
  (ADR-0002, BR-INT-004).
- **Half-written snapshot avoided** — atomic temp-rename; a crash leaves the previous file intact
  (BR-INT-005).
- **JSONL append under contention** — advisory `.lock`; the late event is dropped, never blocks, never
  corrupts the log (BR-INT-005).
- **Machine-local root absent** — created lazily on first opt-in write; until then every dependent panel is
  `(no data)` and every read fails-open to empty (BR-INT-003).
- **A finding line that doesn't match the regex** — not a finding; retained as `raw` only under `--strict`;
  never crashes the parse (ADR-0004).
- **Marker without `provenance.sourceRev`** (pre-upgrade harness) — treated as `sourceRev: null`; fleet
  drift reports "unknown provenance", not an error (Bundle B owns this).

## Open questions

- Do we pin a JSON-Schema draft (2020-12) for the new schemas to match the existing `forge/schemas/`? Match
  whatever `schemas/README.md` declares; carried to implementation.
- Telemetry retention is line-count vs age-based — owned by Bundle C; layout here is agnostic.
- Whether `registry.schema.json` is authored by Bundle A or stays a Bundle-F stub until v0.3 — Bundle A owns
  the field semantics; F ships the layout stub so `status` has something to validate against at v0.2.

## Traceability

- **BRs:** BR-INT-004 (storage roots + `schemaVersion`), BR-INT-005 (atomic/lossy writes), BR-INT-006
  (finding shape); BR-CLI-003 (parser→findings), BR-CLI-004 (single envelope).
- **ADRs:** ADR-0002 (file shapes), ADR-0003 (git vs machine-local split), ADR-0004 (envelope + parser).
- **Cross-bundle refs (semantics owned elsewhere):** BR-REG/BR-VER (registry record), BR-DEP (`dependsOn`),
  BR-FLEET/ADR-0009 (marker `sourceRev`, `fleet.json`), BR-TEL/ADR-0011 (telemetry event),
  BR-EVAL/ADR-0012 (eval slot/baselines), BR-EFF/ADR-0013 (`criticality`, analyze cache).
- **EVALs:** EVAL-INT-003 (storage-additive + `schemaVersion`), EVAL-INT-004 (finding shape), EVAL-INT-006
  (atomic/lossy); EVAL-CLI-001 (parser→envelope), EVAL-CLI-002 (single envelope shape).
