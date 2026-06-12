# ADR-0013: Criticality safety-lock — `safety`/`compliance` artifacts are never pruned

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.3 (the lock and its seed allowlist ship the moment any dead-detection ships) — the
  dynamic dead/value-density logic the lock guards is v0.6, but the **guard itself is not deferrable**:
  it must exist before the first artifact can be called "dead".

## Context

The efficiency dimension (`SPEC-06`, `BR-EFF`) eventually answers "is each artifact earning its keep?"
by combining usage telemetry (`BR-TEL`), context cost (`BR-EFF`), and effectiveness (`BR-EVAL`) into
dead-artifact detection, redundancy clustering, and a value-density ratio. Every one of those signals
shares a fatal blind spot for one class of artifact: **a safety control's success looks exactly like
disuse.** A `secret-scan` hook that fires zero times has not "failed to earn its keep" — it means no
secret was ever written, which is the *outcome the control exists to produce*. A `block-no-verify` hook
that never denies means nobody tried to bypass git hooks. Counting fires, denies, or citations against
these artifacts inverts their meaning: the safer the project, the more "prunable" the safety net looks.

This is not hypothetical. The seed harness ships exactly these controls as **global, always-on** safety:

- `secret-scan` (hook, `security` module) — blocks hard-coded credentials.
- `block-no-verify` (hook, `hooks-quality` module) — blocks `--no-verify` / `core.hooksPath=` bypasses.
- `config-protection` (hook, `hooks-quality` module) — blocks edits that weaken a linter/tsconfig.
- `prompt-defense-baseline` (rule, `core` module) — always-on prompt-injection defense.
- `security-baseline` (rule, `security` module) — always-on threat-modeled security checklist.

In a healthy, low-activity solo repo these are precisely the artifacts most likely to read as "never
fired / never cited" — and they are precisely the artifacts that must never be removed. Any optimizer that
can recommend deleting `secret-scan` because the developer never leaked a secret is **actively dangerous**
and violates the corpus's first discipline (additive-never-destructive, invariant #2; advisory-first,
`ADR-0007`). The optimizer therefore needs a *hard discriminator* that sits above every usage signal.

Two secondary blind spots compound the first, for **non-safety** artifacts:

1. **"Never fired" is meaningless without opportunities.** Zero fires across two sessions says nothing;
   zero fires across two hundred sessions is signal. Statistical-significance gating (window adequacy,
   expected base rate) is part of the same problem family and is decided here alongside the lock.
2. **"Unknown effectiveness" is not "zero effectiveness."** An artifact with no golden set has grade `U`
   (`BR-EVAL`, `ADR-0012`), not grade `F`. Treating `U` as `0` would prune everything un-eval'd — most of
   the harness at `n=1`. `U` must force *needs-eval*, never *prune*.

## Decision

**Criticality is a first-class artifact tag (`safety | compliance | normal`), and a `safety` or
`compliance` artifact can NEVER be classified dead, can NEVER appear in a prune-plan, and can NEVER lower
its own keeper status — regardless of fire count, citation count, cost, or value-density.** The lock is
unconditional and sits above all telemetry, cost, and effectiveness inputs.

1. **Seeded allowlist, not inferred.** Criticality is assigned from a checked-in
   `forge/manager/analyze/criticality.json` seed map, NOT guessed from prose. The seed tags the five
   controls above as `safety`. Tagging is deliberately conservative: the cost of a false `safety` tag is a
   kept artifact (harmless); the cost of a false `normal` tag is a deletable safety net (catastrophic), so
   the default for *uncertain* security-adjacent artifacts is to err toward `safety`. The seed is
   extensible by the user; an artifact absent from the map is `normal`.

2. **Zero-fire safety is a SUCCESS indicator, reported as such.** A `safety`/`compliance` artifact with
   zero activity is surfaced under a distinct **"low-activity safety (expected)"** heading — explicitly
   *not* under "waste" / "dead" / "prune-candidate". The report states the inversion in plain language
   ("0 fires = no secrets leaked = the control is working"), so the human is never nudged toward removal.

3. **Hard exclusion from the prune-plan surface.** `forge optimize` (the dry-run prune-planner, `BR-EFF`,
   v0.6) renders safety-locked artifacts in a separate, **non-actionable "considered & excluded"** section
   carrying `safetyLocked: true`. They cannot be emitted into `optimize.plan.json` as recommendations. The
   lock is enforced at the data layer (a locked artifact is filtered before the plan is built), not merely
   in presentation, so no `--json` consumer can route around it.

4. **Statistical-adequacy gates for `normal` artifacts** (the secondary blind spots, decided here):
   - **Window/volume gate:** a *dynamic*-dead verdict ("never fired") requires `sessions ≥ MIN_SESSIONS`
     (20) AND `windowDays ≥ MIN_DAYS` (14). Below either threshold, every dynamic-dead verdict downgrades
     to **`watch`**, never **`prune`**. Static orphans (`D1`–`D4`, see `BR-EFF`) are structural and need no
     telemetry, so they are safe to recommend even with zero sessions; only *usage-derived* deadness is
     gated. (Thresholds live beside the estimator constants; a meta-test pins them.)
   - **Unknown-effectiveness gate:** an artifact whose effectiveness is grade `U` / coverage `0`
     (`BR-EVAL`) can NEVER be pruned on value-density grounds; its value-density is `null`, not `0`, and it
     routes to **`needs-eval`**. (Independent of, and additional to, the safety lock.)

The lock and its seed allowlist are **not deferrable to v0.6** with the rest of the dynamic optimizer:
they ship in v0.3 the first time *anything* — even a static orphan report — can attach the word "dead" to
an artifact, so the discriminator is always present before the verdict it guards.

## Consequences

**Positive**
- A safety control's success (zero activity) can never be misread by the optimizer as waste; the single
  most dangerous failure mode of usage-based pruning is structurally impossible, not merely discouraged.
- Enforcement at the data layer means the guarantee holds for every surface (`status`, `optimize`,
  `--json`), not just the human-readable report.
- The `U ≠ 0` and window-adequacy gates stop the optimizer from recommending deletion on thin evidence —
  consistent with advisory-first (`ADR-0007`) and proportionality (`ideas/01-proportionality.md`).
- The seed is a small, auditable, version-controlled file; tightening it is a one-line edit, and a
  meta-test can assert "these five uids are `safety`" so a refactor can't silently un-lock them.

**Negative**
- A genuinely dead `normal` artifact mis-tagged `safety` is kept forever (a false negative for pruning).
  Accepted deliberately: a kept artifact wastes a few tokens; a pruned safety net loses a security
  guarantee. The asymmetry is the whole point.
- The seed allowlist needs maintenance as new safety controls are added; a forgotten tag means a real
  safety artifact is treated as `normal`. Mitigated by erring toward `safety` for security-adjacent kinds
  and by a meta-test over the known controls.

**Neutral**
- `compliance` is reserved alongside `safety` though the seed harness ships no compliance artifacts yet;
  the tag exists so a future regulated-context artifact (audit log, retention rule) inherits the same lock
  without a schema change.
- The window/volume thresholds (`MIN_SESSIONS=20`, `MIN_DAYS=14`) are tunable constants, not law; they are
  pinned by a meta-test so a change is a deliberate, reviewed edit rather than drift.

## Alternatives considered

- **Infer criticality from rule/agent prose ("does it mention secrets/security?").** Rejected: a heuristic
  over prose is exactly the kind of fuzzy signal that fails silently; a security artifact phrased without
  the trigger words would be left unlocked. A seeded, checked-in allowlist is auditable and deterministic.
- **Let safety artifacts into the prune-plan but mark them `confidence: low`.** Rejected: any presence in
  an actionable plan is an invitation to act. The plan must not contain a recommendation to delete
  `secret-scan` at *any* confidence; the only correct surface is non-actionable "excluded".
- **Treat unknown effectiveness (`U`) as `0` and let the safety lock alone protect controls.** Rejected:
  that would prune every un-eval'd `normal` artifact (most of the harness at `n=1`). The `U ≠ 0` rule is a
  separate, necessary guard; the safety lock is not a substitute for it.
- **Defer the lock to v0.6 with the dynamic optimizer.** Rejected: static dead-detection (`D1`–`D5`) ships
  in v0.3 and can already label an artifact "orphan/dead". The guard must precede the first verdict, so the
  lock ships whenever dead-detection ships.

## Related

- ADR-0011 (telemetry: opt-in, default-off — the upstream signal the window gate measures)
- ADR-0012 (eval grade `U` is an honest non-score, never coerced to 0/1 — basis of the `U ≠ 0` gate)
- ADR-0007 (advisory-first: the optimizer recommends, never deletes; the lock is the hardest line)
- BR-EFF-006 (criticality tag + seed allowlist), BR-EFF-007 (zero-fire safety = success, not waste),
  BR-EFF-008 (window/volume adequacy gate), BR-EFF-012 (`forge optimize` dry-run + excluded section)
- BR-TEL (telemetry events the dynamic-dead checks consume), BR-EVAL (`effScore`, grade `U`, coverage)
- SPEC-06 §Design (criticality + safety-lock), §Edge cases (the inversion)
- EVAL-EFF-006 (the critical regression: a 0-fire `secret-scan` never reaches the prune-plan),
  EVAL-EFF-007 (window-adequacy downgrade to `watch`), EVAL-EFF-008 (grade-`U` → needs-eval, never prune)
