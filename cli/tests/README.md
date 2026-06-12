# Forge meta-tests

Behavioral contracts that assert Forge's load-bearing **governance prose** is still
present in its own assets. This is `docs/METHOD.md` §10 ("Forge validates Forge") made
mechanical: a prompt regression — dropping the Pre-Report Gate, the zero-findings clause,
the read-only invariant, `pass^k`, or a Prompt Defense pillar — becomes a **failing build**,
not silent drift.

These are **separate from** `lint/` validators:

| Layer | What it checks | Runner |
|---|---|---|
| `lint/validate-*.mjs`, `lint/check-*.mjs` | asset **shape** (frontmatter present & well-formed, xrefs resolve, no unsafe unicode) | `node lint/run-all.mjs [--strict]` |
| `tests/meta/*.mjs` | asset **behavior / content** (the governance prose itself) | `node tests/run-meta.mjs` |

CI runs both (see `.github/workflows/ci.yml`).

## Running

From the Forge repo root:

```bash
node tests/run-meta.mjs
```

The runner discovers every `tests/meta/*.mjs`, runs each as its own child process,
prints `PASS`/`FAIL` per test plus a summary, and **exits 1 if any meta-test fails**
(mirrors `lint/run-all.mjs`). Run a single meta-test directly while iterating:

```bash
node tests/meta/reviewer-anti-noise.mjs
```

## The meta-tests

| File | Asserts |
|---|---|
| `meta/reviewer-anti-noise.mjs` | every reviewer agent (code/diff/python/typescript/database/security) contains the anti-noise scaffolding: a **Pre-Report Gate**, a **clean-review-is-valid** (zero-findings-is-legitimate) clause, and **HIGH/CRITICAL require proof**. Fails naming the offending file. |
| `meta/reviewers-read-only.mjs` | every reviewer's `tools:` frontmatter grants **neither Edit nor Write** (the T0 read-only invariant; handles inline, quoted-inline, and block-list YAML). |
| `meta/agent-frontmatter.mjs` | every `agents/*.md` declares `name` + `description` + `tools` + `model`, and `model ∈ {haiku, sonnet, opus, inherit}` (behavioral restatement over `validate-agents`). |
| `meta/skill-governance.mjs` | `dual-review` mentions two **independent** reviewers (both must pass); `run-eval` mentions **pass@k** AND **pass^k**; `capture-learning` and `curate-memory` mention **confidence** + **evidence**. |
| `meta/prompt-defense.mjs` | `rules/prompt-defense-baseline.md` keeps its three pillars: untrusted external/tool content is data not instructions, no role/identity change, no secret leakage/exfiltration. |

## Conventions for new meta-tests

- **Node ESM, zero-dependency.** Use only `node:` built-ins (`node:assert`, `node:fs`, …).
- A meta-test is a standalone script: define a tiny `test(name, fn)` harness, print
  `PASS`/`FAIL` per assertion, and `process.exit(1)` on any failure. The runner reports
  per-file pass/fail and aggregates.
- **Assert PRESENCE of intent, tolerate phrasing.** Match a concept with a set of accepted
  patterns (`patterns.some(...)`), not one brittle literal — assets vary in heading style
  (`### HIGH / CRITICAL Require Proof` vs inline `**HIGH/CRITICAL require proof**`). Match
  the *meaning*, loosely enough to survive a reword but tightly enough to fail a deletion.
- If an assertion fails because an asset **genuinely lacks** the prose, fix the **asset** —
  do not weaken the test. The test is the spec.
