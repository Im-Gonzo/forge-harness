"use client";

/**
 * form-slot — resolve the per-kind Visual form by CONVENTION.
 *
 * Loads `forms/<kind>.tsx`'s default export with a dynamic import. The import
 * specifier is a template literal so the bundler builds a request CONTEXT over
 * the `forms/` directory — meaning a new kind's form is picked up simply by
 * adding `forms/<kind>.tsx`, with NO central registry to edit here. Until a
 * form exists for a kind, the slot renders a graceful "no visual form yet"
 * notice (the Raw tab still fully edits that kind).
 */
import * as React from "react";

import type { ResourceFormComponent, ResourceFormProps } from "./types";

/** Cache resolved form modules so a kind isn't re-imported on every render. */
const cache = new Map<string, ResourceFormComponent | null>();

function loadForm(kind: string): Promise<ResourceFormComponent | null> {
  // Template-literal import → bundler context over ./forms/*. The `.tsx` files
  // export the form as default (ResourceFormComponent).
  return import(`./forms/${kind}.tsx`)
    .then((mod: { default: ResourceFormComponent }) => mod.default ?? null)
    .catch(() => null);
}

export function FormSlot(props: ResourceFormProps) {
  const { kind } = props;
  // The resolution is DERIVED from the module cache at render time — a cache hit
  // needs no state at all. The effect's ONLY job is to kick off the async load
  // for an uncached kind and, when it lands, bump a counter to re-render (it
  // never sets state synchronously, so no cascading-render lint violation).
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    if (cache.has(kind)) return; // already resolved — nothing to load.
    let cancelled = false;
    loadForm(kind).then((form) => {
      cache.set(kind, form);
      if (!cancelled) forceRender();
    });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const resolvedThisKind = cache.has(kind);
  const Form = resolvedThisKind ? (cache.get(kind) ?? null) : null;
  const state: "loading" | "ready" | "missing" = !resolvedThisKind
    ? "loading"
    : Form
      ? "ready"
      : "missing";

  if (state === "loading") {
    return (
      <p className="font-mono text-xs text-muted-foreground">
        Loading {kind} form…
      </p>
    );
  }

  if (state === "missing" || !Form) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4">
        <p className="font-mono text-xs text-muted-foreground">
          No visual form for{" "}
          <span className="text-foreground">{kind}</span> yet — add{" "}
          <span className="text-foreground">
            forms/{kind}.tsx
          </span>{" "}
          to enable it. Use the{" "}
          <span className="text-foreground">Raw</span> tab to edit this resource
          in the meantime.
        </p>
      </div>
    );
  }

  // Render via createElement (not JSX): `Form` is a component VALUE resolved from
  // the cache, not a component DECLARED in render — createElement makes that
  // explicit and satisfies the static-components rule.
  return React.createElement(Form, props);
}
