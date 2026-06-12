---
name: diff-reviewer
description: Minimal second-opinion diff reviewer fixture. Independent pass over a diff to surface what a single reviewer might miss. READ-ONLY.
tools: [Read, Grep, Glob]
model: sonnet
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# diff-reviewer (fixture)

An independent reviewer fixture. Used to give the registry more than one agent
record so `ls --kind agents` and sort-by-uid have something to order.
