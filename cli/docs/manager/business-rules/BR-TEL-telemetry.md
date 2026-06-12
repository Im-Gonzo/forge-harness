# Business Rules — Telemetry & Monitoring (BR-TEL)

Normative rules for the telemetry dimension. Telemetry is **opt-in, default off, local-only, redacted on
write, with no network path** (`ADR-0011`), detailed in `SPEC-05`. Every `MUST` rule below names the
`EVAL-TEL-NNN` case that proves it. Foreign artifact identity (`artifact_id`) is the registry `uid` —
**see BR-REG**. The telemetry self-validator and no-network meta-test are **see BR-INT / ADR-0014**. The
downstream consumer that this dimension constrains is **see BR-EFF**.

All rules are **Phase v0.4** unless noted.

---

### BR-TEL-001 — Opt-in: default off records nothing

**Rule:** With no `~/.claude/forge/telemetry/config.json` and no `FORGE_TELEMETRY` env override, `emit()`
MUST be a pure no-op: it MUST NOT create, open, or append to any telemetry file, and the telemetry
directory MUST remain absent on a fresh install. Telemetry is recorded only after explicit consent via
`forge telemetry on` (writes `config.json {enabled:true, retentionDays:30}`) or `FORGE_TELEMETRY=1`.

**Rationale:** Privacy is the default (README invariant 6). A fresh user must be observed by nothing; data
collection requires a single explicit act of consent (`ADR-0011`).

**Acceptance:** Run a hook decision with no config and no env → zero JSONL lines written and no telemetry
directory created. Verified by `EVAL-TEL-001`.

**Priority:** MUST
**Refs:** ADR-0011, SPEC-05 §Design, README invariant 6.

---

### BR-TEL-002 — Env override beats config

**Rule:** `FORGE_TELEMETRY` MUST override `config.json` when set: `FORGE_TELEMETRY=1` enables emission even
if the config is absent or `{enabled:false}`; `FORGE_TELEMETRY=0` disables emission even if the config is
`{enabled:true}`. Any other/unset value defers to `config.json` (default off).

**Rationale:** A user needs a one-session escape hatch (force on to debug, force off for a sensitive
session) without editing persisted state.

**Acceptance:** `FORGE_TELEMETRY=0` with `enabled:true` config → no events; `FORGE_TELEMETRY=1` with no
config → events written. Verified by `EVAL-TEL-002`.

**Priority:** MUST
**Refs:** ADR-0011, SPEC-05 §Design.

---

### BR-TEL-003 — Fail-open: a broken emit never blocks

**Rule:** `emit()` MUST be wrapped so that *any* failure (unwritable directory, full disk, malformed
event, throwing serializer) is swallowed and control returns normally. It MUST be called **after** the
hook's deny/allow decision is computed, so it cannot alter that decision. A telemetry failure MUST NOT
change a hook's exit code, MUST NOT emit a `permissionDecision`, and MUST NOT block a tool call.

**Rationale:** Fail-open is a foundational invariant (README invariant 4). Telemetry is observation, never
enforcement; it must inherit the hooks' "exit 0 no matter what" guarantee.

**Acceptance:** A hook whose `emit()` is forced to throw still produces the correct allow/deny on stdout
and exits 0; an unwritable telemetry dir does not change hook behavior. Verified by `EVAL-TEL-003`.

**Priority:** MUST
**Refs:** ADR-0011, README invariant 4, C4 (fail-open module contract).

---

### BR-TEL-004 — No network surface (local-only, by construction)

**Rule:** `hooks/lib/telemetry.mjs` and the telemetry CLI readers MUST contain no network code path: no
`fetch`, no `node:http`/`https`, no `node:net`/`dgram`/`dns`/`tls`, no `node:child_process`, no socket of
any kind. `emit()` MUST perform **exactly one** `appendFileSync` and no other I/O that could exfiltrate.

**Rationale:** "Local-only / no exfiltration" must be a *tested* invariant, not a promise (`ADR-0011`,
`ideas/02` non-goals). Redacted data still must not be able to leave the machine.

**Acceptance:** A meta-test greps the telemetry sources and asserts zero matches for the forbidden network
identifiers; a behavioral check confirms `emit()` opens no socket. Verified by `EVAL-TEL-004`.

**Priority:** MUST
**Refs:** ADR-0011, ADR-0014 (forge-validates-forge), BR-INT, ideas/02 non-goals.

---

### BR-TEL-005 — Redaction-on-write via a closed payload allow-list

**Rule:** `emit()` MUST enforce a closed `PAYLOAD_ALLOW` allow-list keyed by `event_type`. Every field in
`event.payload` that is not on that event type's list MUST be dropped **before** serialization. An
event_type with no entry in `PAYLOAD_ALLOW` MUST serialize with an empty payload. The redaction MUST
happen before the byte reaches disk (redact-on-write, never redact-on-read).

**Rationale:** If a raw value is never written, it cannot leak (`ADR-0011`). A closed allow-list (drop by
default) is safe against new code adding a field that forgets to redact.

**Acceptance:** An event carrying an extra non-whitelisted field (e.g. `raw_path`, `command`) writes a
JSONL line whose `payload` omits that field. Verified by `EVAL-TEL-005`.

**Priority:** MUST
**Refs:** ADR-0011, SPEC-05 §Data structures.

---

### BR-TEL-006 — Never store contents, secrets, raw paths, commands, prompts, or env

**Rule:** The serialized JSONL MUST NEVER contain file contents, secret values, raw filesystem paths,
shell command strings, prompt text, or environment variables. Sensitive subjects MUST be reduced to
hashes/lengths/counts/enums/booleans: a secret is recorded as `value_sha256` + `value_len` (never the
value); a prompt as `prompt_sha256` + `prompt_len` (never the prompt); a citation target / project as a
sha (`target_sha256`, `project:"h:<sha8>"`), never the literal.

**Rationale:** The security hooks (`secret-scan`) handle secrets; telemetry observing them must not become
the leak. Hashing preserves "same value / did it change" without retaining the value.

**Acceptance:** A `secret.catch` event for a known secret value writes only its sha256 + length; a grep of
the entire JSONL for the literal secret returns zero matches. Verified by `EVAL-TEL-006`.

**Priority:** MUST
**Refs:** ADR-0011, BR-TEL-005, secret-scan hook contract.

---

### BR-TEL-007 — Event schema is fixed and uniform

**Rule:** Every emitted line MUST be a single JSON object on one line with exactly the fields:
`v, ts, event_type, artifact_id, session_id, project, decision, rule, tool, duration_ms, payload,
forge_version, pid`. `ts` MUST be ISO-8601 with millisecond precision; `decision` MUST be one of
`allow | deny | pass | fail | skip | null`; `project` MUST be the hashed form `"h:<sha8>"`; `artifact_id`
MUST be a registry `uid` (**see BR-REG**) or `null`; absent values MUST be `null`, never omitted, so the
line is self-describing.

**Rationale:** A uniform, self-describing line lets `forge stat` roll up without schema negotiation and
lets a partial/older line still parse (forward/backward tolerance).

**Acceptance:** Every emitted line parses as JSON, carries all required keys, and a known event matches the
fixed shape (decision enum, ISO-ms ts, hashed project). Verified by `EVAL-TEL-007`.

**Priority:** MUST
**Refs:** ADR-0011, SPEC-05 §Data structures, BR-REG (artifact_id = uid).

---

### BR-TEL-008 — Taxonomy coverage at the real decision sites

**Rule:** The decision sites of the existing hooks MUST emit their taxonomy event (after the decision):
`hook.allow` / `hook.deny` (with `rule`, `tool`), `secret.catch` (label + `value_sha256` + `value_len`),
`citation.gate` (`target_sha256`, `first_touch`), `typecheck.run` (`duration_ms`, `exit_code`,
`fail_count`), `config.protect`, `noverify.block`, `session.start`. Agent/skill starts MUST be emitted by
a new `PreToolUse` hook `invoke-telemetry.mjs` matching `Task|Skill` (`agent.invoke` / `skill.invoke`,
`prompt_len` + `prompt_sha256`, never the prompt). `validator.run` / `eval.run` MUST be emitted CLI-side
with their real measured duration.

**Rationale:** Coverage is the point — the events are what make `forge stat` answer the temporal questions
forge lacks. Each event is attached to a real decision/run site, not synthesized.

**Acceptance:** Driving each hook/CLI site with telemetry on produces exactly one event of the expected
`event_type` with the expected redacted payload shape. Verified by `EVAL-TEL-008`.

**Priority:** MUST
**Refs:** ADR-0011, SPEC-05 §Design (taxonomy table), hooks.json.

---

### BR-TEL-009 — Durations are honest; unknown is null, never zero

**Rule:** `duration_ms` MUST be a real measured wall-clock value ONLY for events forge runs start-to-end:
`typecheck.run`, `validator.run`, `eval.run`, and per-hook self-timing. For start-only events
(`agent.invoke`, `skill.invoke`) and for any event with no meaningful duration, `duration_ms` MUST be
`null` (or `0` only where genuinely instantaneous and documented). Telemetry MUST NOT fabricate an end
time or a model/token/cost number it cannot observe.

**Rationale:** The observability ceiling is physics (`ideas/02` "Honest limits"): hooks cannot see
agent/skill end, tokens, cost, or model latency. Reporting a fake duration is worse than reporting none.

**Acceptance:** An `agent.invoke` event has `duration_ms:null`; a `typecheck.run` event has a positive
measured `duration_ms`; no event carries a token/cost field. Verified by `EVAL-TEL-009`.

**Priority:** MUST
**Refs:** ADR-0011, ideas/02 "Honest limits", SPEC-05 §Edge cases.

---

### BR-TEL-010 — Daily rotation and a hard size cap

**Rule:** Events MUST be appended to a per-day file `events-YYYY-MM-DD.jsonl` (UTC date). When the current
day's file reaches the size cap (default 16 MiB), `emit()` MUST seal it (rename to `events-YYYY-MM-DD.full`
or `events-YYYY-MM-DD.NN.full`) and start a fresh file, so a runaway day can never grow unbounded and
sealing MUST itself be fail-open (a seal failure degrades to "stop emitting today", never an error).

**Rationale:** Append-only without rotation grows forever; a per-day cap bounds disk use without a daemon
and keeps each file tailable.

**Acceptance:** Emitting past the (test-lowered) cap produces a sealed `*.full` file plus a fresh current
file; both remain valid JSONL. Verified by `EVAL-TEL-010`.

**Priority:** SHOULD
**Refs:** ADR-0011, SPEC-05 §Design (storage), ADR-0010 (no daemon).

---

### BR-TEL-011 — Lazy retention pruning (no daemon)

**Rule:** Retention MUST be enforced lazily — never by a background process (`ADR-0010`). `forge stat` and
`forge telemetry prune` MUST delete telemetry files (current + sealed) older than `retentionDays` (default
30) at the time the command runs. Pruning MUST be additive-safe: it deletes only telemetry files under
`~/.claude/forge/telemetry/`, never anything else, and MUST be fail-open.

**Rationale:** No daemon (`ADR-0010`); pruning rides commands the user already runs. Bounded retention
keeps the store small and old observations from lingering.

**Acceptance:** Files older than `retentionDays` are removed by `forge telemetry prune`; newer files and
non-telemetry files are untouched. Verified by `EVAL-TEL-011`.

**Priority:** SHOULD
**Refs:** ADR-0011, ADR-0010, SPEC-05 §CLI.

---

### BR-TEL-012 — Storage is machine-local and physically un-committable

**Rule:** All telemetry MUST live under `~/.claude/forge/telemetry/` (the machine-local side of the
storage split, `ADR-0003` / C6) and MUST NEVER be written under the git-tracked `forge/.forge/`.
`forge telemetry on` MUST write a `.gitignore` of `*` into that directory. No telemetry file MUST ever be
treated as authoritative.

**Rationale:** Local-only/privacy (README invariant 6) and the storage split (C6): machine-local data is
never authoritative and physically cannot be committed.

**Acceptance:** Enabling telemetry creates `~/.claude/forge/telemetry/.gitignore` containing `*`; no
telemetry path resolves under `forge/.forge/`. Verified by `EVAL-TEL-012`.

**Priority:** MUST
**Refs:** ADR-0011, ADR-0003, C6, README invariant 6.

---

### BR-TEL-013 — Readers degrade gracefully when telemetry is off or empty

**Rule:** `forge stat`, `forge monitor`, and `forge telemetry status` MUST NOT error when telemetry is off
or the store is empty. They MUST print a clear, actionable message (e.g. `telemetry is off — run forge
telemetry on`) and exit 0. The `status` panel composed into `forge status` MUST render a `(no data)` stub
in the same case (`SPEC-08`).

**Rationale:** Every dimension degrades gracefully when its upstream signal is absent (`ideas/01` discipline
rule). A reporting command must never punish a user for not opting in.

**Acceptance:** Running each reader with telemetry off (and with telemetry on but an empty store) prints
the off/empty message and exits 0. Verified by `EVAL-TEL-013`.

**Priority:** MUST
**Refs:** ADR-0011, ideas/01 discipline rule, SPEC-08, BR-CLI.

---

### BR-TEL-014 — Consumers must tolerate the empty store (no data at n=1)

**Rule:** Because telemetry is opt-in/default-off, downstream dynamic detection (efficiency
value-density / dead-artifact, **see BR-EFF**) MUST treat an absent or empty telemetry store as a valid
state and **degrade to static-only**, never assuming events exist. Telemetry MUST NOT be a hard
prerequisite of any other dimension; it is an *optional enrichment*.

**Rationale:** A fresh `n=1` install may have zero telemetry forever (`ADR-0011` known risk). Any
dimension that hard-depends on telemetry would be permanently broken for such a user; the dependency must
be soft.

**Acceptance:** With telemetry off/empty, the efficiency dynamic path falls back to its static result and
reports `(dynamic: no telemetry — static only)` rather than failing. Verified by `EVAL-TEL-014` (paired
with `EVAL-EFF`). **See BR-EFF.**

**Priority:** MUST
**Refs:** ADR-0011, BR-EFF, SPEC-06, ideas/01 proportionality.
