---
name: typescript-style
description: TypeScript craft standards. Strict tsconfig, no implicit/leaked `any`, no unchecked `as`/`!`, explicit types on public APIs, immutable updates, narrow `unknown` errors, validate at boundaries. Type-check with `tsc --noEmit` before every push — eslint/tsx do NOT type-check.
paths: ["**/*.ts", "**/*.tsx"]
---
# TypeScript Style

> Scoped to `**/*.ts` and `**/*.tsx`. Layers concrete TypeScript syntax on top of the
> always-on `coding-style` rule. The `typescript-reviewer` agent reviews against this.

## Strict compiler, always

- [ ] `tsconfig.json` runs with `strict: true` (which turns on `noImplicitAny`,
      `strictNullChecks`, and the rest). Do not weaken it to make code pass.
- [ ] Keep `noUncheckedIndexedAccess`, `noImplicitOverride`, and
      `exactOptionalPropertyTypes` on once the codebase is clean enough to afford them.
- [ ] A change that relaxes `strict` (or disables a strictness flag) is a code smell, not a
      fix — fix the types instead, and flag any such tsconfig edit explicitly in review.

## No `any` leakage

- [ ] Do not use `any` in application code. Use `unknown` for external/untrusted input and
      narrow it; use generics when a value's type depends on the caller.
- [ ] `any` must never cross a boundary — a parameter, a return type, or an exported type.
      A contained, immediately-narrowed `any` in a `.d.ts` shim or a test mock is tolerable.
- [ ] No `@ts-ignore`/`@ts-expect-error` without a one-line comment stating why and what
      would remove it.

```typescript
// WRONG: any removes type safety and leaks out
function getErrorMessage(error: any) { return error.message }

// CORRECT: unknown forces safe narrowing
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error'
}
```

## No escape hatches without proof

- [ ] No `as` cast that bypasses the checker just to silence an error — fix the type. A
      narrowing assertion is acceptable only when you can show it always holds.
- [ ] No non-null `!` without a preceding runtime guard; prefer `?.` + `?? fallback` or an
      explicit check.

## Explicit types on public surfaces

- [ ] Add parameter and return types to exported functions, shared utilities, and public
      class methods. Let TypeScript infer obvious local variable types.
- [ ] Use `interface` for object shapes meant to be extended/implemented; use `type` for
      unions, intersections, tuples, and mapped/utility types.
- [ ] Prefer string-literal unions over `enum` unless an `enum` is required for interop.
- [ ] Extract a repeated inline object shape into a named type or interface.

## Immutability and errors

- [ ] Update immutably (spread / `Readonly<T>`); never mutate a caller's object.
- [ ] `async`/`await` with `try-catch`; narrow `unknown` errors; `throw new Error(...)`,
      never a bare string. No empty `catch`.
- [ ] Validate external data at the boundary (a schema lib such as zod) and infer the type
      from the schema. Validate `process.env` access at startup, not ad hoc.

## Naming and hygiene

- [ ] `camelCase` for variables/functions, `PascalCase` for types/classes/components,
      `UPPER_SNAKE` for true constants. `const` by default, `let` only when reassigned,
      never `var`. Always `===`/`!==`.
- [ ] No `console.log` in production code — use a structured logger.

## Type-check before push (non-negotiable)

- [ ] **eslint and tsx/ts-node do NOT type-check.** ESLint lints; the dev runner runs.
      Neither validates types. A green lint or a working dev session is not type proof.
- [ ] Run `tsc --noEmit` (or the project's `typecheck` script) before every push — the
      release build runs full `tsc`, so an un-type-checked push fails CI later, not now.
- [ ] In project-reference repos, run the non-emitting solution check
      (`tsc --build --noEmit` / the repo's `typecheck`) rather than checking one config.
- [ ] Per `evidence-before-claims`: "types pass" is a claim — back it with the actual
      `tsc --noEmit` exit code captured this turn, not a remembered earlier green.
