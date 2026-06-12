---
name: code-reviewer
description: VALID artifact #1 in the one-bad fixture. The registry must record this normally despite a sibling malformed file.
tools: [Read, Grep, Glob, Bash]
model: sonnet
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# code-reviewer (one-bad fixture, valid)

A well-formed agent the registry must catalog even though `broken-frontmatter.md`
in the same directory is unparseable.
