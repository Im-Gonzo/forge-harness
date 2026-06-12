---
name: router-reviewer
description: In-module agent that routes to routed-reviewer (giving it an inbound edge).
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# router-reviewer (fixture)

This agent is named by the "review" module. On a relevant change it hands off to
`routed-reviewer`, a `routes-to` edge router -> routed. That inbound edge is what
keeps `routed-reviewer` OFF the orphan list even though `routed-reviewer` is in no
module.
