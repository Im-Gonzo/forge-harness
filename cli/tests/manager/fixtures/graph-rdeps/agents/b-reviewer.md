---
name: b-reviewer
description: Fixture agent B. Routes to a-reviewer via a prose handoff.
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# b-reviewer (fixture B)

On a shared change, hand off to `a-reviewer`: B takes the structural lanes and
`a-reviewer` takes the rest. This prose handoff is a `routes-to` edge B -> A, so
`deps b-reviewer` resolves to `agent:a-reviewer`.
