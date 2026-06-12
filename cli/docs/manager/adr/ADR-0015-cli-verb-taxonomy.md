# ADR-0015: CLI verb taxonomy — noun-first groups; resolve `status`/`stat`/`monitor`

- **Status:** Accepted (design-stage)
- **Date:** 2026-06-05
- **Phase:** v0.2

## Context

The manager adds many verbs across many dimensions. Forge's existing CLI is flat (`init`, `doctor`,
`sync`, …). Adding ~30 more flat verbs would be unnavigable and would collide (a "status" of *what*?). We
need a taxonomy that (a) groups verbs by the noun they act on, (b) resolves three genuine naming overlaps
— `status` vs `stat` vs `monitor`, and `analyze` vs `optimize` — and (c) keeps `doctor` distinct from
`status` so we don't end up with two health commands.

## Decision

**Noun-first command *groups*; flat verbs stay flat; three overlaps resolved by role, not by renaming
away the useful distinction.**

- **Groups (noun then sub-verb), each a lazy module (ADR-0001):**
  - `forge registry` — `build | ls | show | deps | rdeps | orphans | dangling | changed | bump | log |
    diff | roll-up` (catalog, identity, graph; rules in BR-REG/BR-DEP/BR-VER)
  - `forge fleet` — `enable | status | scan | drift | sync | relink | forget | prune | ignore | pin`
    (where harnesses are installed; BR-FLEET)
  - `forge telemetry` — `on | off | status | prune | wipe` (subsystem control; BR-TEL)
  - `forge analyze` / `forge optimize` (efficiency; BR-EFF)
  - `forge eval-harness` — `[uid] | --changed | --all | --report` (eval-of-harness; BR-EVAL)
- **Top-level composed/flat verbs:**
  - `forge status` — the **composed dashboard** (informational; reads every dimension's `summarize()`).
  - `forge monitor` — a **live tail** of telemetry events (foreground, fail-open).
  - `forge doctor` — **extended** with additive manager lines (health, pass/fail oriented).
- **Overlap resolution (the three collisions):**
  1. **`status` vs `stat` vs `monitor`.** Three different jobs, three names:
     - `forge status` = the *composed dashboard* across all dimensions (snapshot, informational).
     - `forge telemetry status` = *one subsystem's* state (is telemetry on? how many events? retention?).
     - `forge monitor` = *live tail* of events as they happen.
     There is **no top-level `forge stat`** — it would be a fourth synonym for "status". The
     subsystem-status need is met by `forge telemetry status`; the at-a-glance need by `forge status`; the
     live need by `forge monitor`.
  2. **`analyze` vs `optimize`.** Kept distinct by side-effect class: `analyze` is a **read-only report**
     (context-budget, value-density — it never proposes a change); `optimize` is a **dry-run plan** (a
     prune/trim proposal, dry-run by default, `--apply` to act, criticality safety-lock per ADR-0013).
     Read vs propose is a real distinction worth two verbs.
  3. **`doctor` vs `status`.** `doctor` = **pass/fail health** (does this project's harness work? exits
     non-zero on real problems). `status` = **informational dashboard** (what's the state of everything?
     exits 0; advisory). `doctor` is *extended* with manager-scope lines (ADR-0014), **not** duplicated by
     `status`; `status` never decides health, `doctor` never paints panels.
- **Global flags (parsed once, carried in `ctx`):** `--json` (machine envelope, ADR-0004), `--dry-run` /
  `--apply` (mutation gate; dry-run is the default for every writing verb, C4), `--strict` (advisory WARNs
  count toward exit, ADR-0007), `--quiet` (suppress human banners). Flags are uniform across every group.
- **Unknown sub-verb is fail-soft.** `forge registry frobnicate` prints the group's usage and exits 2 —
  consistent with the existing `default:` case in `bin/forge.mjs` for unknown top-level commands.

## Consequences

**Positive**
- Discoverable: `forge <noun> help` lists a noun's verbs; `forge --help` lists the nouns. No 30-verb flat
  wall.
- The three overlaps have one clear home each; a user never wonders whether "status" means the dashboard,
  the subsystem, or the live view.
- `doctor`/`status` separation keeps "is it healthy?" (an exit code) apart from "what's going on?" (a
  panel), so neither command tries to be both.

**Negative**
- Two-word invocations (`forge registry ls`) are longer than flat verbs. Accepted; grouping is worth the
  extra token, and the common dashboard (`forge status`) stays one word.

**Neutral**
- `analyze`/`optimize` are top-level (not `forge efficiency analyze`) because they read as verbs and the
  dimension noun ("efficiency") is never spoken by the user; the dimension lives in the SPEC, not the CLI.

## Alternatives considered

- **All-flat verbs.** Rejected: ~30 colliding verbs, unnavigable.
- **`forge stat` as a short alias for status.** Rejected: a fourth synonym muddies the three-way split;
  the `telemetry status` / `status` / `monitor` trio already covers every real need.
- **Fold `analyze` into `optimize --report`.** Rejected: collapses a real read-vs-propose distinction and
  makes the read-only path carry mutation flags it should never have.
- **`status` absorbs `doctor`.** Rejected: a dashboard that also sets exit codes conflates information
  with health; keep the pass/fail command separate.

## Related

ADR-0001 (groups are lazy modules), ADR-0004 (the `--json` flag), ADR-0007 (`--strict` and advisory
levels), ADR-0013 (the safety-lock `optimize` honors — owned by Bundle D). BR-CLI, BR-INT, SPEC-08,
SPEC-00, EVAL-CLI.
