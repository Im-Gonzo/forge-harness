/**
 * forms/bundle/fields — typed coercion, defaults, and the canonical key ORDER
 * for the bundle Visual form. Pure (no React) so it is unit-testable and shared
 * between the form and any projection.
 *
 * KEY-ORDER CONTRACT: the bundle schema's `required[]` fixes a canonical order
 * (id … human_gate); the optional pointer keys (secondary_skill, reviewer) and
 * the optional gate arrays slot in at their hand-authored positions. The form
 * always rebuilds the frontmatter through `composeBundleFrontmatter`, which walks
 * CANONICAL_ORDER, so a created bundle's keys read top-to-bottom exactly like the
 * hand-authored ones and a re-serialize is byte-stable.
 */

// ──────────────────────────────────────────────────────────────────────────
// Pointer-bearing sub-shapes (mirrors src/lib/types.ts Bundle* but local —
// types.ts is Phase-0-owned and not edited here).
// ──────────────────────────────────────────────────────────────────────────

export interface AdrPointer {
  id: string;
  path: string;
  why?: string;
}

export interface SpecSection {
  path: string;
  sections: string[];
}

export interface Invisible20 {
  id: string;
  rule: string;
  check?: string;
  refs: string[];
}

/** The fully-coerced editable view of a bundle's frontmatter. */
export interface BundleDraft {
  id: string;
  title: string;
  version: number;
  status: string;
  work_type: string;
  invariants: number[];
  adrs: AdrPointer[];
  spec_sections: SpecSection[];
  br_ids: string[];
  conformance: string[];
  modules: string[];
  skill: string;
  secondary_skill: string; // "" ⇒ key omitted
  agent: string;
  reviewer: string; // "" ⇒ key omitted
  dod_ref: string;
  invisible_20: Invisible20[];
  human_gate: boolean;
}

/**
 * Canonical key order for the emitted frontmatter. The 16 REQUIRED keys appear
 * in schema order; the two optional pointer keys sit immediately after the
 * primary they qualify (secondary_skill after skill, reviewer after agent), which
 * is exactly where the hand-authored bundles place them.
 */
export const CANONICAL_ORDER = [
  "id",
  "title",
  "version",
  "status",
  "work_type",
  "invariants",
  "adrs",
  "spec_sections",
  "br_ids",
  "conformance",
  "modules",
  "skill",
  "secondary_skill",
  "agent",
  "reviewer",
  "dod_ref",
  "invisible_20",
  "human_gate",
] as const;

/** The 16 REQUIRED keys (validate-bundles B-1 / schema required[]). */
export const REQUIRED_KEYS = [
  "id",
  "title",
  "version",
  "status",
  "work_type",
  "invariants",
  "adrs",
  "spec_sections",
  "br_ids",
  "conformance",
  "modules",
  "skill",
  "agent",
  "dod_ref",
  "invisible_20",
  "human_gate",
] as const;

/** The project's 10 invariants (validate-bundles B-3: a non-empty subset of 1..10). */
export const INVARIANT_RANGE = Array.from({ length: 10 }, (_, i) => i + 1);

// ──────────────────────────────────────────────────────────────────────────
// Coercion (frontmatter → BundleDraft)
// ──────────────────────────────────────────────────────────────────────────

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asIntArray(v: unknown): number[] {
  return Array.isArray(v)
    ? v.filter((x): x is number => typeof x === "number" && Number.isInteger(x))
    : [];
}

function asAdrs(v: unknown): AdrPointer[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const adr: AdrPointer = { id: asString(o.id), path: asString(o.path) };
    if (typeof o.why === "string" && o.why !== "") adr.why = o.why;
    return adr;
  });
}

function asSpecSections(v: unknown): SpecSection[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return { path: asString(o.path), sections: asStringArray(o.sections) };
  });
}

function asInvisible20(v: unknown): Invisible20[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const inv: Invisible20 = {
      id: asString(o.id),
      rule: asString(o.rule),
      refs: asStringArray(o.refs),
    };
    if (typeof o.check === "string" && o.check !== "") inv.check = o.check;
    return inv;
  });
}

/** Coerce a raw frontmatter object into the editable BundleDraft. */
export function toBundleDraft(fm: Record<string, unknown>): BundleDraft {
  return {
    id: asString(fm.id),
    title: asString(fm.title),
    version:
      typeof fm.version === "number" && Number.isInteger(fm.version)
        ? fm.version
        : 1,
    status: asString(fm.status) || "active",
    work_type: asString(fm.work_type),
    invariants: asIntArray(fm.invariants),
    adrs: asAdrs(fm.adrs),
    spec_sections: asSpecSections(fm.spec_sections),
    br_ids: asStringArray(fm.br_ids),
    conformance: asStringArray(fm.conformance),
    modules: asStringArray(fm.modules),
    skill: asString(fm.skill),
    secondary_skill: asString(fm.secondary_skill),
    agent: asString(fm.agent),
    reviewer: asString(fm.reviewer),
    dod_ref: asString(fm.dod_ref),
    invisible_20: asInvisible20(fm.invisible_20),
    human_gate: fm.human_gate === true,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Compose (BundleDraft → frontmatter, in canonical key order)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the emitted frontmatter object in CANONICAL_ORDER. Optional pointer keys
 * (secondary_skill, reviewer) are omitted when blank — never written as empty
 * strings — and the optional `why`/`check` sub-keys are dropped when empty, so a
 * minimal bundle stays clean. Required keys are always present (even when empty),
 * so validate-bundles' B-1 "missing required key" never fires on a partial draft;
 * the value-level checks (B-2/B-3/B-4 + schema) then guide the author.
 */
export function composeBundleFrontmatter(
  draft: BundleDraft,
): Record<string, unknown> {
  const adrs = draft.adrs.map((a) => {
    const o: Record<string, unknown> = { id: a.id, path: a.path };
    if (a.why && a.why.trim() !== "") o.why = a.why;
    return o;
  });

  const specSections = draft.spec_sections.map((s) => ({
    path: s.path,
    sections: s.sections,
  }));

  const invisible20 = draft.invisible_20.map((inv) => {
    const o: Record<string, unknown> = { id: inv.id, rule: inv.rule };
    if (inv.check && inv.check.trim() !== "") o.check = inv.check;
    o.refs = inv.refs;
    return o;
  });

  const out: Record<string, unknown> = {
    id: draft.id,
    title: draft.title,
    version: draft.version,
    status: draft.status,
    work_type: draft.work_type,
    invariants: draft.invariants,
    adrs,
    spec_sections: specSections,
    br_ids: draft.br_ids,
    conformance: draft.conformance,
    modules: draft.modules,
    skill: draft.skill,
  };
  if (draft.secondary_skill.trim() !== "") {
    out.secondary_skill = draft.secondary_skill;
  }
  out.agent = draft.agent;
  if (draft.reviewer.trim() !== "") {
    out.reviewer = draft.reviewer;
  }
  out.dod_ref = draft.dod_ref;
  out.invisible_20 = invisible20;
  out.human_gate = draft.human_gate;
  return out;
}

/** A sensible default frontmatter for a NEW bundle (every required key present). */
export function defaultBundleFrontmatter(id: string): Record<string, unknown> {
  return composeBundleFrontmatter({
    id,
    title: "",
    version: 1,
    status: "active",
    work_type: "",
    invariants: [],
    adrs: [],
    spec_sections: [],
    br_ids: [],
    conformance: [],
    modules: [],
    skill: "",
    secondary_skill: "",
    agent: "",
    reviewer: "",
    dod_ref: "",
    invisible_20: [],
    human_gate: false,
  });
}
