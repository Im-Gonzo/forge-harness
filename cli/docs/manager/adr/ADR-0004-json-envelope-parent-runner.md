# ADR-0004: Machine-readable `--json` — synthesized at the PARENT runner, zero child changes

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.2

## Context

`forge status`, CI, and any tool wrapping the manager need machine-readable output. Forge has **11
auto-discovered validators** plus **5 meta-tests**, each a standalone script that prints human lines and
exits 0/1. The naive path — teach every child validator a `--json` mode — is 16+ coordinated edits to
files written in parallel by separate agents, with 16 chances to diverge on shape. But there is already a
shared structure to exploit: `lint/run-all.mjs` and `tests/run-meta.mjs` **already spawn each child with
`spawnSync` and capture its `stdout`, `stderr`, and `status`** (run-all.mjs lines ~66-82). And every
validator already prints findings in a regular `LEVEL path:line message` form. The machine layer can be
synthesized *at the parent* from data the parent already has.

## Decision

**Add `--json` at the PARENT runners (`lint/run-all.mjs`, `tests/run-meta.mjs`) by parsing each captured
child's lines into `findings[]`. Zero child-validator changes. This is the single highest-leverage build
in the corpus.**

- **Parse, don't re-instrument.** The parent already holds each child's `stdout`. Under `--json` it runs
  every captured line through the canonical finding regex (C2):
  `^(ERROR|WARN|INFO)\s+(\S+?)(?::(\d+))?\s+(.*)$` → `{ level, path, line, message, source }`, where
  `source` is the child validator's filename. Lines that don't match are not findings (they're banner/
  summary text) and are ignored for `findings[]` (optionally retained as `raw` for `--strict` debugging).
- **No child touched.** Every existing `validate-*.mjs` / meta-test stays byte-for-byte as is. The
  contract they must honor is only the *output line format they already produce*. This is why the C2
  finding shape and the `LEVEL path:line message` print form are foundational — they make the parent
  parse total.
- **One envelope (C3).** The parent emits exactly:
  ```json
  { "forge": "<version>", "command": "validate", "ok": true, "ts": "<ISO>",
    "data": { "validators": [ { "file": "...", "status": "passed", "code": 0 } ] },
    "findings": [ { "level": "WARN", "path": "...", "line": 12, "message": "...", "source": "validate-xref.mjs" } ],
    "summary": { "errors": 0, "warnings": 1, "info": 0, "passed": 11, "failed": 0 } }
  ```
  `ok` is `summary.errors === 0` (and no failed/errored child). The same writer (`manager/lib/json-out.mjs`)
  serializes every command's envelope, so the shape is defined once.
- **The manager inherits it for free.** `forge validate --json` and `forge doctor --json` pass `--json`
  through to the runners; new manager groups (`registry`, `status`, …) return `{ ok, data, findings[],
  summary }` from `run()` (ADR-0001) and the dispatcher wraps it in the *same* envelope. There is one
  machine shape across the whole tool, whether the source is an unmodified child validator or a new
  module.

## Consequences

**Positive**
- Machine-readability for the *entire existing harness* in two files, with no risk to the 16 validators.
- `forge status` composes by parsing runner JSON, not by re-running prose parsing per panel.
- The C2/C3 invariants get a single enforcement point; a future validator automatically participates by
  printing the standard line — no `--json` plumbing required of its author.

**Negative**
- A child that prints a finding in a *non-standard* shape silently won't appear in `findings[]`. Mitigated:
  the line format is already the de-facto convention, and a meta-test can sample-assert conformance
  (findings-shape, EVAL-INT). The fallback `raw` capture means nothing is lost, only unclassified.
- Multi-line messages aren't captured as one finding (one line = one finding). Accepted; validators emit
  one line per finding by convention.

**Neutral**
- Human mode is unchanged (the parent still streams child stdout as today); `--json` is purely additive
  and suppresses the human banner in favor of the envelope.

## Alternatives considered

- **`--json` in every child validator.** Rejected: 16 coordinated edits, 16 divergence risks, and it
  re-implements the same serialization 16 times. The parent already has the data.
- **A separate `forge report` that re-runs and screen-scrapes.** Rejected: double execution, and scraping
  is exactly what parsing-at-the-parent does cleanly with the captured buffers.
- **Structured IPC (children emit JSON on fd 3).** Rejected: requires changing every child anyway, and
  loses the human stream; the line-parse gets 100% of the value with 0% of the child churn.

## Related

ADR-0001 (modules return data the dispatcher renders into this envelope), ADR-0007 (advisory gates surface
as `WARN` findings here), ADR-0014 (validators feed this; the manager is validated through it). C2
(finding shape), C3 (envelope), C5 (advisory levels), BR-CLI, BR-INT, SPEC-08, SPEC-09,
EVAL-CLI, EVAL-INT.
