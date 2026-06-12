---
name: diff-reviewer
description: VALID artifact #2 in the one-bad fixture. Present so "records all valid artifacts" has more than one record to confirm.
tools: [Read, Grep, Glob]
model: sonnet
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# diff-reviewer (one-bad fixture, valid)

A second well-formed agent. The build must include both valid agents and emit
exactly ONE finding for the malformed file.
