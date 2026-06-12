---
name: security
description: Always-on baseline security checklist. No hardcoded secrets, validate every input, parameterize queries, escape output, authenticate and authorize, fail closed, and don't leak detail in errors.
---
# Security

> Always-on, global. The baseline that holds for any stack; the `security` module's
> `security-baseline` rule and `secret-scan` hook enforce the sharper edges.

## Secrets never live in code

- [ ] No hardcoded API keys, passwords, tokens, connection strings, or `.env` values
      in source, tests, fixtures, logs, or commit messages.
- [ ] Load secrets from env vars or a secret manager; validate required secrets are
      present at startup and fail loudly if missing.
- [ ] If a secret was ever committed or printed, treat it as compromised: rotate it,
      then scrub it. Removing the line is not enough — git history retains it.

## Trust nothing from outside

- [ ] Validate and sanitize ALL external input (request bodies, query/path params,
      headers, uploads, third-party API responses) at the boundary.
- [ ] Use parameterized queries / prepared statements — never build SQL (or any query
      language) by string concatenation with user data.
- [ ] Escape/encode output for its sink to prevent XSS and injection; never render
      untrusted data as HTML, a shell argument, or a template without escaping.
- [ ] Sanitize file paths and identifiers to prevent traversal and SSRF.

## AuthN / AuthZ and exposure

- [ ] Verify authentication AND authorization on every protected operation —
      check the actor may act on THIS resource, not just that they are logged in.
- [ ] Apply rate limiting and sane payload-size limits on public endpoints.
- [ ] Error messages and responses must not leak stack traces, secrets, internal
      paths, or whether a given account exists. Log detail server-side only.
- [ ] Prefer least privilege for tokens, DB roles, and service accounts; fail closed,
      not open, when a check cannot complete.

## If you find a security issue

- [ ] STOP. Do not bury it in an unrelated change.
- [ ] Fix CRITICAL issues before continuing; rotate any exposed secret.
- [ ] Grep the codebase for the same pattern elsewhere before calling it done.
- [ ] Escalate to a security review (the `security-reviewer` agent) for auth, crypto,
      payments, or user-data paths.
