# 02 — Scope & non-goals

## In scope

- A management layer over the **global** forge harness: catalog, identity, versioning, dependency graph.
- An at-a-glance **`forge status`** dashboard composing every dimension.
- A **machine-readable (`--json`)** backbone over forge's existing validators/meta-tests and the new
  manager commands.
- **Advisory** drift/version/eval signals surfaced in `status` and `doctor`.
- The *conceptual* design for fleet, telemetry, efficiency, and eval-of-harness — fully specified so they
  are buildable when their trigger conditions arrive, even though most are deferred.

## Out of scope (non-goals)

- **No new runtime dependencies.** No `npm` packages, no `node:sqlite` (`ADR-0002`), no dashboard
  framework, no web server. `node:` builtins only.
- **No background process / daemon.** All state is refreshed opportunistically by commands the user
  already runs (`ADR-0010`).
- **No telemetry exfiltration.** Telemetry is opt-in, local-only, redacted-on-write, and has no network
  code path (`ADR-0011`). A meta-test asserts the absence of network surface.
- **No hard commit-blocking gates (for now).** Version-bump and eval-regression checks are advisory
  (`ADR-0007`); blocking is a later, explicit decision.
- **No TUI or web UI in the near term.** `forge status` (text + `--json`) is the dashboard. A future
  `forge status --html` (single self-contained file, no server, no deps) is the only sanctioned UI path,
  and it is deferred.
- **No reimplementation of git.** Fleet sync orchestrates the *existing* per-project `forge sync`; it
  does not invent a distribution system on top of git (`ADR-0010`).
- **No per-product evals here.** This corpus governs the harness's own artifacts (eval-of-harness,
  `SPEC-07`). Product/business evals remain the per-project `.claude/evals/` concern.

## Honest limits we accept (not bugs — physics)

- **Telemetry cannot see tokens, cost, or model latency** — those are Anthropic-side, never in a hook's
  stdin payload. Telemetry captures **wall-clock and outcomes** for hooks/typecheck/validators only.
- **Agent/skill *end* and duration are not reliably observable** from hooks (start-only via a
  `PreToolUse` matcher on `Task`/`Skill`). Durations for those are best-effort / often absent.
- **Token cost in the efficiency dimension is an estimate** (`~chars/4` blended heuristic), explicitly
  labeled as such, calibrated by two documented constants — never a measured number.

## Success criteria (corpus-level)

1. A reader can implement any single dimension from its SPEC without re-deriving cross-dimension
   contracts (they live in `README.md` §"cross-dimension contract" and `SPEC-00`).
2. Every BR has a testable acceptance criterion mapped to an EVAL case (full `BR <-> EVAL` coverage).
3. The Tier-1 walking skeleton (`ROADMAP.md` v0.2) is buildable in ~2 focused days and delivers ~60% of
   the value with zero blocking gates and no new authoritative state beyond the registry.
