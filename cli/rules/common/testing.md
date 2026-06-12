---
name: testing
description: Always-on testing discipline. Tests are part of done; use Arrange-Act-Assert with behavior-naming, cover units/integration/critical-flows, target ~80% coverage, and fix the code not the test.
---
# Testing

> Always-on, global. Stack-neutral test discipline; the per-language packs
> (`python-testing`, `typescript-testing`) name the concrete runner and commands.

## Tests are part of "done"

- [ ] New behavior ships with tests for it. A feature without a test is not complete.
- [ ] A bug fix ships with a regression test that fails before the fix and passes
      after — proving the fix and pinning it.
- [ ] Fix the CODE, not the test. Only change a test when the test itself encoded the
      wrong expectation, and say so explicitly.

## The AAA pattern

Structure every test as **Arrange — Act — Assert**: set up inputs, perform the one
action under test, then assert on the outcome. One logical behavior per test.

```
test("returns 0 similarity for orthogonal vectors", () => {
  // Arrange
  const a = [1, 0, 0];
  const b = [0, 1, 0];

  // Act
  const score = cosineSimilarity(a, b);

  // Assert
  expect(score).toBe(0);
});
```

## Name tests by behavior

- [ ] The name states the expected behavior, not the function name:
      `"throws when api key is missing"`, `"falls back to substring search when redis is down"`.
- [ ] A reader should know what broke from the failing test's name alone.

## What to cover

- [ ] **Unit** — individual functions/components, including edge cases and the
      error/empty/boundary paths, not just the happy path.
- [ ] **Integration** — real seams: API endpoints, DB operations, queue handlers.
- [ ] **Critical flows** — at least the few end-to-end paths a user cannot lose.

## Coverage and isolation

- [ ] Target ~80% line coverage as a floor, with judgment — meaningful assertions over
      coverage theater. Critical paths warrant higher.
- [ ] Tests are deterministic and isolated: no shared mutable state, no ordering
      dependence, no real network/clock/randomness without control. A flaky test is a
      failing test — fix or quarantine it, don't ignore it.
