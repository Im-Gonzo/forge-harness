# SPEC-08 — CLI surface & `forge status` dashboard

Status: design-stage · Phase: v0.2 (skeleton) · Implements: BR-CLI-001..010, BR-INT-007 · Decided-by:
ADR-0001, ADR-0004, ADR-0007, ADR-0015

## Summary

The full manager command taxonomy, the global flags, the `forge --help` MANAGER section, and the
`forge status` composed dashboard (human mock + `--json`). The taxonomy is noun-first groups + a few
top-level verbs, dispatched per SPEC-00. `status` is the skeleton's proof-of-composition: one panel per
dimension, fail-open `(no data — run X)` where a dimension is absent. `doctor` is extended additively and
stays the pass/fail health command, distinct from `status`.

## Design

### Command taxonomy (ADR-0015)

| Command | Verbs | Side-effects | Phase | Owner |
|---|---|---|---|---|
| `forge status` | — | read-only, exits 0 | v0.2 (skeleton) | F |
| `forge registry` | `build [--write] · ls [--kind k] · show <uid> · changed [--since ref] · diff <a> <b>` | build writes (w/ `--write`); rest read-only | v0.2 | A |
| `forge registry` (graph) | `deps <uid> · rdeps <uid> · orphans · dangling` | read-only | v0.3 | A |
| `forge registry` (version) | `bump <uid> · log [<uid>] · roll-up` | bump/roll-up write (w/ `--apply`) | v0.3 / v0.6 | A |
| `forge fleet` | `enable · status · scan · drift` | read-only / cache write | v0.3 | B |
| `forge fleet` (write) | `sync [--all\|<id>] · relink · forget · prune · ignore · pin` | mutate (w/ `--apply`) | v0.5 | B |
| `forge telemetry` | `on · off · status · prune · wipe` | toggle / local write | v0.4 | C |
| `forge monitor` | — | live tail (foreground) | v0.4 | C |
| `forge analyze` | — | **read-only report** | v0.3 | D |
| `forge optimize` | — | **dry-run plan** (`--apply` to act) | v0.6 | D |
| `forge eval-harness` | `[uid] · --changed · --all · --report` | run / write results | v0.4 | E |
| `forge doctor` | — (extended) | pass/fail health | v0.2 (extended) | F |
| `forge validate` | — (extended `--json`) | pass/fail | v0.2 | F |

Bundle F (this spec) owns `status`, the `--json` plumbing, `doctor` extension, the taxonomy, and the
global flags. The *verb bodies* of registry/fleet/telemetry/analyze/optimize/eval-harness are owned by
their bundles' SPECs (01–07); this spec fixes only their *names, side-effect class, and dispatch*.

### Global flags (BR-CLI-008)

- `--json` — emit the C3 envelope instead of human text (ADR-0004).
- `--dry-run` (default for writers) / `--apply` (or `--write` for registry) — the mutation gate (C4).
- `--strict` — advisory WARN findings count toward the exit code (ADR-0007); default: they don't.
- `--quiet` — suppress human banners (findings/data only).

Parsed once via `parseArgs`, carried in `ctx` (SPEC-00). `analyze` rejects `--apply` (read-only,
BR-CLI-010); `monitor`/`status` ignore `--apply`.

### Overlap resolution (ADR-0015, BR-CLI-010)

- **`status` vs `telemetry status` vs `monitor`** — composed snapshot · one subsystem's state · live tail.
  No top-level `forge stat`.
- **`analyze` vs `optimize`** — read-only report · dry-run plan.
- **`doctor` vs `status`** — pass/fail health (extended additively) · informational dashboard. Never
  duplicated.

### `forge --help` — MANAGER section (BR-CLI-009)

Appended to the existing `usage()` output (the existing flat-verb section is unchanged):

```
MANAGER (harness management layer)
  status                             At-a-glance dashboard across all dimensions. Read-only.
  registry <verb>                    Artifact catalog & identity.
      build [--write] | ls [--kind <k>] | show <uid> | changed [--since <ref>]
      deps <uid> | rdeps <uid> | orphans | dangling     (v0.3)
      bump <uid> | log [<uid>] | diff <a> <b> | roll-up (v0.3+)
  fleet <verb>                       Where harnesses are installed (opt-in cache).
      enable | status | scan | drift                     (v0.3)
      sync [--all|<id>] | relink | forget | prune | ignore | pin   (v0.5)
  telemetry <verb>                   Local-only, opt-in usage signals (default OFF).
      on | off | status | prune | wipe                   (v0.4)
  monitor                            Live tail of telemetry events.            (v0.4)
  analyze                            Static context-budget report. Read-only.  (v0.3)
  optimize                           Dry-run prune/trim plan (--apply to act). (v0.6)
  eval-harness [uid|--changed|--all|--report]  Behavioral eval of the harness. (v0.4)

GLOBAL FLAGS (manager)
  --json            Machine-readable envelope instead of human text.
  --dry-run/--apply Writers are DRY-RUN by default; --apply (or --write for registry) persists.
  --strict          Count advisory WARN findings toward the exit code.
  --quiet           Suppress human banners.

NOTES
  - status is informational (always exits 0); doctor is the pass/fail health command.
  - No background process. Telemetry is opt-in, local-only, never networked.
  - Every writer is dry-run by default; nothing mutates without --apply/--write.
```

### `forge status` — the composed dashboard (BR-CLI-005/006, ADR-0016)

`status` calls each module's `summarize(state)` (SPEC-00), composes the panels, computes an OVERALL line,
and prints a next-actions list. **Fail-open:** a dimension with no/unreadable state renders
`(no data — run <command>)` and never blanks the view or changes the exit code.

Human mock (v0.2 skeleton — only the registry panel is live; the rest are honest stubs):

```
================================================================
 forge status — harness @ 0.1.0-design                 2026-06-05
================================================================
 REGISTRY        93 artifacts · 0 stale · last build 2m ago
   agents 7 · skills 14 · commands 9 · rules 21 · hooks 12 · bundles 6 · validators 13 · meta 5
   ! VERSION triple drift: VERSION=0.1.0-design package.json=0.1.0 plugin.json=0.1.0   (WARN)
   ! 1 artifact hash-changed without a revision bump: skills/run-eval                  (WARN)
 ----------------------------------------------------------------
 DEPENDENCY      1 dangling ref · 0 orphans
   ! agents/code-reviewer -> "react-reviewer" (unresolved prose ref)                   (WARN)
 ----------------------------------------------------------------
 FLEET           (no data — run `forge fleet enable && forge fleet scan`)
 ----------------------------------------------------------------
 TELEMETRY       OFF        (no data — run `forge telemetry on`)
 ----------------------------------------------------------------
 EFFICIENCY      (no data — run `forge analyze`)
 ----------------------------------------------------------------
 EVAL            (no data — run `forge eval-harness --all`)
 ----------------------------------------------------------------
 OVERALL         OK with 3 advisory warnings (0 errors)
                 advisory-only — nothing is blocking (see ADR-0007)
 NEXT ACTIONS
   1. forge registry build --write     # refresh & clear the stale/drift WARNs
   2. fix dangling ref in agents/code-reviewer  (or add react-reviewer)
   3. forge analyze                     # populate the efficiency panel
================================================================
```

Notes on the mock:
- **Panels present even when empty** — `(no data — run X)` is the fail-open contract, not a blank line.
- **Advisory WARNs are shown, exit is 0** — OVERALL says "advisory-only — nothing is blocking" (ADR-0007).
- **A live panel (REGISTRY) summarizes counts + advisory findings**; stub panels name the command that
  fills them.
- At v0.3+ the DEPENDENCY/FLEET panels go live; at v0.4 TELEMETRY/EVAL; at v0.6 EFFICIENCY's dynamic half.
  The *shape* is fixed at v0.2 so later dimensions slot in without re-design.

### `forge status --json`

Same C3 envelope (`command:"status"`), with each panel's structured form under `data.panels` and all
advisory findings collected into the top-level `findings[]`:

```json
{ "forge": "0.1.0-design", "command": "status", "ok": true, "ts": "2026-06-05T...Z",
  "data": { "panels": {
      "registry":   { "ok": true,  "artifacts": 93, "stale": 0, "byKind": { "agents": 7, "...": 0 } },
      "dependency": { "ok": false, "dangling": 1, "orphans": 0 },
      "fleet":      { "ok": null,  "state": "no-data", "hint": "forge fleet enable && forge fleet scan" },
      "telemetry":  { "ok": null,  "state": "off",     "hint": "forge telemetry on" },
      "efficiency": { "ok": null,  "state": "no-data", "hint": "forge analyze" },
      "eval":       { "ok": null,  "state": "no-data", "hint": "forge eval-harness --all" } } },
  "findings": [
    { "level": "WARN", "path": "forge/VERSION", "line": null, "message": "VERSION triple drift ...", "source": "validate-registry" },
    { "level": "WARN", "path": "skills/run-eval", "line": null, "message": "hash changed without revision bump", "source": "validate-registry" },
    { "level": "WARN", "path": "agents/code-reviewer.md", "line": null, "message": "dangling prose ref: react-reviewer", "source": "validate-registry" } ],
  "summary": { "errors": 0, "warnings": 3, "info": 0 } }
```

`ok: null` is the panel's "no data" tri-state; the OVERALL `ok` is `summary.errors === 0` (advisory WARNs
don't flip it — ADR-0007).

### `doctor` extension (BR-INT-007, BR-CLI-006)

`forge doctor` keeps its existing per-project marker checks and exit semantics, and **appends** a
manager-scope block (additive lines, never replacing the existing output):

```
  ----------------------------------------------------------------
  MANAGER SCOPE (additive)
  [OK]   registry present & in sync (93 artifacts, built 2m ago)
  [WARN] VERSION triple drift (VERSION=0.1.0-design package.json=0.1.0 plugin.json=0.1.0)
  [INFO] telemetry OFF · fleet not enabled
```

`doctor` remains pass/fail (its existing problems set the exit code); the additive manager lines surface
advisory drift but, being WARN/INFO, do not by themselves fail `doctor` (ADR-0007). `--json` makes
`doctor` emit the envelope with these as findings.

## Data structures

- `Panel` (returned by each `summarize`) = `{ panel, ok: true|false|null, lines: string[], hint?: string,
  data?: object }`. `ok:null` = no-data tri-state.
- `StatusEnvelope.data.panels` keyed by dimension; findings collected at the top level (C3).
- Global flags as in SPEC-00 `ctx.flags`.

## Edge cases & failure modes

- **A `summarize` throws** — `status` catches per panel, renders that one as `(no data — error reading X)`
  WARN, and continues (one bad dimension never blanks the dashboard; fail-open, BR-INT-003).
- **No registry yet** — REGISTRY panel is `(no data — run forge registry build)`; OVERALL still computes
  from whatever panels exist; exit 0.
- **`--strict` + advisory WARNs** — exit becomes non-zero (the dial, ADR-0007); the human view is otherwise
  identical.
- **`forge stat`** — unknown command → existing `default:` usage + exit 2 (BR-CLI-010).
- **Unknown sub-verb** (`forge registry bogus`) — group usage + exit 2 (BR-CLI-009).
- **`analyze --apply`** — rejected with a usage error (read-only, BR-CLI-010).

## Open questions

- `forge status --html` (single self-contained file) is sanctioned-but-deferred (`ideas/02`); not in v0.2.
- Panel ordering: fixed (registry → dependency → fleet → telemetry → efficiency → eval) vs config. Fixed
  for v0.2.
- Should `next-actions` be derived purely from findings, or curated per dimension? Leaning derived-from-
  findings with a per-dimension hint fallback; carried to implementation.

## Traceability

- **BRs:** BR-CLI-001..010 (taxonomy, envelope, status, flags, help, overlaps); BR-INT-007 (compose/extend).
- **ADRs:** ADR-0001 (dispatch), ADR-0004 (`--json` envelope), ADR-0007 (advisory exit), ADR-0015 (taxonomy).
- **EVALs:** EVAL-CLI-001 (json envelope from runner), EVAL-CLI-002 (single envelope shape),
  EVAL-CLI-003 (status composes panels), EVAL-CLI-004 (status≠doctor roles), EVAL-CLI-005 (dry-run writes
  nothing), EVAL-CLI-006 (no hot-path import), EVAL-CLI-008 (`--strict` dial), EVAL-CLI-009 (help/unknown),
  EVAL-CLI-010 (overlap resolution); EVAL-INT-002 (fail-open panel), EVAL-INT-007 (compose).
