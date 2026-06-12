# Business Rules — Efficiency & Optimization (BR-EFF)

> Two clearly-separated halves, per `ideas/01-proportionality.md`:
> - **STATIC (v0.3, build now)** — context-budget accounting and static dead-detection. Cheap, data-free
>   (one needs `--project`), deterministic, code-graded. This is the proportionate half.
> - **DYNAMIC / value-density (v0.6, DEFERRED)** — usage-derived deadness, redundancy, and the
>   `effScore / costTok` ratio. Each stacks a weak signal on a weak signal at `n=1` ("noise in a lab
>   coat"); deferred until both telemetry (`BR-TEL`) and effectiveness (`BR-EVAL`) inputs are real.
>
> The criticality safety-lock (`BR-EFF-006`–`008`, `ADR-0013`) straddles both: it is **not deferred** — it
> ships in v0.3 the moment any artifact can be called "dead", because it is the guard, not the feature.
>
> Cross-bundle refs by prefix only: effectiveness/grade-`U` = **see BR-EVAL**; telemetry events =
> **see BR-TEL**; dangling-ref resolution = **see BR-DEP**.
> All token figures are **estimates**, always rendered with a leading `~`. Numbers are never authoritative.

---

## STATIC half — v0.3 (build now)

### BR-EFF-001 — `forge analyze` is read-only and estimates, never measures, tokens

**Rule:** `forge analyze [projectDir]` MUST be a **read-only** report (writes nothing; honors fail-open and
dry-run-by-default, `C4`). It MUST estimate each artifact's token cost with a **zero-dependency** estimator
(`node:` builtins only, invariant #1): `estimate = round(0.5 * ceil(chars/4) + 0.5 * ceil(words * 1.33))`,
multiplied by `CODE_DENSITY` for code/JSON-dense artifacts. The two constants `CHARS_PER_TOKEN = 4` and
`CODE_DENSITY = 1.15` MUST live in exactly one place, `forge/manager/analyze/constants.mjs`. Every reported
figure MUST be labeled as an estimate (a leading `~`).

**Rationale:** A real tokenizer is a heavyweight dependency forbidden by invariant #1; a blended
char/word heuristic is good enough to rank artifacts and total an always-on budget, *provided* it is never
dressed up as exact. One constants module keeps the estimate tunable and pin-testable.

**Acceptance:** On a pinned fixture set, `analyze` produces the exact expected `~N` per artifact and the
constants are read from `constants.mjs` (changing a constant changes the output). Verified by **EVAL-EFF-001**.

**Priority:** MUST · **Phase:** v0.3 · **Refs:** SPEC-06 §Design, §Data structures; ADR-0004 (envelope)

---

### BR-EFF-002 — Residency classes determine what an artifact costs in model context

**Rule:** Every artifact MUST be assigned a **residency class**, and its model-context cost MUST be
computed per class:
- **ALWAYS-ON** — costed at full: an always-on rule's **full body** (a rule with **no `paths:`** —
  resolved exactly as forge resolves rules, `findRuleFile`); an agent/skill/command **DESCRIPTION only**
  (not its body); a hook's **description + estimated stdout injection tokens**.
- **CONDITIONAL** — costed at full body × an **activation probability**: path-scoped rule bodies (rules
  *with* a `paths:` glob), agent/skill bodies, and bundles.
- **ON-DEMAND** — costed at **0 model-context tokens**: validators and engine scripts (they run in a child
  process; their source never enters the model's context).

A hook's `.mjs` **source MUST NOT** be counted as context. A hook's cost MUST be its `hooks.json`
description plus the estimated injection text it writes to stdout, obtained by **parsing the
`permissionDecisionReason` / `additionalContext` string literals** out of its `.mjs`.

**Rationale:** Context cost is dominated by what is *resident*, not what *exists on disk*. An always-on rule
body is paid every turn; a validator is never in context; a hook injects only its decision string. Costing
all three the same (by file size) would be wrong by orders of magnitude and would mis-rank exactly the
artifacts the optimizer later reasons about.

**Acceptance:** Given a fixture harness, `analyze` classifies each artifact into the correct residency
class; a validator costs `0`; a hook costs `description + parsed-injection`, not its file size; an always-on
rule (no `paths:`) is ALWAYS-ON and a path-scoped rule is CONDITIONAL. Verified by **EVAL-EFF-002**.

**Priority:** MUST · **Phase:** v0.3 · **Refs:** SPEC-06 §Design; hooks.json; ADR-0005 (identity)

---

### BR-EFF-003 — Always-on total, per-artifact, and per-profile budgets are reported

**Rule:** `analyze` MUST report three roll-ups: (a) an **always-on TOTAL** that itemizes every ALWAYS-ON
artifact and reproduces the ROADMAP's always-on class total (the "`~2,550 tok`" figure) by construction,
not by hard-coding it; (b) a **per-artifact** cost line; (c) a **per-profile materialized cost** —
`alwaysOn` and a `conditional-ceiling` (all conditional artifacts assumed active) — computed by resolving
the profile's modules with the **same `resolveModules`** the composer uses (so a profile's budget reflects
its real module set, including `moduleSelectionRules` deltas).

**Rationale:** The whole point of the static half is "what does my always-on context cost, and which
profile is heaviest?". Reusing `resolveModules` guarantees the budget matches what `init` would actually
lay down; deriving (not hard-coding) the always-on total means the figure stays correct as rules change.

**Acceptance:** `analyze` emits an always-on itemization whose sum equals the reported total; per-profile
`alwaysOn` and `conditional-ceiling` are computed via `resolveModules` and match a fixture's expected set.
Verified by **EVAL-EFF-003**.

**Priority:** MUST · **Phase:** v0.3 · **Refs:** SPEC-06 §Design; ROADMAP v0.3; bin/forge.mjs `resolveModules`

---

### BR-EFF-004 — Static dead/unused detection (D1–D5) needs no telemetry

**Rule:** `analyze` MUST detect the following **structural** dead/unused conditions from the manifests and
disk alone (no telemetry), and these are safe to **recommend** even with zero usage data:
- **D1 orphan module** — a module in **zero** profiles and not `always: true`.
- **D2 orphan component** — a component listed in **no** module.
- **D3 orphan file** — a file on disk that no module references.
- **D4 dangling ref** — a module names a component that has **no backing file** (cross-referenced to the
  dependency graph — **see BR-DEP** / SPEC-03; not re-derived here).
- **D5 vacuous path-scoped rule** — a rule whose `paths:` globs match **ZERO** files in a given
  `--project` (e.g. `react-patterns` `**/*.tsx` in a pure-Python project). **D5 requires `--project`** and
  is the **highest-value** static check: it finds rules that are installed but can never activate *here*.

**Rationale:** D1–D5 are facts about composition and disk, not about behavior. They catch the real recurring
bug class (cf. the "13 broken skill links" defect class) and the silent-waste class (a TS rule shipped into a Python
repo) without any of the statistical fragility of usage data.

**Acceptance:** On a fixture with a planted orphan module/component/file and a planted dangling ref,
each of D1–D4 is reported with its `check-id`; on a pure-Python `--project` fixture, `react-patterns`
(`**/*.tsx`) is reported as a **D5 vacuous rule**. Verified by **EVAL-EFF-004** (D1–D4) and **EVAL-EFF-005** (D5).

**Priority:** MUST · **Phase:** v0.3 · **Refs:** SPEC-06 §Design; BR-DEP (D4); modules.json; profiles.json

---

### BR-EFF-005 — Dynamic dead-detection DEGRADES to static-only when telemetry is absent

**Rule:** When telemetry is off or its window is empty (it is **opt-in, default-off** — **see BR-TEL**),
`analyze` MUST **degrade to static-only**: it reports D1–D5 and explicitly states that the dynamic checks
(`U1`–`U4`, `BR-EFF-009`) are **unavailable for lack of telemetry**. It MUST NOT silently emit zero
dynamic findings as if everything were "alive", and it MUST NOT error or block. The dependency on telemetry
is named honestly in the output.

**Rationale:** Default-off telemetry means the common case is "no usage data". The honest behavior is to do
the static work that is always valid and to *say* that the dynamic layer is dark — never to fabricate
liveness from absence of data, and never to fail.

**Acceptance:** With telemetry disabled/empty, `analyze` returns D1–D5 results and a clear "dynamic checks
unavailable (telemetry off)" notice, exits successfully, and emits no `U1`–`U4` verdicts. Verified by
**EVAL-EFF-009**.

**Priority:** MUST · **Phase:** v0.3 · **Refs:** SPEC-06 §Edge cases; BR-TEL; ADR-0011

---

### BR-EFF-006 — Criticality tag + seeded safety allowlist (the safety-lock primitive)

**Rule:** Every artifact MUST carry a criticality tag `safety | compliance | normal`, assigned from a
checked-in seed map `forge/manager/analyze/criticality.json` (NOT inferred from prose). The seed MUST tag
these five controls as `safety`: `secret-scan`, `block-no-verify`, `config-protection`,
`prompt-defense-baseline`, `security-baseline`. An artifact absent from the seed is `normal`. A
`safety`/`compliance` artifact **MUST NEVER** be classified dead, **MUST NEVER** appear in a prune-plan, and
**MUST NEVER** lose keeper status — regardless of fire count, citation count, cost, or value-density.

**Rationale:** A safety control's success is indistinguishable from disuse by every usage signal; only a
hard, seeded discriminator above all those signals can stop the optimizer from recommending the deletion of
a working safety net. Seeding (vs inferring) makes the lock auditable and deterministic.

**Acceptance:** The five named uids resolve to `safety`; an unlisted artifact resolves to `normal`; a
`safety`-tagged artifact is excluded from every "dead"/prune surface regardless of usage. Verified by
**EVAL-EFF-006** (the critical regression) and asserted again wherever a prune-plan is built.

**Priority:** MUST · **Phase:** v0.3 (ships with any dead-detection) · **Refs:** ADR-0013; SPEC-06 §Design

---

### BR-EFF-007 — Zero-fire safety is reported as SUCCESS, not waste

**Rule:** A `safety`/`compliance` artifact with **zero** activity MUST be surfaced under a distinct
**"low-activity safety (expected)"** heading and MUST NOT appear under "waste", "dead", or
"prune-candidate". The report MUST state the inversion (e.g. "`secret-scan` fired 0× → no secrets leaked →
the control is working"), so the human is never nudged toward removing it.

**Rationale:** Reporting zero-fire safety as "unused" is not just useless, it is *harmful* — it points the
user at the exact artifact they must keep. Naming the inversion turns a scary-looking zero into a
reassuring one.

**Acceptance:** With a 0-fire `secret-scan`, the report lists it under "low-activity safety (expected)" with
the success framing, and it is absent from every waste/dead/prune section. Verified by **EVAL-EFF-006**.

**Priority:** MUST · **Phase:** v0.3 · **Refs:** ADR-0013; SPEC-06 §Edge cases

---

### BR-EFF-008 — Window/volume adequacy gates downgrade thin dynamic verdicts to `watch`

**Rule:** For a **`normal`** artifact, a *dynamic*-dead verdict ("never fired") is only meaningful relative
to opportunities. If `sessions < MIN_SESSIONS` (20) OR `windowDays < MIN_DAYS` (14), every dynamic-dead
verdict MUST downgrade from `prune` to **`watch`** (never `prune`). Static orphans (D1–D4) are exempt —
being structural, they are safe to recommend even with zero telemetry. The thresholds MUST be tunable
constants pinned by a meta-test.

**Rationale:** "Never fired" across two sessions is noise; across two hundred it is signal. Gating usage
verdicts on window adequacy keeps the optimizer from recommending deletion on thin evidence, consistent with
advisory-first (`ADR-0007`).

**Acceptance:** With `sessions=3` (< 20), a never-fired `normal` artifact is reported as `watch`, not
`prune`; static orphans on the same fixture are still recommended. Verified by **EVAL-EFF-007**.

**Priority:** MUST · **Phase:** v0.3 (gate logic) / consumed by v0.6 dynamic checks · **Refs:** ADR-0013; BR-TEL

---

## DYNAMIC / value-density half — v0.6 (DEFERRED)

> Deferred per `ideas/01-proportionality.md` Tier 3: each rule below stacks an estimated or LLM-judged
> input on top of opt-in telemetry. At `n=1` they are low-confidence; they ship only when both inputs are
> real and plentiful. They degrade to the static half (`BR-EFF-005`) whenever their upstream signal is dark.

### BR-EFF-009 — Dynamic dead-detection (U1–U4) over a telemetry window

**Rule:** When telemetry is present and the window is adequate (`BR-EFF-008`), `analyze` SHOULD additionally
detect: **U1 never-fired** (0 invoke/fire/cite events in the window), **U2 fires-but-never-acts** (a hook
with `fires > 0` but `0` denies/effects), **U3 never-cited rule**, **U4 bundle never loaded** — all keyed on
telemetry events (**see BR-TEL**). Every U-verdict is subject to the safety-lock (`BR-EFF-006`) and the
adequacy gate (`BR-EFF-008`).

**Rationale:** Usage telemetry is the only way to find artifacts that are *composed-and-reachable* yet
*never actually used*. It is genuinely useful — but only once there is enough data, and only behind the
lock and the gate.

**Acceptance:** On a synthetic telemetry window with an adequate session count, a reachable-but-never-fired
`normal` artifact is reported `U1`; a safety artifact in the same state is NOT. Verified by **EVAL-EFF-010**.

**Priority:** SHOULD · **Phase:** v0.6 (DEFERRED) · **Refs:** SPEC-06 §Design; BR-TEL; ADR-0013

---

### BR-EFF-010 — Redundancy detection via Jaccard k-shingle overlap

**Rule:** `analyze` MAY flag redundant artifacts by Jaccard k-shingle overlap: on **bodies** with `k = 5`
(`J ≥ 0.35` = candidate, `J ≥ 0.6` = strong) and on **descriptions** with `k = 3` (`J ≥ 0.5` — descriptions
are always-on, so overlap there is higher-value). It MUST surface any self-declared **"floor/ceiling"
layering** as a **de-flag hint** (e.g. `security-baseline` *is* the deliberate ceiling over
`common/security`; that pair is intentional layering, not redundancy).

**Rationale:** Near-duplicate prose wastes always-on budget, but deliberate layering looks identical to
accidental duplication; the de-flag hint stops the optimizer from "fixing" an intentional floor/ceiling pair.

**Acceptance:** Two near-duplicate fixture rules are flagged at the right strength tier; the
`security-baseline`/`common/security` pair is reported with the layering de-flag hint, not as prune-worthy.
Verified by **EVAL-EFF-011**.

**Priority:** MAY · **Phase:** v0.6 (DEFERRED) · **Refs:** SPEC-06 §Design

---

### BR-EFF-011 — Value-density (`effScore / costTok`) with hard no-prune floors

**Rule:** Value-density MUST be defined as `effScore / costTok`, where `effScore` comes from harness health
(**see BR-EVAL**) and `costTok` is this dimension's estimate × activation probability (`BR-EFF-002`).
Artifacts MUST sort into quadrants `keeper | justified | harmless | prune-candidate`. Two floors are
absolute: (a) **UNKNOWN effectiveness** (coverage `0` / grade `U`, **see BR-EVAL**) ⇒ value-density is
`null` (**not `0`**) and the artifact routes to **`needs-eval`**, NEVER `prune`; (b) **`safety`/`compliance`
criticality** ⇒ **forced keeper** regardless of the ratio (`BR-EFF-006`). The report MUST declare
value-density **low-confidence** (it stacks an LLM-judged score over an estimated token count).

**Rationale:** A ratio of a fuzzy numerator over an estimated denominator is the corpus's weakest signal; it
is only safe with explicit floors that forbid pruning anything un-eval'd or safety-critical, and with an
honest low-confidence label. This is why it is the last thing built.

**Acceptance:** A grade-`U` artifact gets `value-density = null` and `needs-eval` (never `prune`); a
`safety` artifact is a forced `keeper` regardless of ratio; a low-`effScore`/high-`cost` `normal` artifact
with real eval data is a `prune-candidate`. Verified by **EVAL-EFF-008** (the `U ≠ 0` floor) and **EVAL-EFF-012**.

**Priority:** SHOULD · **Phase:** v0.6 (DEFERRED) · **Refs:** ADR-0012; ADR-0013; BR-EVAL; SPEC-06 §Design

---

### BR-EFF-012 — `forge optimize` is a dry-run prune-plan that never deletes

**Rule:** `forge optimize` MUST be a **dry-run prune-plan only** — it NEVER deletes (additive-never-
destructive, invariant #2). Each recommendation MUST carry `{check-id, confidence: high|med|low,
recoverableTokens, evidence, safetyLocked: false}`. Safety-locked artifacts (`BR-EFF-006`) MUST be rendered
in a **separate, non-actionable "considered & excluded"** section and MUST NOT be emittable as
recommendations; the exclusion is enforced at the **data layer**, not just presentation. `--emit-plan`
writes `optimize.plan.json`. A/B variant comparison runs via `run-eval` (cost axis = this dimension,
effectiveness axis = **see BR-EVAL**).

**Rationale:** The optimizer's only job is to *advise*; deletion is always the human's. Putting a safety
artifact in an actionable plan — at any confidence — is an invitation to remove it, so the only correct
surface is non-actionable exclusion, enforced where the plan is built.

**Acceptance:** `optimize` writes nothing on disk except `optimize.plan.json` under `--emit-plan`; the plan
contains zero `safetyLocked: true` recommendations; safety artifacts appear only in "considered & excluded".
Verified by **EVAL-EFF-013** and (safety exclusion) **EVAL-EFF-006**.

**Priority:** SHOULD · **Phase:** v0.6 (DEFERRED) · **Refs:** ADR-0007; ADR-0013; BR-EVAL; SPEC-06 §CLI

---

## Coverage map (BR → EVAL)

| BR | Phase | Priority | EVAL case(s) |
|---|---|---|---|
| BR-EFF-001 token estimator | v0.3 | MUST | EVAL-EFF-001 |
| BR-EFF-002 residency classes | v0.3 | MUST | EVAL-EFF-002 |
| BR-EFF-003 always-on/per-profile budget | v0.3 | MUST | EVAL-EFF-003 |
| BR-EFF-004 static dead D1–D5 | v0.3 | MUST | EVAL-EFF-004, EVAL-EFF-005 |
| BR-EFF-005 degrade-to-static | v0.3 | MUST | EVAL-EFF-009 |
| BR-EFF-006 criticality + safety-lock | v0.3 | MUST | EVAL-EFF-006 |
| BR-EFF-007 zero-fire safety = success | v0.3 | MUST | EVAL-EFF-006 |
| BR-EFF-008 window/volume adequacy | v0.3 | MUST | EVAL-EFF-007 |
| BR-EFF-009 dynamic dead U1–U4 | v0.6 | SHOULD | EVAL-EFF-010 |
| BR-EFF-010 redundancy / layering de-flag | v0.6 | MAY | EVAL-EFF-011 |
| BR-EFF-011 value-density + `U ≠ 0` floor | v0.6 | SHOULD | EVAL-EFF-008, EVAL-EFF-012 |
| BR-EFF-012 `forge optimize` dry-run plan | v0.6 | SHOULD | EVAL-EFF-013, EVAL-EFF-006 |
