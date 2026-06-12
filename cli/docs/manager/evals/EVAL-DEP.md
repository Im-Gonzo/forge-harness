# EVAL-DEP — Dependency-graph acceptance specs

> Acceptance specs for the typed dependency graph and prose-ref resolution (SPEC-03, BR-DEP).
> All code-graded and deterministic (`pass^k=1.00`). All cases **GREEN** (shipped). Phase v0.3.
>
> Note: the original `react-reviewer` headline regression has been FIXED — that real prose handoff
> was redirected to existing reviewers (`typescript-reviewer` folds the React lanes into its own
> scope; language-agnostic review routes to `code-reviewer`). The detection capability is now held by
> EVAL-DEP-001 against a SYNTHETIC planted dangler in `fixtures/dangling-ref/`, with an added assertion
> that the real repo reports ZERO dangling refs (proving the redirect worked).

### EVAL-DEP-001 — planted dangling reviewer is reported; the real repo is clean

- **Verifies:** BR-DEP-002, BR-DEP-003, BR-DEP-004
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a synthetic fixture — `fixtures/dangling-ref/agents/planted-reviewer.md`
  contains the backticked bare name `` `ghost-reviewer` `` and there is **no** `agents/ghost-reviewer.md`
  — When the dependency check runs over the fixture, Then `registry.json.danglingRefs[]` contains one
  consolidated entry with `rawRef: "ghost-reviewer"`, `from` = the planted-reviewer agent uid, and
  `sites[]` referencing the fixture agent; AND a control confirms `validate-xref` alone does NOT report it
  (proving the prose-ref upgrade is load-bearing); AND building the graph over the **real** repo reports
  ZERO dangling refs (proving the original `react-reviewer` handoff redirect worked).
- **Fixture:** `fixtures/dangling-ref/` (one agent with a prose ref to a non-existent `ghost-reviewer`);
  plus the real repo, read-only, asserted clean.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-DEP-002 — Typed edges with correct type and source

- **Verifies:** BR-DEP-001
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a fixture exercising each edge type (`routes-to`, `uses-skill`,
  `uses-agent`, `uses-reviewer`, `member-of`, `applies-rule`, `selects`, `references`), When the graph is
  built, Then each expected edge exists with the correct `type` and `source` (`frontmatter|prose|manifest`),
  and the source artifact's registry `dependsOn[]` lists the resolved target uids.
- **Fixture:** `fixtures/graph-alltypes/` (a profile, modules, a bundle with frontmatter pointers, an
  agent with a prose handoff, a md-link).
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-DEP-003 — Dangling ref WARN by default, ERROR under --strict

- **Verifies:** BR-DEP-003
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given an artifact with a prose ref to a non-existent `foo-reviewer`, When
  `validate-registry` runs without `--strict`, Then the dangling ref is a **WARN** (exit 0 for that
  finding); When run with `--strict`, Then the same ref is an **ERROR** (exit 1). The `danglingRefs[]` entry
  carries `from`, `rawRef`, `refKind`, and `sites[]{path,line}`.
- **Fixture:** `fixtures/graph-dangling/`.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-DEP-004 — `rdeps` computes the blast radius

- **Verifies:** BR-DEP-005
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a fixture where `B` and `C` each have an edge to `A`, When
  `forge registry rdeps A` runs, Then it returns exactly `{B, C}`; and `forge registry deps B` returns the
  targets `B` points at; and neither command writes to `registry.json`.
- **Fixture:** `fixtures/graph-rdeps/` (A used by B and C).
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-DEP-005 — Orphan = no module AND zero inbound edges

- **Verifies:** BR-DEP-006
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given two artifacts each in no module — one targeted by a `routes-to` edge and
  one with zero inbound edges — When `forge registry orphans` runs, Then it lists ONLY the zero-inbound one
  and does NOT list the routed-to one.
- **Fixture:** `fixtures/graph-orphans/`.
- **Phase:** v0.3
- **Status:** GREEN

### EVAL-DEP-006 — Graph query verbs are read-only

- **Verifies:** BR-DEP-007
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a built registry on a sandbox copy of the real tree with the synthetic
  `planted-reviewer` agent dropped in, When `deps <uid>`, `rdeps <uid>`, `orphans`, and `dangling` run,
  Then `dangling` includes the planted `ghost-reviewer` entry, `orphans` returns the orphan set, each emits
  findings in the `{level,path,line,message,source:"validate-registry"}` shape, and none of the four
  modifies `registry.json` (bytes + mtime unchanged).
- **Fixture:** sandbox copy of the real repo (`agents/`, `rules/`, `manifests/`) + the planted
  `fixtures/dangling-ref/agents/planted-reviewer.md` + a committed registry.
- **Phase:** v0.3
- **Status:** GREEN
