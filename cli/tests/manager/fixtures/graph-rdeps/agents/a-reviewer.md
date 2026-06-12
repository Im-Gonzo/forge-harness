---
name: a-reviewer
description: Fixture target agent A. Used by B and C; the rdeps(A) blast radius is {B, C}.
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# a-reviewer (fixture A)

The shared target. Exists only so that `b-reviewer` and `c-reviewer` can each route
to it, exercising `rdeps a-reviewer` -> {b-reviewer, c-reviewer}. A itself points at
nothing, so `deps a-reviewer` is empty.
