---
name: routed-reviewer
description: In NO module but reachable via an inbound routes-to edge -> NOT an orphan.
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# routed-reviewer (fixture)

Belongs to no module, but `router-reviewer` routes to it, so it has one inbound edge.
Per BR-DEP-006 an orphan needs BOTH no module AND zero inbound edges, so this file
must NOT appear in `orphans`.
