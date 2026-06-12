---
name: git-workflow
description: Always-on git hygiene. Conventional commit messages, small focused commits, never on the default branch, never skip hooks, and base PRs on the full diff against the target branch.
---
# Git Workflow

> Always-on, global. Stack-neutral version-control hygiene. Commit/push only when the
> user asks; the `block-no-verify` hook backs the never-skip-hooks rule.

## Commits

- [ ] Use a conventional message: `<type>: <description>` with an optional body.
      Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
- [ ] The subject is imperative and concise; the body says WHY, not a line-by-line
      restatement of WHAT (the diff already shows what).
- [ ] One logical change per commit. Don't mix a refactor, a feature, and a format
      sweep into one commit — they can't be reviewed or reverted independently.
- [ ] Never commit secrets, generated artifacts, or commented-out code.

## Branching

- [ ] Do NOT commit directly to the default branch (`main`/`master`). Branch first
      with a descriptive name (`feat/...`, `fix/...`).
- [ ] Push a new branch with `-u` so it tracks upstream.
- [ ] Keep the branch current with its target (merge/rebase) and resolve conflicts
      before requesting review.

## Never bypass the gates

- [ ] Do NOT use `--no-verify` or otherwise skip pre-commit / pre-push / CI hooks.
      If a hook fails, fix the cause — the hook is the signal, not the obstacle.
- [ ] Do NOT edit linter/CI config to make a failure disappear; fix the code.

## Pull requests

- [ ] Base the summary on the WHOLE change, not just the last commit:
      `git diff <base>...HEAD` and review the full commit history.
- [ ] Write a clear summary (what changed and why) plus a test plan a reviewer can run.
- [ ] Confirm CI is green before asking for review.

## Before you claim it's pushed

- [ ] Only claim "committed" / "pushed" after running the command and reading its exit
      code and output — per `evidence-before-claims`. No remembered green.
