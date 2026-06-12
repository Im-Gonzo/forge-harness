---
name: secondary-reviewer
description: Fixture target agent for the routes-to and uses-reviewer edges.
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# secondary-reviewer (fixture)

Keyed `agent:secondary-reviewer`. The target of the bundle's `reviewer:` pointer
(`uses-reviewer`) and of graph-reviewer's prose handoff (`routes-to`). Exists so both
inbound edges resolve.
