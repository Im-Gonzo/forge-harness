---
name: new-bundle
description: Author a WARM context bundle for a recurring work-type — pick the spec/ADR/BR references it indexes, select the governing invariants, build the invisible-20% checklist (each cross-cutting rule paired with a concrete check), wire the matching skill/agent/reviewer, and set human_gate. Produces a bundles/<work-type>.md that satisfies all 16 required keys and passes validate-bundles; pointers only, never restate normative text.
---

# new-bundle — author a WARM context bundle for a work-type

A context bundle is the **WARM** tier of Forge's engineered context (`docs/METHOD.md` §1): exactly one curated
index per *work-type* — the spec sections, ADRs, business rules, prior art, and the **invisible-20% checklist**
an agent needs to do one recurring class of slice correctly. The bundle **cites by reference and never restates
normative text** (single source of truth: the rules live in HOT `AGENTS.md` and the COLD corpus; the bundle
points at them).

> **A bundle indexes; it does not narrate.** If you find yourself copying a rule's text into the bundle, stop —
> reference its id/path instead. The moment normative text is duplicated, the two copies drift and the bundle
> starts lying. The bundle's job is to make the right COLD context *findable just-in-time*, not to be the COLD
> context.

The deliverable is a single file `bundles/<work-type>.md` whose YAML frontmatter satisfies
`schemas/bundle.schema.json` (all 16 required keys) and passes `lint/validate-bundles.mjs`. Use
`bundles/eval-judge.md` as a conformant worked example and
`bootstrap/templates/bundles/example-bundle.md.tmpl` as the annotated skeleton.

---

## When to activate

- A recurring class of slice keeps recurring (core write-path, a new module, tenancy/RLS, a migration) and has no
  bundle — author one so the next slice of that class starts with the right WARM context.
- An agent keeps **dropping the same cross-cutting concern** on a work-type (audit, tenancy, the single write
  path) — encode it as a paired `invisible_20` rule+check so it is in context from step one (`docs/METHOD.md` §2).
- A spec/ADR/BR set governs a work-type but is scattered across the corpus — index it once in a bundle.
- Do **not** activate to *consume* a bundle on a live slice — that is `skills/load-bundle/`. This skill *writes*
  bundles.

---

## How it works

### Phase 1 — Name the work-type and its riskiest concern

1. State the **work_type** as a recurring slice-class, not a one-off ticket (e.g. `core-write-path`,
   `bring-a-module-online`, `tenancy-rls`). The bundle is reused across every slice of that class.
2. Name the single thing this class **cannot get wrong** — the cross-cutting concern an agent most reliably
   drops. That concern is the spine of the `invisible_20` list and usually decides `human_gate`.

### Phase 2 — Index the COLD corpus by reference (pointers only)

3. Fill the pointer keys with **references, never content**:
   - `spec_sections[]` — the spec files + the relevant `sections` for this class.
   - `adrs[]` — each `{ id (^ADR-\d+$), path, why }`; `why` states what the ADR governs here. `[]` if none.
   - `br_ids[]` — business-rule ids this class implements; pattern `^BR-[A-Z]+-\d+$`. `[]` if none.
   - `conformance[]` — conformance assertions, typically spec-section refs.
   - `modules[]` — the code modules the slice touches.
   - `dod_ref` — the Definition-of-Done reference (file path, optional `#anchor`).

   These pointers are **bootstrap-retargetable placeholders**: write realistic paths against a target corpus;
   `bootstrap-harness` rewrites them to the project's real `docs/adr/`, spec files, and BR ids at install time.
   `validate-bundles` checks pointer **shape** here; on-disk resolution happens in the target repo.

### Phase 3 — Select the governing invariants

4. Set `invariants` to a **non-empty subset of 1..10** — the HOT `AGENTS.md` invariants this work-type must
   uphold. Reference them by integer only; never restate the invariant text (it lives in HOT). Pick the ones the
   slice actually exercises, not all ten — a bundle that claims every invariant tells the reader nothing.

### Phase 4 — Build the invisible-20% checklist (rule paired with check)

5. For each cross-cutting concern this class drops, add an `invisible_20` entry: a unique `id`, the `rule` (what
   must hold), and a `check` (the concrete test/gate that proves it). This is the §2 mechanism — every invisible
   concern is paired with a check so it is reinforced across four layers: **authoring** (this bundle) →
   **implementing** (the named check) → **review** (the reviewer checklist *is* this list) → **CI**
   (release-blocking gate). A rule with no `check` is a wish, not a defense.
6. Add `refs[]` on each entry pointing at the spec/ADR/BR/invariant that backs the rule, so a reviewer can trace
   it. Carry the universal pair every bundle needs: *cite-the-rule* and *evidence-before-claims*.

### Phase 5 — Wire the matching harness pieces and the gate

7. Point `skill` (and optional `secondary_skill`) at the harness skill that drives this work, `agent` at the
   implementer, and optional `reviewer` / `additional_reviewers` at read-only reviewers for T1+ work. **These
   must resolve to assets that exist** — use real Forge agents (e.g. `.claude/agents/code-reviewer.md`,
   `.claude/agents/diff-reviewer.md`) and real skills so `validate-xref` resolves the textual references.
8. Set `human_gate` (boolean). It **MUST be `true`** for tenancy/RLS, core write-path, and v1->v2 migration
   work-types — `validate-bundles` infers the class from `work_type`/`title`/`id` and fails a gated class that
   sets it false. When true, the bundle body's *Human gate* section states the propose-then-STOP contract
   (`docs/METHOD.md` §3, T2).

### Phase 6 — Verify against the schema

9. Fill identity (`id`, `title`, `version` >= 1 integer, `status`) and write the body sections (Purpose,
   Retrieval plan, Invariants in play, The invisible 20%, Human gate, Prior art / memory). Then **prove it
   conforms** before claiming done (`docs/METHOD.md` §4):

   ```bash
   node lint/validate-bundles.mjs        # all 16 keys, invariants 1..10, human_gate correctness
   node lint/validate-xref.mjs           # the skill/agent/reviewer pointers resolve
   ```

---

## Anti-patterns

- **PASS** — the bundle cites a rule by id/path; **FAIL** — the bundle pastes the rule's normative text, creating
  a second source of truth that drifts (`docs/METHOD.md` §1).
- **PASS** — every `invisible_20` rule is paired with a concrete `check`; **FAIL** — a rule with no check, a wish
  no reviewer or CI gate can enforce (`docs/METHOD.md` §2).
- **PASS** — `invariants` is the subset this slice-class actually exercises; **FAIL** — listing all ten (or one
  irrelevant one) so the field carries no signal.
- **PASS** — `human_gate: true` on a tenancy/RLS, write-path, or migration work-type; **FAIL** — a gated class
  shipped with `human_gate: false`, defeating the §3 T2 split.
- **PASS** — `skill`/`agent`/`reviewer` point at assets that exist on disk; **FAIL** — pointers to invented
  agents/skills that `validate-xref` cannot resolve.
- **PASS** — pointers written as bootstrap-retargetable placeholders against a realistic corpus; **FAIL** —
  hard-coding one project's absolute paths so the bundle cannot be reused at bootstrap.

## Related

- `skills/load-bundle/` — the consumer: load exactly one bundle per slice and pull COLD context just-in-time.
- `bundles/eval-judge.md`, `bundles/work-module.md`, `bundles/walking-skeleton.md` — conformant worked examples.
- `bootstrap/templates/bundles/example-bundle.md.tmpl` — the annotated 16-key skeleton.
- `schemas/bundle.schema.json` — the frontmatter schema; `lint/validate-bundles.mjs` — the validator.
- `docs/METHOD.md` §1 (HOT/WARM/COLD), §2 (the invisible 20% made structural), §3 (T0/T1/T2 — human gate).
- `manifests/modules.json` — the `context-bundles` module (`new-bundle`, `load-bundle`, the bundles, the validator).
