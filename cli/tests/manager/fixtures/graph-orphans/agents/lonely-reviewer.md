---
name: lonely-reviewer
description: In NO module AND with zero inbound edges -> the only true orphan.
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# lonely-reviewer (fixture)

Belongs to no module and is referenced by nothing — zero inbound edges. This is the
only artifact that satisfies BR-DEP-006 (no module AND no inbound edge), so `orphans`
must list exactly this one and not `routed-reviewer`.
