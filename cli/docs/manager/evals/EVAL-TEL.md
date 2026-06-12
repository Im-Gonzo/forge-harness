# EVAL-TEL — Telemetry & Monitoring acceptance specs

Acceptance specs for the telemetry dimension (`SPEC-05`, `BR-TEL`, `ADR-0011`). All cases are **RED**
today — telemetry is unbuilt; a case that passes before any code exists is mis-specified
(`evals/README.md`). Phase **v0.4**. Graders are **code** (deterministic) throughout — every telemetry
check is decidable by a script, so `Target` is `pass^k=1.00`. Fixtures run in-process against a temp
`HOME`/`~/.claude/forge/telemetry/` and a stubbed hook stdin payload, except the no-network case which
also greps source. The three **gate** cases (`ROADMAP.md` v0.4) are EVAL-TEL-001 (opt-in default-off),
EVAL-TEL-004 (no-network), and EVAL-TEL-006 (redaction / a secret never appears).

---

### EVAL-TEL-001 — Opt-in: default off records nothing

- **Verifies:** BR-TEL-001
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** a fresh temp `HOME` with no `~/.claude/forge/telemetry/config.json` and `FORGE_TELEMETRY`
  unset.
- **When:** a hook decision site calls `emit()` (e.g. a `Write` that triggers an allow path).
- **Then:** no JSONL line is written, and `~/.claude/forge/telemetry/` does not exist afterward.
- **Fixture:** temp HOME; stubbed PreToolUse payload; `emit()` invoked directly.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-002 — Env override beats config

- **Verifies:** BR-TEL-002
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** (a) `config.json {enabled:true}` with `FORGE_TELEMETRY=0`; (b) no config with
  `FORGE_TELEMETRY=1`.
- **When:** `emit()` is called in each case.
- **Then:** case (a) writes **zero** lines; case (b) writes **one** line.
- **Fixture:** temp HOME; two env permutations.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-003 — Fail-open: a broken emit never blocks

- **Verifies:** BR-TEL-003
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** telemetry on, but the telemetry dir is forced unwritable (or `appendFileSync` is stubbed to
  throw).
- **When:** a hook (e.g. `secret-scan`) reaches its deny path and then calls `emit()`.
- **Then:** the hook still writes the correct `permissionDecision: deny` to stdout and exits 0; the thrown
  emit changes neither the decision nor the exit code.
- **Fixture:** read-only telemetry dir; stubbed deny payload; capture stdout + exit code.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-004 — No network surface (local-only, by construction)  [GATE]

- **Verifies:** BR-TEL-004
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** the telemetry sources `hooks/lib/telemetry.mjs`, `hooks/invoke-telemetry.mjs`, and
  `forge/manager/telemetry.mjs`.
- **When:** `tests/meta/telemetry-no-network.mjs` greps them for forbidden identifiers (`fetch`,
  `node:http`/`https`, `node:net`/`dgram`/`dns`/`tls`, `child_process`, `Socket`) and runs `emit()` under
  a stub that fails any socket open.
- **Then:** zero matches for every forbidden identifier, and `emit()` performs exactly one `appendFileSync`
  and opens no socket.
- **Fixture:** the source files; a socket-trap stub.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-005 — Redaction-on-write via the closed payload allow-list

- **Verifies:** BR-TEL-005
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** telemetry on; an event whose `payload` carries both whitelisted and **non**-whitelisted fields
  (e.g. a `secret.catch` payload with an extra `raw_path` and `command`).
- **When:** `emit()` serializes it.
- **Then:** the written line's `payload` contains exactly the allow-listed keys for that `event_type` and
  omits `raw_path`/`command`; an `event_type` absent from `PAYLOAD_ALLOW` serializes with `payload:{}`.
- **Fixture:** event objects with planted extra fields.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-006 — A secret value never appears in JSONL (only hash + length)  [GATE]

- **Verifies:** BR-TEL-006, BR-TEL-005
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** telemetry on; a known fixture secret value `S` flowing through a `secret.catch` emit.
- **When:** the event is written and the entire telemetry store is read back.
- **Then:** the JSONL contains `value_sha256 == sha256(S)` and `value_len == S.length`, and a grep of the
  whole store for the literal `S` (and for any raw path/command/prompt) returns **zero** matches. The
  `PAYLOAD_ALLOW` meta-assertion confirms no forbidden field name (`value`, `content`, `command`, `path`,
  `prompt`, `env`) is whitelisted for any event type.
- **Fixture:** a planted fake secret string; full-store grep.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-007 — Event schema is fixed and uniform

- **Verifies:** BR-TEL-007
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** telemetry on; a representative emit.
- **When:** the line is parsed.
- **Then:** it is valid JSON with exactly the keys `v, ts, event_type, artifact_id, session_id, project,
  decision, rule, tool, duration_ms, payload, forge_version, pid`; `ts` matches ISO-8601 ms; `decision` is
  in `{allow,deny,pass,fail,skip,null}`; `project` matches `^h:[0-9a-f]{8}$`; absent values are `null`
  (never omitted).
- **Fixture:** a single emitted line; schema assertions.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-008 — Taxonomy coverage at the real decision sites

- **Verifies:** BR-TEL-008
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** telemetry on; stubbed payloads driving each site: `secret-scan` deny, `edit-citation-gate`
  first-touch, `config-protection` deny, `block-no-verify` deny, an allow path, `stop-typecheck`,
  `invoke-telemetry` for `Task` and `Skill`, and CLI `validator.run`/`eval.run`.
- **When:** each site runs once.
- **Then:** each produces exactly one event of the expected `event_type` with the expected redacted payload
  shape (`secret.catch`→{label,value_sha256,value_len}; `citation.gate`→{target_sha256,first_touch};
  `typecheck.run`→{duration_ms,exit_code,fail_count}; `agent.invoke`/`skill.invoke`→{prompt_len,
  prompt_sha256}; etc.).
- **Fixture:** one stubbed payload per site.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-009 — Durations are honest; unknown is null, never zero, and no token/cost fields

- **Verifies:** BR-TEL-009
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** telemetry on; an `agent.invoke` emit and a `typecheck.run` emit (the latter timing a real
  short command).
- **When:** both are written.
- **Then:** `agent.invoke.duration_ms === null`; `typecheck.run.duration_ms` is a number `>= 0`; **no**
  event anywhere carries a `tokens`/`cost`/`model_latency` field.
- **Fixture:** a fast real command to time; an agent-start payload.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-010 — Daily rotation and a hard size cap

- **Verifies:** BR-TEL-010
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** telemetry on with a test-lowered size cap.
- **When:** events are emitted past the cap.
- **Then:** the day file is sealed to a `*.full` sibling and a fresh `events-YYYY-MM-DD.jsonl` continues;
  both files are valid JSONL (every line parses); a seal failure degrades to "stop emitting", never throws.
- **Fixture:** lowered cap; a burst of events.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-011 — Lazy retention pruning (no daemon)

- **Verifies:** BR-TEL-011
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** a store with files dated older than `retentionDays`, newer telemetry files, and an unrelated
  non-telemetry file in a sibling dir.
- **When:** `forge telemetry prune` (and, separately, `forge stat`) runs.
- **Then:** files older than `retentionDays` (current + sealed) are deleted; newer telemetry files survive;
  the non-telemetry file is untouched; no background process is started.
- **Fixture:** back-dated files via mtime; a control file outside `telemetry/`.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-012 — Storage is machine-local and physically un-committable

- **Verifies:** BR-TEL-012
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** a temp HOME and FORGE_ROOT.
- **When:** `forge telemetry on` runs, then an emit occurs.
- **Then:** `~/.claude/forge/telemetry/.gitignore` exists and contains `*`; every telemetry path resolves
  under `~/.claude/forge/telemetry/` and **none** resolves under the git-tracked `forge/.forge/`.
- **Fixture:** temp HOME; path-resolution assertions.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-013 — Readers degrade gracefully when off or empty

- **Verifies:** BR-TEL-013
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** (a) telemetry off; (b) telemetry on but an empty store.
- **When:** `forge stat`, `forge monitor`, and `forge telemetry status` run in each case.
- **Then:** each prints an actionable off/empty message (matching `/telemetry is off|no data/`) and exits
  **0** — never a stack trace; the `--json` envelope is well-formed with `ok:true` and empty `data`.
- **Fixture:** off-config and empty-store states; capture stdout + exit code.
- **Phase:** v0.4 · **Status:** GREEN

---

### EVAL-TEL-014 — Consumers tolerate the empty store (no data at n=1)

- **Verifies:** BR-TEL-014
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given:** telemetry off/empty.
- **When:** the efficiency dynamic-detection path (**see BR-EFF / EVAL-EFF**) runs.
- **Then:** it does not error and does not assume events exist — it returns its **static-only** result and
  reports `(dynamic: no telemetry — static only)`. Telemetry being absent is treated as a valid state,
  never a hard prerequisite.
- **Fixture:** empty telemetry store; the efficiency static fixture (shared with `EVAL-EFF`).
- **Phase:** v0.4 · **Status:** GREEN
