# ADR-0011: Telemetry is opt-in, default off, local-only, redacted-on-write, with no network path

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.4

## Context

Forge has no temporal sense of itself. It can validate that an artifact is *well-formed* (Tier S
meta-tests, cross-references, governance prose), but it cannot answer "which hooks actually fire", "what
is the real deny rate of `secret-scan`", "which agents/skills do I invoke most", or "is my typecheck
failing on most turns". Those are *observed-over-time* questions, and the only place forge runs often
enough to observe them is **inside the hooks** (`hooks/*.mjs`, which execute on every matching tool call)
and **inside the CLI** (`bin/forge.mjs`, which runs validators and evals). A telemetry dimension records
those observations as local events so `forge stat` / `forge monitor` can roll them up.

Four constraints bound the design, and they are in tension with "just collect data":

1. **Privacy / local-only is a foundational invariant** (README invariant 6, `ideas/02` non-goals). A
   personal harness that silently records what you do, or that can phone home, is unacceptable. The
   storage must physically be unable to leave the machine, and a *fresh install must record nothing*.
2. **Fail-open is a foundational invariant** (README invariant 4). Hooks are already strictly fail-open
   (every `hooks/*.mjs` swallows errors and `process.exit(0)`); telemetry runs *inside* those hooks and
   must never be able to change a deny/allow decision or block a tool call, even when it throws.
3. **Honest observability ceiling** (`ideas/02` "Honest limits"). A hook's stdin payload never contains
   tokens, cost, or model latency — those are Anthropic-side. Agent/skill *end* is not observable from a
   `PreToolUse` matcher (start-only). We must not fabricate what we cannot measure.
4. **Proportionality** (`ideas/01`). For `n=1` you often already know what you use; telemetry is Tier 2,
   deferred until "I genuinely can't tell". So it must default **off** and cost nothing until enabled.

## Decision

**Telemetry is opt-in (default OFF), machine-local, redacted-on-write, and has zero network surface.**
Concretely:

- **`emit(event)`** is a tiny zero-dependency helper at `forge/hooks/lib/telemetry.mjs`. It appends **one
  JSONL line** to `~/.claude/forge/telemetry/events-YYYY-MM-DD.jsonl` via a single `appendFileSync`, and
  is wrapped in a `try/catch` that swallows everything. It is called **after** the deny/allow decision is
  already computed, so by construction it cannot affect correctness. It does exactly one filesystem append
  and contains **no `fetch`/`http`/`https`/`net`/`dns`/`child_process` code path** anywhere.
- **Opt-in, default OFF.** With no config file and no env override, `emit()` is a **no-op** — a fresh
  install records nothing. `forge telemetry on` writes `~/.claude/forge/telemetry/config.json`
  `{enabled:true, retentionDays:30}`. The env var `FORGE_TELEMETRY=1|0` overrides the config file (so a
  user can force-enable or force-disable for one session without editing state).
- **Redaction-on-write.** `emit()` enforces a **closed `PAYLOAD_ALLOW` allow-list keyed by `event_type`**.
  Any field of `payload` not on that event's allow-list is dropped *before serialization*. The store NEVER
  contains file contents, secret values, raw filesystem paths, command strings, prompts, or environment —
  only hashes, lengths, counts, enums, booleans, and durations. `project` is stored as a hash `"h:<sha8>"`,
  never a real path; `session_id` is sanitized to `[A-Za-z0-9_-]`.
- **Local-only storage.** `~/.claude/forge/telemetry/` is on the machine-local side of the storage split
  (`ADR-0003`) and so is **never authoritative and never git-tracked**. `forge telemetry on` writes a
  self-`.gitignore` of `*` into that directory as defense in depth. Append-only JSONL, daily rotation, a
  16 MiB/day size cap (seal to `*.full`), retention default 30 days pruned **lazily** (no daemon — pruned
  by `forge stat` / `forge telemetry prune`, honoring `ADR-0010`'s no-background-process rule).
- **A meta-test guards the guarantees.** `tests/meta/telemetry-no-network.mjs` asserts (a) zero network
  surface across `hooks/lib/telemetry.mjs` and the telemetry CLI, and (b) `PAYLOAD_ALLOW` allow-list
  integrity (every taxonomy event has a closed list; no forbidden field name is ever whitelisted). This is
  forge-validates-forge applied to telemetry (`ADR-0014`).

## Consequences

**Positive**
- A fresh user is recorded by nothing; consent is a single explicit command. Privacy is the default.
- Because `emit()` runs after the decision and is fully wrapped, a broken emit can never block a tool call
  — telemetry inherits the hooks' fail-open guarantee for free.
- Redaction-on-write means the *store itself* is safe to read, copy, or paste: there is no secret to leak
  because no secret was ever written. The no-network meta-test makes "local-only" a tested invariant, not
  a promise.
- `forge stat` / `forge monitor` give forge the temporal view it lacks (fire counts, deny rates, typecheck
  fail %, most-invoked agents/skills, slowest hooks) with zero new runtime dependencies.

**Negative**
- Durations are **real only for hooks / typecheck / validators** (things forge itself runs start-to-end).
  Agent/skill events are **start-only** with `duration_ms = null`; readers must render unknown durations as
  "unknown", never 0 (`BR-TEL-009`). This is a physics limit, recorded honestly, not a bug to fix.
- Opt-in-default-off means at `n=1`, after a fresh install, there may be **no telemetry at all**. Any
  consumer that wants dynamic signal (Bundle D efficiency's dynamic value-density / dead-artifact
  detection) **must degrade to static-only** when the store is empty — it cannot assume data exists. This
  dependency is stated normatively in `BR-TEL-014` and is a hard constraint on `SPEC-06` / `BR-EFF`.
- A second hook (`PreToolUse` matching `Task|Skill`, `invoke-telemetry.mjs`) is added purely to observe
  agent/skill *starts*. It is fail-open and emits nothing when telemetry is off, but it is one more hook on
  the matcher list.

**Neutral**
- `emit()` lives under `hooks/lib/` (so hooks can import it with a relative path and stay zero-dep), while
  the readers (`stat`/`monitor`) live in the manager module layer; both read the same JSONL via
  `manager/lib/store.mjs`. The split mirrors the existing hook-vs-CLI boundary.
- The 16 MiB/day cap and 30-day retention are defaults, surfaced in `config.json`, not hard-coded policy.

## Alternatives considered

- **Default-on telemetry** — rejected: violates the privacy invariant and the proportionality verdict; a
  personal tool that records by default is exactly the "governance platform cosplaying as a personal tool"
  the red-team warned against (`ideas/01`).
- **A `~/.claude/forge/` SQLite event store** — rejected: needs `node:sqlite` (banned by `ADR-0002`) or a
  dependency; append-only JSONL with daily rotation is dependency-free, trivially tailable, and trivially
  redactable line-by-line.
- **Redact-on-read (store raw, scrub when displaying)** — rejected: if the raw value is ever written, it
  can leak (a stray `cat`, a backup, a bug in the reader). Redaction must happen *before* the byte hits
  disk, so the store is safe at rest by construction.
- **A background collector / daemon** to flush events and prune** — rejected by `ADR-0010` (no daemon).
  One synchronous `appendFileSync` per event and lazy pruning on the commands you already run is enough at
  this scale.
- **Capturing tokens / cost / model latency** — rejected because it is *impossible* from a hook payload,
  not merely undesirable. We record wall-clock + outcomes for what forge runs itself and label the rest
  unknown.

## Related

ADR-0002 (no `node:sqlite`), ADR-0003 (git-tracked vs machine-local split — telemetry is machine-local),
ADR-0010 (no daemon; lazy refresh), ADR-0014 (forge-validates-forge; the no-network meta-test),
README invariant 4 (fail-open) and 6 (local-only/privacy), C6 (storage split). Implemented by SPEC-05;
ruled normatively by BR-TEL; consumed (and constrained) by BR-EFF / SPEC-06. Artifact identity for
`artifact_id` — see BR-REG.
