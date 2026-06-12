---
name: source-reviewer
description: Fixture agent whose prose handoff points at a non-existent foo-reviewer.
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# source-reviewer (fixture)

On a relevant change, also invoke `foo-reviewer` for the specialised lanes. There is
no `agents/foo-reviewer.md` on disk and no `foo-reviewer` in the registry, so the
`<x>-reviewer` heuristic produces a candidate `routes-to` edge that fails to resolve
-> one entry in `registry.json.danglingRefs[]` (WARN by default, ERROR under --strict).
