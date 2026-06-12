---
name: planted-reviewer
description: Fixture agent whose prose handoff points at a non-existent ghost-reviewer.
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# planted-reviewer (fixture)

On a relevant change, also invoke `ghost-reviewer` for the specialised lanes. There is
no such agent on disk and no `ghost-reviewer` in the registry, so the `<x>-reviewer`
heuristic produces a candidate `routes-to` edge that fails to resolve -> one entry in
`registry.json.danglingRefs[]` (the PLANTED dangling ref under test). A second mention
of `ghost-reviewer` keeps both sites under one consolidated entry.
