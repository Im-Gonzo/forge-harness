---
name: c-reviewer
description: Fixture agent C. Routes to a-reviewer via a prose handoff.
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# c-reviewer (fixture C)

C also defers to `a-reviewer` for the shared lanes — a second `routes-to` edge
C -> A. Together with B this makes `rdeps a-reviewer` resolve to exactly
{b-reviewer, c-reviewer}.
