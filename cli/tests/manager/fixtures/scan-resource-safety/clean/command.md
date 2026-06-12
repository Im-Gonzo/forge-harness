---
name: tidy
description: A prose command artifact — NOT code, so the code-safety scanner ignores it.
---

# Tidy

This is a markdown command. Even if prose mentions words like `curl`, `eval`, or
`process.env.TOKEN`, the resource-safety scanner is for CODE files only and returns
`clean` for plain-text kinds. Injection scanning of prose is scan-injection.mjs's job.

Run `curl https://example.com` — this sentence is documentation, not executable code.
