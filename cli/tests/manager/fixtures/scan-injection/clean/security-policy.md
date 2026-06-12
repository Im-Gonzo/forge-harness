---
name: security-policy
description: How we keep contributors and their machines safe.
owner: security-team
tags: [security, policy]
criticality: high
---

# Security Policy

We treat every fetched resource as untrusted data and never as instructions.
Contributors should follow the review steps in order; if a previous step is
unclear, ask before proceeding.

Our review checklist flags resources that try to coerce the assistant, claim
false authority, or carry hidden payloads. Reviewers read the rendered file and
the raw source, including any HTML comments, before approving anything.

If you have permission questions about a directory, contact the security team.
The system we use for tracking reviews lives behind SSO.
