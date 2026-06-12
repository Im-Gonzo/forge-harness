---
name: typescript-testing
description: TypeScript test discipline. Vitest or Jest as runner, React Testing Library for components (test behavior, not implementation), Arrange-Act-Assert structure, meaningful coverage on logic and edge cases, no flaky async or real network. Playwright for E2E.
paths: ["**/*.ts", "**/*.tsx"]
---
# TypeScript Testing

> Scoped to `**/*.ts` and `**/*.tsx`. Layers the TypeScript stack onto the always-on
> `testing` rule. The `typescript-reviewer` agent checks that changed logic is covered.

## Runner and tools

- [ ] Use **Vitest** (preferred for Vite/Next/ESM projects) or **Jest** as the unit/
      integration runner — pick the one already in the repo; do not mix both.
- [ ] Use **React Testing Library** for component tests and **Playwright** for E2E of
      critical user flows.
- [ ] Tests are TypeScript too: type the test data and mocks. A test that only compiles
      because of `any` is not protecting the type contract it claims to.

## Test behavior, not implementation (RTL)

- [ ] Query by accessible role/label/text the way a user finds it
      (`getByRole`, `getByLabelText`), not by test-id or CSS class unless nothing else fits.
- [ ] Assert on rendered output and user-visible effects, not on internal state, props, or
      which hook fired. Refactors that keep behavior must keep tests green.
- [ ] Drive interactions with `@testing-library/user-event`, not raw `fireEvent`, so the
      events match real user behavior.

## Structure: Arrange-Act-Assert

- [ ] One logical behavior per test; structure each as Arrange (set up data/mocks), Act
      (invoke the unit / fire the interaction), Assert (one clear expectation focus).
- [ ] Name the test for the behavior and condition ("returns 401 when token is expired"),
      not the function name. The name should read as a spec line.
- [ ] Keep tests independent and order-free — no shared mutable state leaking between them;
      reset mocks between tests.

## Async without flake

- [ ] `await` async assertions; use `findBy*` / `waitFor` for async UI rather than fixed
      timeouts. Never `sleep` to "let it settle".
- [ ] Mock the network at the boundary (MSW or the fetch/client mock) — no real HTTP in
      unit tests. Use fake timers for time-dependent logic.
- [ ] Make every test deterministic: control clock, randomness, and locale. A test that
      passes only sometimes is a failing test.

## Coverage that means something

- [ ] Cover the logic and the edge cases: error paths, empty/`null`/boundary inputs, and
      the branch the bug lived in. A reproducing test must precede a bug fix.
- [ ] Chase meaningful coverage, not a number — 100% line coverage with no assertions on
      behavior proves nothing. Do not test trivial getters or framework glue for the metric.
- [ ] New logic ships with tests. A change to existing logic updates or adds the test that
      pins the new behavior.

## Before claiming green

- [ ] Run the actual suite (`vitest run` / `jest --ci`, plus `playwright test` for E2E) and
      report the real pass/fail counts and exit code per `evidence-before-claims` — never a
      remembered earlier green.
