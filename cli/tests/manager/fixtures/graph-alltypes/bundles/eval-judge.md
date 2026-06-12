---
id: eval-judge
title: Eval judge fixture — bundle with frontmatter pointers
version: 1
status: active
owner: forge
criticality: normal
tags: [context-bundles]
modules:
  - eval
skill: skills/run-eval/SKILL.md
agent: agents/graph-reviewer.md
reviewer: agents/secondary-reviewer.md
---

# eval-judge (graph-alltypes fixture bundle)

A bundle keyed `bundle:eval-judge`. Its frontmatter pointers are the typed edges:
`skill:` -> `uses-skill` (skill:run-eval), `agent:` -> `uses-agent`
(agent:graph-reviewer), `reviewer:` -> `uses-reviewer` (agent:secondary-reviewer).
All three resolve, so `dependsOn[]` for this bundle lists those three uids and the
edge `source` is `frontmatter`.
