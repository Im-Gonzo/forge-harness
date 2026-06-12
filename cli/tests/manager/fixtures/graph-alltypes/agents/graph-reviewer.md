---
name: graph-reviewer
description: Fixture agent. Routes to secondary-reviewer (prose), applies citation-rule, links a rule file.
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# graph-reviewer (fixture)

The bundle's `agent:` target, keyed `agent:graph-reviewer`. It also exercises two more
edge types itself:

- a prose handoff to `secondary-reviewer` -> a `routes-to` edge
  (agent:graph-reviewer -> agent:secondary-reviewer), source `prose`;
- a markdown link to [the citation rule](../rules/citation-rule.md) -> a `references`
  edge (agent:graph-reviewer -> rule:citation-rule), source `prose`.

It applies `citation-rule` on every change.
