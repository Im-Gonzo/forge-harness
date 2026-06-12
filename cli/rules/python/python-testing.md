---
name: python-testing
description: Python test discipline — pytest + pytest-asyncio, Arrange-Act-Assert, real Postgres via testcontainers for DB/RLS tests, FastAPI dependency overrides, evidence-before-claims on every run. Tests are the proof a cited rule holds, not decoration.
paths: ["**/*.py", "**/*.pyi"]
---
# Python Testing

> Scope: every `.py`/`.pyi` test (and the code it covers). Stack: `pytest` +
> `pytest-asyncio`, SQLAlchemy 2.0 async, testcontainers for real-Postgres/RLS,
> run via `uv run pytest`. Definition of done: cited BR-IDs have passing tests and
> >90% coverage on pure logic (deriver, routing, threshold->verdict).

## Run it, then claim it

```bash
uv run pytest                                  # full suite
uv run pytest path/to/test_x.py::test_case -q  # one test while iterating
uv run pytest --cov=app --cov-report=term-missing
```

- [ ] Never say "tests pass" without running the ACTUAL command this turn and quoting the
      pass/fail line + exit code (see `rules/common/evidence-before-claims.md`). "Should
      pass" is not "passes".
- [ ] A green result is stale the moment the tree changes — re-run after every edit, do not
      carry an old green forward.

## Structure — Arrange / Act / Assert

- [ ] Each test has three visible phases: Arrange (set up inputs/state), Act (call the unit
      ONCE), Assert (check the outcome). Keep them in that order and visually separated.
- [ ] One behavior per test. The test name says what is asserted
      (`test_apply_transition_writes_audit_row`), not how it is implemented.
- [ ] Assert on observable behavior and return/raised values, not on internal call order or
      private attributes, unless that interaction IS the contract.
- [ ] Use `pytest.raises(SpecificError)` for error paths; assert the message/type, not just
      that "something raised".
- [ ] Parametrize tables (`@pytest.mark.parametrize`) for input variations instead of copy
      pasting near-identical tests. A long parametrize table is good, not "too long".

## Async tests (pytest-asyncio)

- [ ] Mark async tests (`@pytest.mark.asyncio`, or set `asyncio_mode = "auto"` in config and
      follow the project's convention). Use `async def` and `await` the unit under test.
- [ ] `await` every coroutine in the test body — an un-awaited call passes the test
      vacuously without exercising the code.
- [ ] Use an async client for an async app (`httpx.ASGITransport` /
      `httpx.AsyncClient(app=...)`), not the sync `TestClient`, for async-path coverage.
- [ ] Each async test gets its own session/transaction; do not leak event-loop or session
      state between tests.

## Fixtures and isolation

- [ ] Share setup through `conftest.py` fixtures with the narrowest scope that works
      (`function` by default; `session`/`module` only for expensive, read-only setup).
- [ ] Tests are independent and order-free: no test depends on another having run; clean up
      (or roll back) state so a single-test run and a full-suite run agree.
- [ ] Prefer rolling back a transaction (or a fresh schema/db per test) over manual teardown
      that can drift from setup.
- [ ] Do not hit the network or real external services in unit tests — fake/mock at the
      boundary (the HTTP client, the clock). Keep the fake's contract matching the real one.

## Real Postgres for DB and RLS tests (testcontainers)

In-memory SQLite does NOT exercise Postgres RLS, schemas, FX/ledger constraints, or pooling
behavior. For anything that depends on the database engine:

- [ ] Run against a REAL Postgres via `testcontainers` (a throwaway Postgres 16 container),
      not SQLite, not mocks of the session.
- [ ] Test RLS for real: set `SET LOCAL app.tenant_id`, then assert a cross-tenant query
      returns nothing. There MUST be a test that drives two tenants' requests over a SHARED
      pooled connection and proves no leak (the transaction-mode-pooling sharp edge).
- [ ] Verify the async engine is configured for pooling (e.g. `statement_cache_size=0`) in
      the test that exercises pooled connections, so the test would catch a regression.
- [ ] Migrations are part of correctness: a test (or CI step) runs `alembic upgrade head`
      against the container so schema drift fails the build.

## FastAPI testing

- [ ] Override the EXACT dependency object used by `Depends` (e.g. `get_db`, `get_current_user`)
      via `app.dependency_overrides`; overriding a different symbol silently does nothing.
- [ ] Clear `app.dependency_overrides` in teardown so overrides do not bleed into other
      tests.
- [ ] Test the contract: status code, `response_model` shape, and that NO secret/internal
      field appears in the body (mirror the `python-security.md` response checks).
- [ ] Cover the auth-failure and validation-failure (422) paths, not only the happy path.

## Coverage and what to test

- [ ] Pure decision logic (status deriver, routing, threshold->verdict, score-coordinate
      keying) carries the highest bar: >90% coverage and explicit edge cases.
- [ ] Every cited BR-ID change ships with a test that would fail if the rule were violated.
- [ ] Cover boundaries and error paths, not just the happy path: empty input, the None case,
      the limit, the duplicate, the concurrent write.
- [ ] Coverage is a floor, not the goal — a line executed without a meaningful assertion is
      not tested. Do not write assertion-free tests to lift the number.
