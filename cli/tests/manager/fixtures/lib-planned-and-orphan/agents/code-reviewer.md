---
name: code-reviewer
description: Baseline IN-MODULE artifact for the planned/orphan fixture. Named in modules.json AND present on disk -> status active, no flags.
tools: [Read, Grep, Glob, Bash]
model: sonnet
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# code-reviewer (planned/orphan fixture baseline)

Present on disk and named in the `review` module, so the registry records this
as `status: "active"` with no orphan flag — the control against which the
planned and orphan records are distinguished.
