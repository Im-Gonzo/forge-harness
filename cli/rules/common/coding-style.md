---
name: coding-style
description: Always-on language-agnostic coding style. Keep it simple, don't repeat yourself, don't build what isn't needed; small focused files, explicit error handling, validation at boundaries, immutable-by-default.
---
# Coding Style

> Always-on, global. Language-agnostic craft standards; the per-language packs
> (`python-style`, `typescript-style`, …) layer concrete syntax on top of this.

## KISS / DRY / YAGNI

- [ ] Prefer the simplest solution that actually works; optimize for clarity, not
      cleverness. No premature optimization.
- [ ] Extract repeated logic only once the repetition is REAL — three strikes, not
      speculative. Avoid copy-paste drift.
- [ ] Do not build features or abstractions before they are needed. No speculative
      generality "for the future".

## Shape of the code

- [ ] Many small, focused files over few large ones: high cohesion, low coupling.
      Organize by feature/domain, not by file type.
- [ ] Keep functions small and single-purpose (a few dozen lines). Split a function
      the moment it grows a second responsibility.
- [ ] Avoid deep nesting (~3–4 levels max). Use early returns / guard clauses instead
      of stacking conditionals.
- [ ] Name for the reader: descriptive variable/function names, booleans as
      `is`/`has`/`should`/`can`, constants spelled out. No abbreviations only you know.

## Immutability by default

- [ ] Return new values instead of mutating inputs in place. Immutable data prevents
      hidden side effects, eases debugging, and makes concurrency safe.
- [ ] Reach for in-place mutation only with a stated reason (a measured hot path), and
      keep it local — never mutate a caller's object.

## Errors and boundaries

- [ ] Handle errors explicitly at every level. Never silently swallow an error or an
      empty `catch`. Log detailed context server-side; show a safe message at the UI.
- [ ] Validate ALL external data at the system boundary (user input, API responses,
      file/queue content) before use. Fail fast with a clear message. Trust nothing
      that crossed a boundary.

## No magic, no debris

- [ ] No magic numbers/strings — name meaningful thresholds, limits, and delays.
- [ ] No hardcoded config — read from env/config, not literals in the logic.
- [ ] Leave no debug debris: no stray prints, commented-out blocks, or TODO-as-shipped.

## Before marking complete

- [ ] Readable and well-named; functions small; files focused.
- [ ] No deep nesting; errors handled; inputs validated.
- [ ] No hardcoded values or secrets; immutable patterns used.
