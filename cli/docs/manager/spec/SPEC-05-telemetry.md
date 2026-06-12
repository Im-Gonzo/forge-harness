# SPEC-05 — Telemetry & Monitoring

Status: design-stage (RED) · Phase v0.4 · Implements: BR-TEL-001..014 · Decided-by: ADR-0011 (with
ADR-0003 storage split, ADR-0010 no-daemon, ADR-0014 forge-validates-forge)

## Summary

Telemetry gives forge the **temporal + observability** view it lacks: which hooks fire, real deny rates,
typecheck fail %, most-invoked agents/skills, slowest hooks. It does this by recording **one redacted
JSONL event per decision/run site**, *after* the decision is made, into a machine-local, never-committed
store — **only when the user has opted in**. A fresh install records nothing. There is **no network code
path** anywhere in the telemetry surface, and a broken emit can never block a tool call.

The dimension is deliberately humble about its ceiling: hooks cannot see tokens, cost, or model latency
(Anthropic-side), and cannot observe an agent/skill *end* (start-only). So durations are real only for
what forge itself runs end-to-end (hooks, typecheck, validators, evals); everything else is `null`. We do
not fabricate. (See `ideas/02` "Honest limits".)

## Design

### Two halves: the emitter (hooks) and the readers (CLI)

```
hooks/lib/telemetry.mjs   emit(event)            # zero-dep; one appendFileSync; redact-on-write; fail-open
hooks/invoke-telemetry.mjs  PreToolUse Task|Skill # NEW hook: agent/skill START events only
bin/forge.mjs  →  manager/telemetry.mjs           # forge stat | monitor | telemetry on|off|status|prune|wipe
                  manager/lib/store.mjs            # shared JSONL reader/rollup (also used by status panel)
```

`emit()` lives under `hooks/lib/` so every hook imports it with a relative path and stays zero-dependency
and node-builtins-only. The *readers* live in the manager module layer (`forge/manager/telemetry.mjs`,
the `run()`/`summarize()` contract, C4) because they are CLI commands, not hot-path hook code.

### The emit() contract (the load-bearing helper)

`emit(event)` does, in order:

1. **Gate (no-op fast path).** Resolve enablement: `FORGE_TELEMETRY` env (`1`→on, `0`→off) beats
   `~/.claude/forge/telemetry/config.json` `{enabled}`; default is **off**. If off → **return immediately**,
   touching no file (`BR-TEL-001`, `BR-TEL-002`). This is the common case on a fresh install and must be
   the cheapest path.
2. **Normalize + redact-on-write.** Fill the fixed schema (below), hashing the project path to `"h:<sha8>"`,
   sanitizing `session_id` to `[A-Za-z0-9_-]`, and applying `PAYLOAD_ALLOW[event_type]`: drop every
   `payload` field not on that event type's closed list (`BR-TEL-005`, `BR-TEL-006`). An unknown
   `event_type` → empty payload.
3. **Rotate if needed.** Resolve today's file `events-YYYY-MM-DD.jsonl` (UTC). If it is at/over the size
   cap (default 16 MiB), seal it to `*.full` and start fresh (`BR-TEL-010`).
4. **Append exactly one line.** `appendFileSync(file, JSON.stringify(event) + '\n')`. Exactly one
   filesystem write; **no network, no child process** (`BR-TEL-004`).
5. **Swallow everything.** The whole body is wrapped in `try {…} catch {}`. Any failure returns normally
   (`BR-TEL-003`).

`emit()` is always invoked **after** the hook's deny/allow decision is already on stdout / computed, so by
construction it cannot influence correctness. The existing hooks keep their structure (read stdin →
decide → write decision → `process.exit(0)`); the only change is one `emit(...)` call placed *after* the
decide step and *before* exit.

### Enablement & consent

- `forge telemetry on` → write `~/.claude/forge/telemetry/config.json` `{enabled:true, retentionDays:30}`
  and `~/.claude/forge/telemetry/.gitignore` containing `*` (`BR-TEL-012`).
- `forge telemetry off` → set `{enabled:false}` (keeps the data; stops recording).
- `forge telemetry wipe` → delete the JSONL files (keeps config) — an explicit, additive-safe purge.
- `FORGE_TELEMETRY=1|0` → one-session override that beats the config either way (`BR-TEL-002`).

### Event taxonomy (where each event is emitted)

| event_type | Emitted at | `decision` | Redacted payload (the closed allow-list) |
|---|---|---|---|
| `session.start` | SessionStart (`detect-project.mjs`) | `null` | `tailored:bool` |
| `hook.allow` | any PreToolUse hook, allow path | `allow` | `matcher` |
| `hook.deny` | any PreToolUse hook, deny path | `deny` | `matcher` |
| `secret.catch` | `secret-scan.mjs` deny | `deny` | `label`, `value_sha256`, `value_len` |
| `citation.gate` | `edit-citation-gate.mjs` first-touch | `deny` | `target_sha256`, `first_touch:bool` |
| `config.protect` | `config-protection.mjs` deny | `deny` | `config_kind` |
| `noverify.block` | `block-no-verify.mjs` deny | `deny` | `flag` (enum, e.g. `--no-verify`) |
| `typecheck.run` | `stop-typecheck.mjs` | `pass`/`fail`/`skip` | `duration_ms`, `exit_code`, `fail_count` |
| `agent.invoke` | `invoke-telemetry.mjs` (Task) | `null` | `prompt_len`, `prompt_sha256` |
| `skill.invoke` | `invoke-telemetry.mjs` (Skill) | `null` | `prompt_len`, `prompt_sha256` |
| `validator.run` | CLI (`lint/run-all`) | `pass`/`fail` | `duration_ms`, `finding_count` |
| `eval.run` | CLI (`run-eval`) | `pass`/`fail` | `duration_ms`, `case_id_sha256`, `passed:bool` |

`rule`/`tool`/`artifact_id` are top-level columns (not payload). `artifact_id` is the registry `uid`
(**see BR-REG**) for `agent.invoke`/`skill.invoke`/`validator.run`/`eval.run`, else `null`.

### The new hook: `invoke-telemetry.mjs`

A `PreToolUse` hook matching `Task|Skill`. It exists ONLY to observe agent/skill **starts** — there is no
reliable end event (`BR-TEL-009`). It computes nothing security-relevant, never denies, emits one
`agent.invoke`/`skill.invoke` with `prompt_len`+`prompt_sha256` (never the prompt) and `duration_ms:null`,
and exits 0. It is registered in `hooks/hooks.json` and is a no-op when telemetry is off (the `emit()`
gate makes it free).

### Honest limits (stated as design, not omission)

- **No tokens / cost / model latency.** Not in any hook stdin payload — Anthropic-side. We never write
  such a field; readers never show one (`BR-TEL-009`).
- **No agent/skill end.** `PreToolUse` fires at start; there is no matching end hook. So
  `agent.invoke`/`skill.invoke` durations are `null`, and "most-invoked" is a *count*, not a *time spent*.
- **Real durations only** for `typecheck.run`, `validator.run`, `eval.run`, and per-hook self-timing —
  things forge runs start-to-finish.

## Data structures

### Event line (one JSON object per line; all keys always present)

```jsonc
{
  "v": 1,                              // schema version
  "ts": "2026-06-05T14:03:11.872Z",    // ISO-8601, ms precision (BR-TEL-007)
  "event_type": "secret.catch",        // taxonomy enum
  "artifact_id": null,                 // registry uid (see BR-REG) or null
  "session_id": "abc123_session",      // sanitized [A-Za-z0-9_-]
  "project": "h:9f8b2c1a",             // HASHED "h:<sha8>" — never a real path (BR-TEL-006)
  "decision": "deny",                  // allow|deny|pass|fail|skip|null
  "rule": "secret-scan",               // which hook/rule, or null
  "tool": "Write",                     // tool_name, or null
  "duration_ms": null,                 // real only for runs forge times; else null (BR-TEL-009)
  "payload": { "label": "Anthropic API key", "value_sha256": "…", "value_len": 51 },
  "forge_version": "0.1.0",
  "pid": 48213
}
```

### `PAYLOAD_ALLOW` (closed allow-list, keyed by event_type)

A frozen object mapping each `event_type` to the exact array of payload field names permitted. Anything
not listed is dropped before serialization (`BR-TEL-005`). A forbidden-by-name set
(`content`, `command`, `path`, `prompt`, `value`, `secret`, `env`, `cwd`, `file_path`) is asserted to
appear in **no** allow-list by the meta-test (`BR-TEL-006`, BR-INT). Default (unknown event_type) → `[]`.

### `config.json`

```jsonc
{ "enabled": true, "retentionDays": 30 }   // written only by `forge telemetry on`
```

### On-disk layout (machine-local; `ADR-0003` / C6)

```
~/.claude/forge/telemetry/
  .gitignore                       # "*"  (written by telemetry on; BR-TEL-012)
  config.json                      # {enabled, retentionDays}
  events-2026-06-05.jsonl          # current day, append-only
  events-2026-06-04.jsonl          # prior days, pruned at retentionDays
  events-2026-06-03.00.full        # sealed (size cap reached)
```

## CLI / interface

| Command | Behavior |
|---|---|
| `forge telemetry on` | Opt in: write `config.json {enabled:true,retentionDays:30}` + `.gitignore "*"`. |
| `forge telemetry off` | Stop recording (data kept). |
| `forge telemetry status` | Show enabled?/event count/day span/disk size; off-message if disabled. |
| `forge telemetry prune` | Lazily delete files older than `retentionDays` (`BR-TEL-011`). |
| `forge telemetry wipe` | Delete JSONL files (keep config). |
| `forge stat [--since 7d] [--json]` | Rollup: hook fire counts, deny rates, typecheck fail %, most-invoked agents/skills, slowest hooks p50/p95, daily-trend sparkline. Prunes lazily first. |
| `forge monitor [--watch]` | At-a-glance snapshot; `--watch` live-tails via self-scheduled `setTimeout` (NOT a blocking sleep, NOT a daemon — `ADR-0010`). |

`--json` follows the C3 envelope `{forge, command, ok, ts, data, findings[], summary}` synthesized at the
parent runner (`ADR-0004`). All readers exit 0 and print an off/empty message when there is no data
(`BR-TEL-013`). `forge status` (SPEC-08) composes the `stat` rollup as one panel, with a `(no data — run
forge telemetry on)` stub when off.

## Edge cases & failure modes

- **Telemetry off / no config / no env** → `emit()` returns before any file op; directory stays absent
  (`BR-TEL-001`).
- **`FORGE_TELEMETRY=0` over `{enabled:true}`** → off wins (`BR-TEL-002`).
- **Unwritable dir / full disk / serializer throws** → swallowed; hook decision and exit unaffected
  (`BR-TEL-003`).
- **Secret value in scope** → only `value_sha256`+`value_len` written; a grep for the literal returns zero
  (`BR-TEL-006`).
- **Day rolls over / 16 MiB cap hit** → new day file / sealed `*.full`; both valid JSONL (`BR-TEL-010`).
- **Old files past retention** → removed lazily by `stat`/`prune`; nothing else touched (`BR-TEL-011`).
- **Agent/skill invoked** → start event with `duration_ms:null`; no end event exists (`BR-TEL-009`).
- **Reader run with off/empty store** → off/empty message, exit 0, never a stack trace (`BR-TEL-013`).
- **Consumer (efficiency) with empty store** → degrades to static-only (`BR-TEL-014`; **see BR-EFF**).
- **Partial/older line** (`v` mismatch / missing key) → reader tolerates it; missing values read as
  unknown, never crash.

## Open questions

1. **Per-hook self-timing granularity.** Should every PreToolUse hook self-time and emit `duration_ms`, or
   only the heavy ones? Leaning: time all, since "slowest hooks p50/p95" needs them — carried to build.
2. **`--since` grammar.** `7d`/`24h`/ISO-date — pick one parser shared with `forge stat` (likely reuse a
   `manager/lib` duration parser). Deferred to SPEC-08 CLI conventions.
3. **Sparkline rendering** without a dependency — Unicode block chars (`▁▂▃…`) computed in `stat`; trivial,
   not load-bearing.
4. **Sealed-file inclusion in rollups** — `stat` should read `*.full` too; confirm glob covers both.

## Traceability

- **BRs:** BR-TEL-001..014 (this dimension). `artifact_id` identity → **see BR-REG**; self-validator &
  no-network meta-test → **see BR-INT / ADR-0014**; empty-store consumer constraint → **see BR-EFF**.
- **ADRs:** ADR-0011 (decides this SPEC), ADR-0003 (storage split / machine-local), ADR-0010 (no daemon;
  lazy prune; `monitor --watch` via setTimeout), ADR-0004 (`--json` envelope), ADR-0014 (the meta-test).
- **EVALs:** EVAL-TEL-001..014 in `evals/EVAL-TEL.md` (opt-in default-off, env override, fail-open,
  no-network, redaction allow-list, no-raw-values, schema, taxonomy, honest-durations, rotation, retention,
  machine-local gitignore, graceful-degrade, empty-store consumer).
- **Roadmap:** v0.4 (`ROADMAP.md`). Gate cases: redaction, no-network, opt-in-default-off.
