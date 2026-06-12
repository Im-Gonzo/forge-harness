# SPEC-03 — Dependency graph

Status: design-stage · Phase: v0.3 · Implements: BR-DEP-001..007 · Decided-by: ADR-0005, ADR-0008,
ADR-0014

## Summary

The dependency graph turns the registry from a list into a typed directed graph over `uid`s. Its headline
upgrade over `validate-xref` is **prose-ref resolution**: detecting backticked bare names (e.g.
`` `react-reviewer` ``) and resolving them against the known-id set, which catches the real
`react-reviewer` dangling reference that `validate-xref` misses today because it only matches the literal
`agents/<x>.md` path form. Unresolved edges land in `registry.json.danglingRefs[]` (WARN by default, ERROR
under `--strict`). The graph powers `deps` (outbound), `rdeps` (blast radius before a change), `orphans`
(built-but-unreachable), and `dangling`.

## Design

**Edge model (BR-DEP-001).** A directed edge `{from: uid, to: uid|null, type, source, sites[]}`:

| type | meaning | source |
|---|---|---|
| `routes-to` | agent→agent prose handoff (e.g. typescript-reviewer → react-reviewer) | prose |
| `uses-skill` / `uses-agent` / `uses-reviewer` | bundle frontmatter pointers | frontmatter |
| `member-of` | component → module (from `modules.json`) | manifest |
| `applies-rule` | artifact → rule it invokes | frontmatter / prose |
| `selects` | profile → module (from `profiles.json`) | manifest |
| `references` | markdown link / `/command` reference | prose / frontmatter |

`source ∈ {frontmatter, prose, manifest}`. Each artifact's resolved outbound targets populate its registry
`dependsOn[]` (SPEC-01).

**Edge extraction.** Three resolvers run per artifact:
1. **Manifest** — `modules.json` gives `member-of`; `profiles.json` gives `selects`. Deterministic.
2. **Frontmatter** — bundle pointers (`uses-skill`/`uses-agent`/`uses-reviewer`) and `applies-rule`, via
   `manager/lib/frontmatter.mjs`.
3. **Prose (the upgrade, BR-DEP-002)** — strip fenced code blocks (reuse `validate-xref`'s
   `stripFencedCodeBlocks`), then over the remaining inline-code spans:
   - match the **literal path form** `agents/<id>.md`, `skills/<id>/`, `/command` (what `validate-xref`
     already does), AND
   - match **backticked bare names** `` `<name>` `` against the registry's known-id set; additionally
     apply the **`<x>-reviewer` heuristic**: any backticked token matching `/^[a-z][-a-z0-9]*-reviewer$/`
     is treated as an agent reference even if absent from the id set (so a *missing* reviewer still
     produces a candidate edge that fails to resolve).

**Resolution & dangling (BR-DEP-003).** A candidate edge resolves if `to` matches a registry `uid`.
Unresolved → `danglingRefs[]` entry `{from, rawRef, refKind, sites[]{path,line}, reason}`. `refKind` ∈
{`agent`,`skill`,`command`,`rule`,`link`}.

**The `react-reviewer` case (BR-DEP-004, regression lock).** On the real tree:
`agents/typescript-reviewer.md` (lines ~117–118) and `rules/typescript/react-patterns.md` (lines ~3, ~9)
contain `` `react-reviewer` ``; there is no `agents/react-reviewer.md`. The `<x>-reviewer` heuristic
produces a `routes-to`/`references` candidate that fails to resolve → one `danglingRefs[]` entry with both
sites. This is the proof case and a permanent regression lock.

**Queries.**
- `deps <uid>` — outbound edges (this artifact's `dependsOn[]`).
- `rdeps <uid>` (BR-DEP-005) — inbound edges: all artifacts whose `dependsOn[]` contains `<uid>`. The blast
  radius to review before a bump.
- `orphans` (BR-DEP-006) — artifacts in **no module** AND with **zero inbound** routing/usage edges
  (refines the registry's coarse "in no module" flag — a reviewer reached only by prose handoff is NOT an
  orphan).
- `dangling` — prints `danglingRefs[]`.

All read-only; standard findings (C2) with `source:"validate-registry"`.

## Data structures

`registry.json.danglingRefs[]`:

```jsonc
{
  "from": "agent:typescript-reviewer",
  "rawRef": "react-reviewer",
  "refKind": "agent",
  "sites": [
    { "path": "agents/typescript-reviewer.md", "line": 117 },
    { "path": "rules/typescript/react-patterns.md", "line": 9 }
  ],
  "reason": "prose bare-name ref does not resolve to a known uid (<x>-reviewer heuristic)"
}
```

In-memory edge (drives `dependsOn[]` / `deps` / `rdeps`):

```jsonc
{ "from":"bundle:eval-judge", "to":"skill:run-eval", "type":"uses-skill", "source":"frontmatter",
  "sites":[{ "path":"bundles/eval-judge.md", "line":4 }] }
```

## CLI / interface

```
forge registry deps <uid>      # outbound dependencies (read-only)
forge registry rdeps <uid>     # reverse-dependents / blast radius (read-only)
forge registry orphans         # in-no-module AND zero-inbound (read-only)
forge registry dangling        # list danglingRefs[] (read-only)
```

`lint/validate-registry.mjs` reports each dangling ref: WARN by default, ERROR under `--strict`
(BR-DEP-003). Orphans are WARN (advisory; never blocking).

## Edge cases & failure modes

- **Bare name collides with a real id of a different kind** — resolution is kind-aware: `` `security` ``
  is a rule and a profile name; the resolver prefers the edge type's expected kind and, if ambiguous,
  records the edge but notes the ambiguity in `reason` rather than guessing wrong.
- **Self-reference / cycle** — edges may form cycles (two agents that route to each other); `deps`/`rdeps`
  must not infinite-loop (visited-set). Cycles are allowed, not errors.
- **Prose ref inside a fenced example** — stripped before scanning (reuse `stripFencedCodeBlocks`), so
  documentation examples do not produce false danglers — exactly the false-positive guard `validate-xref`
  already relies on.
- **Planned target** — an edge to a `planned` artifact (named in a manifest, no file) resolves to that
  planned `uid` and is NOT dangling; dangling means "resolves to nothing at all".
- **Empty asset dirs (today)** — most files are absent, so most prose refs would dangle; the graph runs
  against the *registry's* id set (which includes `planned`), so only genuinely unknown names (like
  `react-reviewer`) dangle.

## Open questions

- Whether `applies-rule` should be inferred from a rule's `paths:` glob matching an artifact's path
  (implicit application) or only from explicit references. v0.3 does explicit-only; implicit deferred.
- Transitive `rdeps --depth N` (multi-hop blast radius) — v0.3 ships depth-1; deeper traversal is additive
  later.

## Traceability

Implements BR-DEP-001..007. Decided by ADR-0005, ADR-0008, ADR-0013, ADR-0014, ADR-0015. Verified by
EVAL-DEP-001..006. Cross-refs: SPEC-01 (`dependsOn`/`danglingRefs` fields, orphan flag), `validate-xref`
(the form it misses), Bundle D (ADR-0013 criticality for orphan/prune safety), C2/C4.
