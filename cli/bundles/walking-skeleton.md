---
id: walking-skeleton
title: Stand up the spine — the first end-to-end vertical slice (walking skeleton)
version: 1
status: active
work_type: walking-skeleton
invariants: [1, 2, 3, 4]
adrs:
  - id: ADR-0001
    path: docs/adr/ADR-0001-architecture-baseline.md
    why: fixes the architecture baseline the first vertical slice must exercise end to end
  - id: ADR-0003
    path: docs/adr/ADR-0003-single-write-path.md
    why: establishes the single write path the spine must route every state transition through
spec_sections:
  - path: docs/METHOD.md
    sections: ["1 HOT/WARM/COLD", "2 invisible-20% made structural", "3 T0/T1/T2 autonomy ladder"]
  - path: docs/specs/architecture.md
    sections: ["the spine: request -> write path -> persistence -> read", "walking-skeleton definition of done"]
br_ids: [BR-CORE-001, BR-CORE-002, BR-CORE-003]
conformance:
  - docs/METHOD.md#2
  - docs/specs/architecture.md#walking-skeleton-definition-of-done
modules:
  - the-spine-end-to-end
skill: .claude/skills/load-bundle/SKILL.md
secondary_skill: .claude/skills/new-bundle/SKILL.md
agent: .claude/agents/code-reviewer.md
reviewer: .claude/agents/diff-reviewer.md
additional_reviewers:
  - .claude/agents/database-reviewer.md
dod_ref: docs/specs/architecture.md#walking-skeleton-definition-of-done
human_gate: true
invisible_20:
  - id: INV-1
    rule: Every state change goes through the ONE canonical write path; no slice writes around the spine.
    check: A test asserts the only mutation route is the single write path; a direct-store write fails the build.
    refs: ["docs/adr/ADR-0003-single-write-path.md", "AGENTS.md invariant 3"]
  - id: INV-2
    rule: The slice is genuinely end-to-end (request -> write path -> persistence -> read), not a faked stub.
    check: An integration test drives the real path top to bottom and reads back the persisted result.
    refs: ["docs/specs/architecture.md#the-spine-request---write-path---persistence---read"]
  - id: INV-3
    rule: Every write through the spine emits its audit record in the same transaction as the state change.
    check: A test asserts a committed transition has its audit row, and a rolled-back one leaves none (atomic with the write).
    refs: ["docs/specs/architecture.md#the-spine-request---write-path---persistence---read"]
  - id: INV-4
    rule: Every change names the governing spec/ADR/rule it implements; a change behind no rule does not merge.
    check: Reviewer rejects any diff in this slice with no cited rule/BR id.
    refs: ["AGENTS.md invariant 2"]
  - id: INV-5
    rule: The spine ships with a regression eval pinned at pass^k=1.00 — it is the most spec-critical path there is.
    check: skills/run-eval reports the spine's regression cases pass^k=1.00 on a fresh run before release.
    refs: ["docs/METHOD.md#5"]
  - id: INV-6
    rule: This is human-gated work — propose the plan + diff, then STOP for a human before applying to the spine.
    check: The slice halts at the proposed diff; the apply step is performed only after explicit human approval.
    refs: ["docs/METHOD.md#3"]
  - id: INV-7
    rule: No "passing" claim without a FRESH command run + exit code shown at the moment of the claim.
    check: The project's test + typecheck commands run fresh and are pasted with exit codes before 'done'.
    refs: ["docs/METHOD.md#4", "AGENTS.md invariant 1"]
acceptance_gates:
  - An integration test drives the real spine end to end and reads back the persisted result.
  - Every write routes through the single write path and emits its audit record in the same transaction.
  - The plan + diff were proposed and a human approved before the spine was touched.
release_blocking_gates:
  - The single-write-path check is green (no writes bypass the spine).
  - The spine's regression eval set is pass^k=1.00.
---

# walking-skeleton — WARM context for standing up the first end-to-end vertical slice

WARM context bundle (`docs/METHOD.md` §1): the curated index for the highest-stakes work-type — the **walking
skeleton**, the first thin vertical slice that runs the architecture end to end (request -> write path ->
persistence -> read) and establishes the single write path everything later rides on. It cites by reference and
never restates normative text; the architecture baseline, the write-path ADR, and the rules live in the COLD
corpus and HOT `AGENTS.md`, and this bundle points at them. Load it (`skills/load-bundle/`) when the slice is
"stand up the spine".

## Purpose

Serves the **walking-skeleton** slice-class. The riskiest thing it must get right: **the single write path** —
every state change routes through one canonical path, atomically with its audit record. The skeleton sets the
shape every future slice copies; a write that bypasses the spine here becomes the pattern that rots the system.

## Retrieval plan

1. Confirm HOT loaded (`AGENTS.md` + its invariants). 2. Read this bundle whole. 3. JIT, in implementation order:
`docs/specs/architecture.md` (the spine) -> `ADR-0001` (architecture baseline) -> `ADR-0003` (single write path)
-> `docs/specs/architecture.md` (walking-skeleton DoD); grep `BR-CORE-001..003` in the rule corpus per step.
Never read whole files — pull only on a stated need. Nothing in the COLD corpus or `memory/` is auto-loaded.

## Invariants in play

- **1** — evidence before claims (the "done" claim is a fresh run, not a memory).
- **2** — cite the rule (every change names the spec/ADR/BR it implements).
- **3** — the single write path / module boundary (every state change routes through the spine).
- **4** — atomic audit (the audit record commits in the same transaction as the state change).

Reminders only — the normative text lives in HOT and the cited ADR/rules, never restated here.

## The invisible 20% — do not drop these

Re-read before claiming done. Each `invisible_20` entry pairs a cross-cutting **rule** with the **check** to
write: the single write path (INV-1), genuinely end-to-end (INV-2), atomic audit (INV-3), cite-the-rule (INV-4),
the spine's pass^k regression eval (INV-5), the human gate (INV-6), evidence before claims (INV-7). The reviewer
checks the diff against `br_ids` + `conformance` + `invisible_20` before merge; the same list is the reviewer
checklist and (INV-1, INV-5) the release-blocking CI gate.

## Human gate

`human_gate: true`. Standing up the spine touches the core write path — T2 work (`docs/METHOD.md` §3). **Propose
the plan + diff, then STOP and wait for a human** — never auto-apply a change to the write-path surface. The split
(autonomous draft + human apply) *is* the safety mechanism, defended in depth: this gate -> the agent STOP
contract -> the gated workflow branch -> the read-only reviewers.

## Prior art / memory

Retrieve on demand from the COLD vault (`memory/index.md`): prior write-path and audit decisions and gotchas.
Pull only on a stated need; nothing here is auto-loaded, and a recalled entry is a pointer to verify against live
code (`docs/METHOD.md` §8).

> The ADR / spec / BR paths above are realistic placeholders for a target project's corpus. At bootstrap, retarget
> them to the project's actual `docs/adr/`, spec files, and BR ids; the linter checks pointer **shape** here and
> resolves them on-disk against the real corpus in the target repo.
