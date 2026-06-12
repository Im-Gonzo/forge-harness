---
name: code-reviewer
description: Minimal anti-noise reviewer fixture. Reads a change set and reports only defensible findings. READ-ONLY — never edits.
tools: [Read, Grep, Glob, Bash]
model: sonnet
owner: forge
criticality: normal
tags: [review]
version: 0.1.0
---

# code-reviewer (fixture)

A senior code reviewer fixture used to exercise registry build/ls/show and
idempotence. Read-only: diagnoses and reports; never edits or commits.
