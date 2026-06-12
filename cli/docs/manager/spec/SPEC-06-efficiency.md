# SPEC-06 — Efficiency & Optimization

Status: design-stage · Phase: v0.3 (static) / v0.6 (dynamic, DEFERRED) · Implements: BR-EFF-001..012 ·
Decided-by: ADR-0013 (criticality safety-lock), ADR-0004 (envelope), ADR-0011 (telemetry), ADR-0012
(grade `U`), ADR-0007 (advisory-first)

## Summary

This dimension answers two questions about the harness, in two clearly-separated phases:

- **v0.3 STATIC (build now)** — *"what does my context cost, and what is structurally dead?"*
  `forge analyze [projectDir]` is a read-only report: a zero-dependency **token-budget estimate** by
  residency class (always-on / conditional / on-demand), an **always-on total** and **per-profile** budget,
  and **static dead-detection** D1–D5 (orphan module/component/file, dangling ref, vacuous path-scoped
  rule). No telemetry needed; D5 needs only `--project`. Deterministic, code-graded.
- **v0.6 DYNAMIC / value-density (DEFERRED)** — *"is each artifact earning its keep?"* dynamic dead-detection
  U1–U4 over a telemetry window, redundancy clustering, the `effScore / costTok` value-density ratio, and
  `forge optimize` (a dry-run prune-plan that never deletes). Deferred per `ideas/01-proportionality.md`:
  each input is weak at `n=1` ("noise in a lab coat"), so it ships only when telemetry (`BR-TEL`) and
  effectiveness (`BR-EVAL`) are real.

Straddling both, and **not deferred**, is the **criticality safety-lock** (`ADR-0013`): a `safety`/
`compliance` artifact can never be classified dead, never enter a prune-plan, and a 0-fire `secret-scan` is
reported as a *success indicator*, not waste. The lock ships in v0.3 the moment anything can call an
artifact "dead".

Numbers from this dimension are **estimates**, always rendered with a leading `~`, never authoritative.

## Design

### Module shape

`forge/manager/efficiency.mjs` exports `run(subcmd, args, ctx)` + `summarize(state)` (`C4`), with a paired
`lint/validate-efficiency.mjs` (auto-discovered, `ADR-0014`). Subcommands: `analyze` (v0.3) and `optimize`
(v0.6). Support code lives under `forge/manager/analyze/`:
- `constants.mjs` — the two tunable estimator constants and the two adequacy thresholds (one place).
- `criticality.json` — the seeded criticality allowlist (`ADR-0013`).
- `estimate.mjs`, `residency.mjs`, `dead-static.mjs` (v0.3); `dead-dynamic.mjs`, `redundancy.mjs`,
  `value-density.mjs`, `plan.mjs` (v0.6).

### Token estimator (BR-EFF-001)

```
estimate(text, dense) =
  base = round( 0.5 * ceil(chars / CHARS_PER_TOKEN) + 0.5 * ceil(words * 1.33) )
  return dense ? round(base * CODE_DENSITY) : base
```
`CHARS_PER_TOKEN = 4`, `CODE_DENSITY = 1.15`, both in `constants.mjs`. `dense = true` for code/JSON-dense
artifacts (validators, engine, `*.json`, fenced-code-heavy bodies). The blend of a char model and a word
model is deliberately crude — it ranks and totals; it does not claim tokenizer accuracy. A **meta-test pins
the estimate** on fixtures so a constant change is a deliberate, reviewed edit (EVAL-EFF-001).

### Residency classes (BR-EFF-002)

| Class | Members | Costed as |
|---|---|---|
| **ALWAYS-ON** | always-on rule **bodies** (no `paths:`); agent/skill/command **descriptions**; hook **description + injection** | full estimate |
| **CONDITIONAL** | path-scoped rule bodies (`paths:` present); agent/skill **bodies**; bundles | full estimate × activation prob |
| **ON-DEMAND** | validators; engine scripts | **0** (never in model context) |

- "Has `paths:`" is read from the rule's frontmatter exactly as forge resolves rules (mirrors
  `findRuleFile` + frontmatter parse). A rule with no `paths:` is always-on (e.g.
  `prompt-defense-baseline`, `security-baseline`, `common/*`); a rule with `paths:` is conditional (e.g.
  `react-patterns`, `python-style`).
- **Hook cost = description + injection.** The `.mjs` source is ON-DEMAND-like (runs in a child process) and
  is **never** counted as context. The injection is estimated by extracting the `permissionDecisionReason`
  / `additionalContext` string literals from the hook source and running them through the estimator. Example:
  `secret-scan` injects only its `BLOCKED: …` reason on a deny, so its always-on cost is `hooks.json`
  description + that reason string — a few dozen tokens, not the size of `secret-scan.mjs`.

### Budgets (BR-EFF-003)

- **Always-on total** = sum of every ALWAYS-ON artifact, itemized. This reproduces the ROADMAP's "`~2,550
  tok`" always-on class **by construction** (summing real items), never by hard-coding the number.
- **Per-profile materialized cost** = resolve the profile via the **same `resolveModules`** the composer
  uses (so deltas from `moduleSelectionRules` are included), then report `alwaysOn` (sum of that profile's
  always-on members) and a `conditional-ceiling` (every conditional member assumed active = worst case).

### Static dead-detection D1–D5 (BR-EFF-004)

| ID | Condition | Needs `--project`? | Source |
|---|---|---|---|
| D1 | module in 0 profiles and not `always:true` | no | profiles.json + modules.json |
| D2 | component in no module | no | modules.json |
| D3 | file on disk in no module | no | disk + modules.json |
| D4 | module names a component with no backing file | no | **see BR-DEP** / SPEC-03 (not re-derived) |
| D5 | path-scoped rule whose `paths:` globs match **0** files | **yes** | rule frontmatter × `--project` tree |

D5 is the **highest-value** static check: it finds rules installed-but-inert *here* (e.g. `react-patterns`
`**/*.tsx` in a pure-Python project). D1–D4 are structural and safe to **recommend** with no telemetry.

### Criticality safety-lock (BR-EFF-006..008, ADR-0013)

- Criticality `safety|compliance|normal` is read from the seeded `criticality.json`, not inferred.
  Seed-tagged `safety`: `secret-scan`, `block-no-verify`, `config-protection`, `prompt-defense-baseline`,
  `security-baseline`. Unlisted = `normal`.
- A `safety`/`compliance` artifact is **filtered out of every dead/prune surface at the data layer** before
  any plan is built — so no surface (`status`, `optimize`, `--json`) can route around the lock.
- Zero-fire safety → reported under **"low-activity safety (expected)"** with the inversion stated
  ("0 fires = no secrets leaked = working"), never under waste/dead/prune.
- **Adequacy gate** for `normal` artifacts: a dynamic-dead verdict needs `sessions ≥ MIN_SESSIONS` (20) AND
  `windowDays ≥ MIN_DAYS` (14); below either, downgrade `prune → watch`. Static D1–D4 are exempt.

### Degrade-to-static (BR-EFF-005)

Telemetry is opt-in/default-off (`ADR-0011`, **see BR-TEL**). When it is off/empty, `analyze` runs the
static half (D1–D5) and prints "dynamic checks unavailable (telemetry off)" — it does **not** emit empty
U-verdicts as if everything were alive, and it never errors. This is the common case at `n=1`.

### Dynamic half (v0.6, DEFERRED): U1–U4, redundancy, value-density, optimize

- **U1** never-fired, **U2** fires-but-never-acts (hook `fires>0`, `0` denies), **U3** never-cited rule,
  **U4** bundle never loaded — all keyed on telemetry (**see BR-TEL**), all behind the lock + adequacy gate.
- **Redundancy** — Jaccard k-shingle: bodies `k=5` (`J≥0.35` candidate, `≥0.6` strong); descriptions `k=3`
  (`J≥0.5`). Self-declared floor/ceiling layering (`security-baseline` over `common/security`) is surfaced
  as a **de-flag hint**, not a redundancy.
- **Value-density** = `effScore / costTok` (`effScore` **see BR-EVAL**; `costTok` = estimate × activation
  prob). Quadrants `keeper | justified | harmless | prune-candidate`. Hard floors: grade `U`/coverage `0`
  ⇒ `value-density = null` (not `0`) ⇒ `needs-eval`, never prune; `safety`/`compliance` ⇒ forced keeper.
  Declared **low-confidence** (an LLM-judged score over an estimated token count).
- **`forge optimize`** — dry-run prune-plan only; never deletes. Recommendation shape
  `{check-id, confidence, recoverableTokens, evidence, safetyLocked:false}`; safety-locked artifacts in a
  separate non-actionable "considered & excluded" section; `--emit-plan` writes `optimize.plan.json`. A/B
  variant compare via `run-eval` (cost axis here, effectiveness axis **see BR-EVAL**).

## Data structures

```jsonc
// analyze report (data field of the --json envelope, ADR-0004)
{
  "constants": { "CHARS_PER_TOKEN": 4, "CODE_DENSITY": 1.15,
                 "MIN_SESSIONS": 20, "MIN_DAYS": 14 },
  "telemetry": { "available": false, "sessions": 0, "windowDays": 0 },  // drives degrade-to-static
  "artifacts": [
    { "uid": "rule:prompt-defense-baseline", "residency": "always-on",
      "estTokens": 280, "criticality": "safety" },
    { "uid": "hook:secret-scan", "residency": "always-on",
      "estTokens": 96, "costBreakdown": { "description": 38, "injection": 58 },
      "criticality": "safety" },
    { "uid": "validator:validate-rules", "residency": "on-demand", "estTokens": 0, "criticality": "normal" }
  ],
  "alwaysOnTotal": 2550,                       // itemized sum, reproduces ROADMAP figure
  "perProfile": {
    "generic": { "alwaysOn": 2550, "conditionalCeiling": 4100 }
  },
  "deadStatic": [
    { "checkId": "D5", "uid": "rule:react-patterns",
      "evidence": "paths **/*.tsx matched 0 files in <project>", "recommend": true }
  ],
  "deadDynamic": [],                            // [] + telemetry.available:false ⇒ degraded, not "all alive"
  "lowActivitySafety": [                        // BR-EFF-007: success, NOT waste
    { "uid": "hook:secret-scan", "fires": 0, "note": "0 fires = no secrets leaked = working" }
  ]
}
```

```jsonc
// optimize.plan.json (v0.6, --emit-plan). NEVER contains a safetyLocked:true recommendation.
{
  "recommendations": [
    { "checkId": "U1", "uid": "rule:some-normal-rule", "confidence": "med",
      "recoverableTokens": 180, "evidence": "0 cites over 42 sessions / 31 days", "safetyLocked": false }
  ],
  "consideredAndExcluded": [                    // non-actionable; safety-locked live ONLY here
    { "uid": "hook:secret-scan", "reason": "criticality=safety (ADR-0013)", "safetyLocked": true }
  ]
}
```

## CLI / interface

```
forge analyze [projectDir] [--project <dir>] [--json]      # v0.3 read-only report; D5 needs --project
forge optimize [--emit-plan] [--json]                       # v0.6 dry-run prune-plan; never deletes
```
- `analyze` writes nothing. `optimize` writes nothing except `optimize.plan.json` under `--emit-plan`.
- Both emit the standard envelope `{forge, command, ok, ts, data, findings[], summary}` (`ADR-0004`,
  `C2`/`C3`); per-finding shape `{level, path, line, message, source}`.
- Both fail-open: any internal error degrades to a partial report, never a non-zero block (`C4`, invariant #4).

## Edge cases & failure modes

- **Telemetry off/empty (the common case):** degrade to static-only; print "dynamic unavailable"; never
  fabricate liveness; never error (BR-EFF-005).
- **The inversion (critical):** a 0-fire `secret-scan` reads as "unused" to every usage signal. The lock
  filters it from all dead/prune surfaces at the data layer and reports it as success (BR-EFF-006/007). This
  is the single most important regression in EVAL-EFF (EVAL-EFF-006, `pass^k=1.00`).
- **Thin window:** `sessions < 20` or `windowDays < 14` ⇒ dynamic-dead verdicts downgrade to `watch`; static
  orphans still recommended (BR-EFF-008).
- **Unknown effectiveness:** grade `U`/coverage `0` ⇒ value-density `null`, route `needs-eval`, never prune
  (BR-EFF-011; distinct from the safety lock — both must hold).
- **Intentional layering:** `security-baseline` over `common/security` overlaps by design; surfaced as a
  de-flag hint, not redundancy (BR-EFF-010).
- **No `--project` for D5:** D5 is skipped with a note ("D5 needs --project"); D1–D4 still run.
- **Hook with no injection literal:** injection estimate is `0`; cost is description only (still ALWAYS-ON).

## Open questions

- **Activation probability source.** v0.3 uses a fixed default (e.g. `0.5`) for the conditional ceiling;
  v0.6 should derive per-artifact activation from telemetry. Carried to v0.6 with the dynamic half.
- **`compliance` artifacts.** The tag is reserved but the seed harness ships none; revisit the seed when the
  first compliance artifact lands.
- **`recoverableTokens` accounting for shared bodies.** If two flagged artifacts share shingles, naive
  summation over-counts savings; v0.6 needs a de-dup pass. Deferred.
- **Promoting `analyze` figures to gates.** Always advisory now (`ADR-0007`); a budget-ceiling gate is only
  considered if a real budget pain appears — explicit, opt-in, later.

## Traceability

- **BRs:** BR-EFF-001 (estimator), -002 (residency), -003 (budgets), -004 (static dead D1–D5), -005
  (degrade-to-static), -006/-007/-008 (criticality lock + zero-fire success + adequacy gate), -009 (dynamic
  dead), -010 (redundancy), -011 (value-density + `U≠0`), -012 (`optimize`).
- **ADRs:** ADR-0013 (safety-lock — primary), ADR-0004 (envelope), ADR-0011 (telemetry), ADR-0012 (grade
  `U`), ADR-0007 (advisory-first), ADR-0014 (paired self-validator).
- **Foreign refs (by prefix):** BR-EVAL (`effScore`, grade `U`, coverage, A/B effectiveness axis), BR-TEL
  (telemetry events, opt-in/default-off), BR-DEP (D4 dangling-ref resolution).
- **EVALs:** EVAL-EFF-001 (pinned estimate), -002 (residency), -003 (budgets/per-profile), -004 (D1–D4),
  -005 (D5 vacuous rule), -006 (0-fire `secret-scan` never pruned — critical regression), -007 (adequacy
  downgrade), -008 (`U`→needs-eval), -009 (degrade-to-static), -010 (dynamic U1), -011 (redundancy/layering),
  -012 (value-density quadrants), -013 (`optimize` dry-run + excluded section).
