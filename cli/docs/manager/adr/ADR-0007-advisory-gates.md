# ADR-0007: Advisory-first gates — version-bump and eval-regression checks WARN, never block

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.2

## Context

Two of the manager's checks are candidates for *blocking* a commit/push: the **version-bump gate** ("an
artifact's `contentHash` changed but its `revision`/`semver` didn't") and the **eval-regression gate** ("a
reviewer agent's catch-rate dropped below baseline"). Blocking gates are seductive — they make a rule
enforced rather than advisory. But this is a *solo developer's personal harness* (`ideas/01`), and two
hard truths apply:

1. The registry is **scan-on-demand over a live symlink** (ADR-0008): an artifact's content can change
   with **no install event** to hang a bump on, so "hash changed, revision didn't" is routine and
   expected, not a defect.
2. A blocking version gate **×** a blocking eval gate is a *deadlock surface* for a team of one. The
   standard escape hatch — `git commit --no-verify` — is the very thing forge's own `block-no-verify`
   hook exists to fight. A solo dev would be forced to either disable their own safety hook or get stuck.

## Decision

**The version-bump and eval-regression checks ship as advisory `WARN` findings (C5), surfaced in `forge
status`, `forge doctor`, and the `--json` envelope — never as a blocking exit code. They are *promotable*
to blocking later, as an explicit user decision, once eval data justifies the block.**

- **Advisory means:** the check emits a standard `WARN` finding (C2) and the command's exit code is **not**
  affected by it. `validate-registry` may WARN about stale registry / VERSION-triple drift / hash-without-
  revision and still exit 0 (its ERROR-level findings — e.g. a malformed registry — are what fail it).
- **No new commit/push hook.** The manager adds **no** blocking git hook in v0.2. It does not fight, and is
  not fought by, `block-no-verify`. Advisory findings live in the informational surfaces, not the gate.
- **Promotable, not promoted.** The design *reserves* the promotion: when eval data exists to prove a
  given block is correct (a real regression the dev wants stopped), that single gate may be flipped to
  blocking — opt-in, per-gate, explicit, and recorded. The default forever-until-then is advisory. This is
  the v0.4 decision point in `ROADMAP.md`, gated on having `EVAL-EVAL` data.
- **`--strict` is the dial, not a default.** A user who wants warnings to fail *their* CI can run
  `forge validate --strict` (advisory WARNs count toward the exit). The harness itself does not impose it.

## Consequences

**Positive**
- No deadlock surface; no incentive to disable `block-no-verify`. The solo dev is never stuck behind their
  own tooling.
- Findings still *appear* (in status/doctor/json), so the signal isn't lost — it's informational until
  proven worth blocking. Matches the proportionality discipline: grow gates into hardness with data.

**Negative**
- An advisory warning can be ignored indefinitely; a forgotten revision bump persists as a standing WARN.
  Accepted: at `n=1` a nagging-but-visible WARN beats a hard stop on a non-defect, and the registry log
  still records the actual content change regardless of the cosmetic revision.

**Neutral**
- "Advisory now, blockable later" is a one-line config per gate, not an architectural change — the finding
  is already emitted; promotion only changes whether its level participates in the exit code.

## Alternatives considered

- **Block on hash-without-revision-bump.** Rejected: false-positives constantly under the live-symlink
  seam (ADR-0008); turns normal editing into a wall.
- **Block on eval regression immediately.** Rejected: no baseline data yet exists to trust the threshold;
  a flaky judge (`judge_cal`, evals method) would block on noise. Defer to v0.4 with real data.
- **No check at all (don't even warn).** Rejected: the drift is real and worth surfacing; advisory is the
  proportionate middle — see it, don't be stopped by it.

## Related

ADR-0006 (the versioning fold whose bump this gate watches — owned by Bundle A), ADR-0008 (the live-symlink
seam that makes blocking wrong), ADR-0012 (the eval-of-harness whose regression this gate watches — owned
by Bundle E), ADR-0004 (advisory findings ride the `--json` envelope as `WARN`). C5 (advisory gates),
BR-CLI, BR-INT, BR-VER, BR-EVAL, SPEC-08.
