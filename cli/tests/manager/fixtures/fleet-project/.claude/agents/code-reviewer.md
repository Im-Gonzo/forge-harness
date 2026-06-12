---
name: code-reviewer
owner: forge
description: A copied reviewer artifact tracked by the project marker (fixture).
tags: [review]
criticality: normal
---

# code-reviewer (fixture copy)

A laid-down, user-editable copy of the reviewer agent. The project marker records
its path + checksum so the manager can classify it as copied/edited/referenced
when assessing fleet drift. This body is deliberately stable so a test can edit it
to simulate user drift.
