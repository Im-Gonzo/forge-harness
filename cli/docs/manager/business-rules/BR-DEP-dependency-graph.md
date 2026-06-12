# Business Rules — Dependency graph (BR-DEP)

> The normative rules for typed edges between artifacts, the **prose-ref** upgrade over `validate-xref`
> (the one that catches the real `react-reviewer` dangling reference), dangling-ref recording, orphan
> detection, and the graph query verbs. Decided by ADR-0005, ADR-0008, ADR-0014; detailed by SPEC-03;
> built on the registry (BR-REG). **Phase: v0.3** for all rules in this file.

### BR-DEP-001 — Typed directed edges between uids

**Rule:** The graph MUST represent dependencies as typed directed edges between registry `uid`s, with edge
type ∈ { `routes-to` (agent→agent prose handoff), `uses-skill`, `uses-agent`, `uses-reviewer` (bundle
frontmatter pointers), `member-of` (component→module), `applies-rule`, `selects` (profile→module),
`references` (md-link / command ref) } and a `source` ∈ { `frontmatter`, `prose`, `manifest` }. Each
artifact's resolved outbound edges MUST populate its registry `dependsOn[]` (BR-REG-004).
**Rationale:** Typed edges with provenance let `deps`/`rdeps` answer "what breaks if I change this" with
the *kind* of coupling, and let dangling reports name *how* the ref was made.
**Acceptance:** A fixture with one of each edge type yields edges with the correct `type` and `source`, and
the source artifact's `dependsOn[]` lists the resolved targets — `EVAL-DEP-002`.
**Priority:** MUST
**Refs:** ADR-0005, SPEC-03, BR-REG

### BR-DEP-002 — Prose-ref resolution (the validate-xref upgrade)

**Rule:** The graph MUST detect **prose references** — backticked bare names (e.g. `` `react-reviewer` ``)
matched against the known-id set and the `<x>-reviewer` heuristic — as candidate edges, in addition to the
literal `agents/<x>.md` path form that `validate-xref` already matches. `validate-xref` today matches
**only** the path form and therefore MISSES bare-name prose references; the graph MUST close that gap.
**Rationale:** This is the corpus's headline defect class ("13 broken skill links"; ideas/01): real
dangling refs that pass every existing linter because they are written as prose, not as a path.
**Acceptance:** Given prose containing `` `react-reviewer` `` with no `agents/react-reviewer.md` on disk,
the graph produces a candidate edge whose target fails to resolve (feeding BR-DEP-003) — `EVAL-DEP-001`.
**Priority:** MUST
**Refs:** ADR-0008, SPEC-03

### BR-DEP-003 — Unresolved edges become `danglingRefs[]`

**Rule:** Any edge whose target does not resolve to a registry `uid` MUST be recorded in
`registry.json.danglingRefs[]` as `{from, rawRef, refKind, sites[]{path,line}, reason}`. `validate-registry`
MUST report each dangling ref as a **WARN by default** and an **ERROR under `--strict`**.
**Rationale:** Advisory-first (ADR-0007) for a solo dev, but `--strict`/CI can enforce; recording `sites[]`
makes the warning actionable (file:line).
**Acceptance:** The unresolved `react-reviewer` edge appears in `danglingRefs[]` with `from`, `rawRef:
"react-reviewer"`, a `refKind`, and `sites[]` pointing at `agents/typescript-reviewer.md` and
`rules/typescript/react-patterns.md`; it WARNs by default and ERRORs under `--strict` — `EVAL-DEP-003`.
**Priority:** MUST
**Refs:** ADR-0007, ADR-0014, SPEC-03, BR-REG

### BR-DEP-004 — `react-reviewer` is reported as dangling (regression lock)

**Rule:** The graph MUST report `react-reviewer` as a dangling reference on the **current real tree**: it
is referenced as a bare backticked name in `agents/typescript-reviewer.md` and
`rules/typescript/react-patterns.md`, but no `agents/react-reviewer.md` exists. This MUST remain detected
(a regression lock); `validate-xref` alone does not catch it.
**Rationale:** This exact ref is the proof-of-value case the whole prose-ref upgrade exists for; locking it
prevents a future refactor from silently reintroducing the blind spot.
**Acceptance:** Running the dependency check against the real library reports `react-reviewer` as dangling
with both reference sites — `EVAL-DEP-001` (regression).
**Priority:** MUST
**Refs:** ADR-0008, SPEC-03

### BR-DEP-005 — `rdeps` computes blast radius

**Rule:** `forge registry rdeps <uid>` MUST return the set of artifacts with an inbound edge to `<uid>`
(direct reverse-dependents), so a change's blast radius is knowable before editing. `forge registry deps
<uid>` MUST return the outbound dependencies. Both MUST be read-only.
**Rationale:** "What uses this?" before a bump is the single most useful graph query for a solo dev about
to change a shared artifact (e.g. `typescript-style`).
**Acceptance:** For a fixture where `B` and `C` route-to/use `A`, `rdeps A` returns `{B, C}` and `deps B`
returns the targets `B` points at; neither writes — `EVAL-DEP-004`.
**Priority:** MUST
**Refs:** SPEC-03, BR-REG

### BR-DEP-006 — Orphan = no module AND no inbound edge

**Rule:** `forge registry orphans` MUST list artifacts that are in **no module** AND have **no inbound
routing/usage edge** (built-but-unreachable). An artifact in no module but reachable via an inbound edge is
NOT an orphan; this refines the registry's coarse orphan flag (BR-REG-005).
**Rationale:** "On disk but in no module" over-reports (a reviewer reached only by prose handoff is
reachable); requiring zero inbound edges finds the truly dead artifacts.
**Acceptance:** A file in no module but targeted by a `routes-to` edge is NOT listed by `orphans`; a file
in no module with zero inbound edges IS listed — `EVAL-DEP-005`.
**Priority:** SHOULD
**Refs:** ADR-0013, SPEC-03, BR-REG

### BR-DEP-007 — Graph query verbs

**Rule:** The graph MUST expose `forge registry deps <uid> | rdeps <uid> | orphans | dangling`. `dangling`
MUST list `registry.json.danglingRefs[]`. All four MUST be read-only and emit standard findings (C2) with
`source: "validate-registry"`.
**Rationale:** These compose into `forge status` (the dangling/orphan panels) and share the registry's
finding shape so the `--json` envelope stays uniform (ADR-0004).
**Acceptance:** `dangling` prints the recorded dangling refs (incl. `react-reviewer`); `orphans` prints the
orphan set; none of the four verbs write — `EVAL-DEP-006`.
**Priority:** SHOULD
**Refs:** ADR-0004, ADR-0015, SPEC-03
