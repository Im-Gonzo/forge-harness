---
name: orphan-reviewer
description: ORPHAN artifact. Present on disk under agents/ but named in NO module in modules.json -> the registry flags it as an orphan (NOT status planned).
tools: [Read, Grep, Glob]
model: sonnet
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# orphan-reviewer (orphan fixture)

This agent file exists on disk but is absent from every module's `components`
in `manifests/modules.json`. The registry must record it (it is a real
artifact, `status: "active"`) and FLAG it as an orphan — an orphan is a flag,
not a status (BR-REG-005).
