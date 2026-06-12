---
name: react-patterns
description: React / Next.js patterns. Rules of Hooks (top-level only, exhaustive deps, cleanup), useEffect only for external sync (derive in render), Server/Client Component boundary and RSC leaks, state-location decision tree, stable list keys, memoize only when measured. Enforced by typescript-reviewer.
paths: ["**/*.ts", "**/*.tsx"]
---
# React Patterns

> Scoped to `**/*.ts` and `**/*.tsx` (hooks and component logic live in both). Layers
> React/Next.js conventions onto `typescript-style`. The `typescript-reviewer` agent owns
> these hook/JSX lanes together with the generic-TS and RSC-boundary lanes.

## Rules of Hooks

- [ ] Call hooks only at the top level of a function component or another hook — never in a
      loop, conditional, `&&`/ternary, nested function, or after an early return. Same order
      every render.
- [ ] Custom hooks are named `use…` so the linter recognizes them. Put the condition inside
      the hook, not the hook inside the condition.
- [ ] Enforce `eslint-plugin-react-hooks`: `react-hooks/rules-of-hooks: error` and
      `react-hooks/exhaustive-deps: warn` (treated as error in CI for new code). A missing
      plugin is itself a defect to flag.

## `useEffect` is for external sync only

- [ ] `useEffect` synchronizes with external systems (subscriptions, browser APIs,
      third-party libs). It is NOT for derived state, data transforms, resetting state on a
      prop change, or notifying a parent.
- [ ] Compute derived values during render. Reset child state with a `key` on the parent,
      not an effect. Notify parents in the event handler that caused the change.

```tsx
// WRONG: effect for derived state
const [fullName, setFullName] = useState("")
useEffect(() => { setFullName(`${first} ${last}`) }, [first, last])

// CORRECT: derive during render
const fullName = `${first} ${last}`
```

## Dependency arrays and cleanup

- [ ] Include every reactive value referenced inside an effect/callback. Never silence
      `exhaustive-deps` without a comment explaining why. An unwieldy dep array means the
      effect does too much — split it.
- [ ] Every subscription, interval, listener, or in-flight request cleans up in the return
      function (`AbortController`, `clearInterval`, `removeEventListener`). Missing cleanup =
      race conditions on dep change and leaks on unmount.

## Server / Client Component boundary (Next.js App Router, RSC)

- [ ] Server Components are the default — they `await` directly and never ship to the
      client. Client Components opt in with `"use client"` at the top of the file.
- [ ] Data flows down: a Server Component renders a Client Component and passes serializable
      props. A Client Component receives Server Components only via `children`/slots, never
      by importing them.
- [ ] Never import a `"server-only"` module, a DB client root, or a secret-bearing SDK from
      a `"use client"` file. Mark sensitive modules with `import "server-only"`.
- [ ] Do not pass sensitive fields (tokens, hashed passwords, full user records) as props
      across the boundary. Validate every `"use server"` Server Action's input with a schema
      and check authorization — treat it as a public endpoint.

## State location

1. [ ] Used by one component → `useState` inside it.
2. [ ] Used by parent + a few children → lift to the nearest common ancestor, pass via props.
3. [ ] Shared across distant branches → Context, **for low-frequency reads only** (theme,
       auth, locale). Context on a frequently-changing value re-renders every consumer.
4. [ ] High-frequency shared updates → an external store (Zustand, Jotai, Redux Toolkit).
5. [ ] Server-derived data → a server-state library (TanStack Query, SWR, RSC fetch), not
       application state. Do not fetch in `useEffect` when a cache library is available.

## Lists, keys, composition

- [ ] `key` must be stable and unique among siblings — never the array `index` for any list
      that can reorder, insert, or delete (state attaches to the wrong row otherwise).
- [ ] Compose with `children`, render props, and component props; never subclass a component
      to specialize it. Pair every Suspense boundary with an Error Boundary above it, placed
      close to where the data is needed.

## Performance: memoize only when it pays

- [ ] Default position is do NOT memoize. Add `useMemo`/`useCallback` only when the value
      feeds a `React.memo` child where identity matters, is a dependency of another hook, or
      is a measurably expensive computation (profile first).
- [ ] Premature memoization adds noise and can be slower than the recompute. Don't pass a
      fresh inline object/function as a prop to a memoized child — it defeats the memo.

## State and refs

- [ ] Use the functional updater when new state depends on old (`setCount(c => c + 1)`),
      especially in async/batched contexts, to avoid the stale-closure trap.
- [ ] Reach for `useReducer` once transitions depend on previous state or there are 3+
      related values. Never read/write `ref.current` during render — only in effects or
      handlers.
