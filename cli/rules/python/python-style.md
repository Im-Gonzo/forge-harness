---
name: python-style
description: Python style and type discipline — ruff (lint + format) and mypy --strict are the gate, plus the idioms and async/Pydantic v2/SQLAlchemy 2.0 patterns this stack expects. The linters are authoritative; this file is what they cannot mechanically enforce.
paths: ["**/*.py", "**/*.pyi"]
---
# Python Style

> Scope: every `.py`/`.pyi` file. Aligned to a typical stack contract
> (`AGENTS.md`): Python 3.12+, FastAPI + Pydantic v2, SQLAlchemy 2.0 async, `uv`.
> The toolchain decides; this file covers judgment the toolchain cannot.

## The gate (run before claiming done)

```bash
uv run ruff check .          # lint
uv run ruff format --check . # formatting (ruff IS the formatter — no black/isort)
uv run mypy .                # type check, strict
```

- [ ] `ruff check` and `ruff format --check` are clean. Do NOT hand-format around the
      formatter or re-litigate formatting it owns.
- [ ] `mypy .` passes under `--strict`. A green ruff is not a type check — run mypy too.
- [ ] Fix the code, not the config. Do not relax `ruff`/`mypy` settings or add blanket
      ignores to make the gate pass.

## Typing (mypy --strict)

- [ ] Every function and method has fully annotated parameters and a return type. Public
      API especially — no implicit `Any` on a signature.
- [ ] No `Any` where a concrete type, `TypedDict`, Pydantic model, `Protocol`, or generic is
      available. `Any` is a deliberate, commented choice, not a default.
- [ ] `# type: ignore` carries a specific error code (`# type: ignore[arg-type]`) and a
      reason. A bare `# type: ignore` is not allowed.
- [ ] Modern syntax: `X | None` (not `Optional[X]`), `list[str]`/`dict[str, int]` (not
      `typing.List`), `str | int` unions. Python 3.12+.
- [ ] Compare to `None` with `is`/`is not`, never `==`. Narrow `X | None` with an explicit
      guard before use.
- [ ] Use `Protocol` for structural/duck-typed interfaces; reserve ABCs for true nominal
      hierarchies.

## Idioms

- [ ] Prefer immutable data: `@dataclass(frozen=True)`, `NamedTuple`, `tuple` over mutable
      module-level/class-level state. For domain DTOs prefer a Pydantic model or frozen
      dataclass over a bare `dict`.
- [ ] No mutable default arguments (`def f(x: list[int] = [])`). Use `None` + assign inside,
      or `Field(default_factory=...)` on Pydantic models.
- [ ] Comprehensions / generator expressions over manual accumulate loops; `"".join(parts)`
      over `+=` string building in a loop.
- [ ] `isinstance(x, T)` over `type(x) == T`. `enum.Enum` over magic constants.
- [ ] Manage every resource (file, session, lock, client) with `with` / `async with`, never
      manual open/close.
- [ ] `logging` (a module logger), never `print`, in library/app code.
- [ ] No `from module import *`. No shadowing builtins (`list`, `dict`, `id`, `type`).
- [ ] Keep functions focused: roughly <= 50 lines, <= 5 positional params (group into a
      dataclass/model past that), nesting <= 4 (prefer early returns). An exhaustive
      `match`/config table is exempt — length is not complexity.

## Async (FastAPI / SQLAlchemy 2.0 async)

- [ ] `async def` for any handler/function that does I/O; inside it, use the async client.
- [ ] NEVER call blocking code from `async def`: no `requests`, `time.sleep`, sync
      SQLAlchemy `Session`, or blocking file I/O. Use the async equivalent, `await
      asyncio.sleep`, the `AsyncSession`, or `await loop.run_in_executor(...)` for
      unavoidable blocking/CPU work.
- [ ] Always `await` coroutines (including `session.execute`, `session.commit`). Detach
      intentionally only with `asyncio.create_task` and a comment — never by forgetting
      `await`.
- [ ] One `AsyncSession` is single-task: do not share it across `asyncio.gather` of DB
      calls. Inject it via `Depends`; never construct it inline in a handler.

## Pydantic v2

- [ ] v2 API only: `@field_validator`/`@model_validator` (not `@validator`),
      `model_config = ConfigDict(...)` (not `class Config`), `model_dump()`/
      `model_validate()` (not `.dict()`/`parse_obj`).
- [ ] Express validation as field constraints (`Field(gt=…, max_length=…)`, `Annotated`
      types, typed enums) rather than hand-written `if` checks where Pydantic can state it.
- [ ] Separate request, update, and response schemas. A response model must not expose
      secrets or internal fields (see `python-security.md`).

## FastAPI structure

- [ ] App construction in `create_app()`. Routers stay thin — persistence and business
      logic live in services/repositories.
- [ ] Database session and auth come from dependencies (`Depends`), not globals or inline
      construction in handlers.
- [ ] Annotate endpoints with `response_model`. Cite the governing BR-ID / ADR in the change
      (project convention: code with no rule behind it does not merge).

## Imports and module graph

- [ ] Import order is `ruff` (isort rules) territory — let the formatter sort; do not hand-order.
- [ ] Respect module acyclicity: no cross-context table access, only typed service interfaces
      (enforced by `lint-imports`). Do not introduce an import cycle to "make it work".
