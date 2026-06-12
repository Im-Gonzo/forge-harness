---
name: load-bundle
description: Load exactly ONE WARM context bundle for the slice in flight, then pull COLD corpus (specs/ADRs/BRs/memory) just-in-time by grepping the bundle's pointers — never pre-loading whole files. Confirms HOT (AGENTS.md) is loaded, reads the one bundle whole, follows its retrieval plan in implementation order, treats the invisible_20 list as the working checklist, and honors human_gate by stopping for a human on gated surfaces.
---

# load-bundle — load one WARM bundle per slice, pull COLD just-in-time

The consumer side of Forge's engineered context (`docs/METHOD.md` §1). A slice runs on three tiers: **HOT**
(`AGENTS.md`, always loaded), **WARM** (exactly one bundle, loaded whole), **COLD** (the corpus + memory vault,
pulled just-in-time by grepping a stated need). This skill loads the WARM tier correctly and keeps COLD cold.

> **One bundle per slice — and only what the bundle points you to.** Loading two bundles, or pre-reading the
> specs/ADRs a bundle merely references, defeats the entire tiering: context fills with text the slice does not
> need yet, the model loses the thread, and the invisible-20% checklist drowns. The discipline is *exactly one*
> WARM index, then *grep the need* for COLD — never read whole corpus files on spec.

---

## When to activate

- A slice is in flight and a bundle exists for its work-type — load it before touching code so the invariants and
  invisible-20% are in context from step one.
- You are about to read a spec/ADR/BR and aren't sure you need the whole thing — let the bundle's pointers tell
  you exactly which section to grep.
- You are reviewing a slice: load its bundle and use the `invisible_20` + `br_ids` + `conformance` as the reviewer
  checklist (the same list the author built — `docs/METHOD.md` §2).
- Do **not** activate to *write* or edit a bundle — that is `skills/new-bundle/`. This skill *consumes* one.

---

## How it works

### Phase 1 — Confirm HOT, then select the one bundle

1. Confirm **HOT** is loaded: `AGENTS.md` and its numbered invariants. The bundle references invariants by
   integer; without HOT those integers are meaningless.
2. Select **exactly one** bundle whose `work_type` matches the slice in flight (e.g. `bundles/work-module.md` to
   bring a module online, `bundles/walking-skeleton.md` to stand up the spine). If two seem to apply, the slice is
   too broad — split it; do not load both. If none applies, author one first (`skills/new-bundle/`).

### Phase 2 — Read the one bundle whole

3. Read the selected bundle **in full** — frontmatter and body. It is sized to fit (~one curated index); reading
   it whole is the point. Note its `invariants`, `human_gate`, and the `invisible_20` checklist; these govern the
   whole slice.

### Phase 3 — Follow the retrieval plan; pull COLD just-in-time

4. Work the bundle's **Retrieval plan** in implementation order: at each step, grep the specific pointer the
   bundle names — a `spec_sections[].sections` entry, an `adrs[].path`, a `br_ids` id in the rule corpus — and
   read **only** that. Never pre-load a whole spec/ADR file; pull on a stated need, the moment the step needs it
   (`docs/METHOD.md` §1, COLD).
5. Nothing in the COLD corpus or `memory/` is auto-loaded. Retrieve prior decisions/gotchas from
   `memory/index.md` only when the step calls for prior art — and treat a recalled entry as a **pointer to verify
   against live code**, never authoritative on its own (`docs/METHOD.md` §8).

### Phase 4 — Carry the invisible-20% as the working checklist

6. Keep the bundle's `invisible_20` open for the duration of the slice. Each entry is a `rule` + the `check` that
   proves it; these are the cross-cutting concerns this work-type reliably drops (`docs/METHOD.md` §2). Implement
   each named check; re-read the full list before claiming done.

### Phase 5 — Honor the human gate

7. If `human_gate: true`, the slice touches an irreversible / security / tenancy / migration surface
   (`docs/METHOD.md` §3, T2). Produce the plan and the diff, then **STOP and wait for a human** — never auto-apply
   a change to a gated surface. The split (autonomous draft + human apply) *is* the safety mechanism.

### Phase 6 — Close with fresh evidence

8. Before claiming done, verify the slice against the bundle: every `invisible_20` check satisfied, `br_ids` /
   `conformance` met. Back the "passing" claim with a **fresh** command run + exit code at the moment of the claim
   — never from memory (`docs/METHOD.md` §4). Resolve the project's real test/build/lint commands from
   `.claude/profile-project.json#commands`; never hard-code them.

---

## Anti-patterns

- **PASS** — loaded exactly one bundle for the slice; **FAIL** — loaded two (or more) bundles "to be safe",
  flooding context and burying the checklist (`docs/METHOD.md` §1).
- **PASS** — grepped the one spec section the step needed; **FAIL** — pre-loaded the whole spec/ADR file the
  bundle merely *points at*, turning COLD into WARM.
- **PASS** — confirmed HOT (`AGENTS.md`) before reading the bundle's integer invariants; **FAIL** — acted on
  `invariants: [3, 7]` with no idea what 3 and 7 are.
- **PASS** — implemented every `invisible_20` check and re-read the list before "done"; **FAIL** — skimmed the
  bundle and dropped the exact cross-cutting concern it exists to defend.
- **PASS** — `human_gate: true` slice stopped at propose-the-diff for a human; **FAIL** — auto-applied a change to
  a tenancy / write-path / migration surface (`docs/METHOD.md` §3).
- **PASS** — a recalled memory entry verified against live code before use; **FAIL** — trusted a stale memory note
  as authoritative (`docs/METHOD.md` §8).

## Related

- `skills/new-bundle/` — the producer: author a WARM bundle for a work-type.
- `bundles/work-module.md`, `bundles/walking-skeleton.md`, `bundles/eval-judge.md` — bundles to load.
- `docs/METHOD.md` §1 (HOT/WARM/COLD), §2 (invisible 20%), §3 (T0/T1/T2 — human gate), §4 (evidence before
  claims), §8 (memory is verified, not authoritative).
- `manifests/modules.json` — the `context-bundles` module (`new-bundle`, `load-bundle`, the bundles, the validator).
