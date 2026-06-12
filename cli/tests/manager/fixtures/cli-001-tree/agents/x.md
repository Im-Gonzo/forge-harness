---
name: x
description: The artifact the EVAL-CLI-001 canonical finding points at. validate-fixture.mjs emits "WARN agents/x.md:12 dangling ref \"y\"" — line 12 below is the referenced location. This file's content is incidental; only its path (agents/x.md) and a line 12 matter.
tools: [Read]
model: sonnet
owner: forge
tags: [fixture]
version: 0.1.0
---

# x (EVAL-CLI-001 target)
This line (12) is the location named by the fixture validator's finding: a
dangling ref "y" that resolves to no artifact in this tree. Only this file's
path (agents/x.md) and the existence of line 12 are load-bearing; the prose is
incidental — a parseable, byte-stable WARN the parent runner envelopes.
