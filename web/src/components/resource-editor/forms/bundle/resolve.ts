/**
 * forms/bundle/resolve — POINTER RESOLVE-STATUS for a bundle's references.
 *
 * A bundle is a pointer document: it cites skills, agents, ADRs, spec sections,
 * and BR ids by reference and never restates them. The Visual form shows, next to
 * each pointer, whether it RESOLVES — a read-only lookup, never a write.
 *
 * Two classes of pointer, with different resolution domains:
 *
 *   HARNESS pointers — `skill`, `secondary_skill`, `agent`, `reviewer`. These
 *     point at artifacts that live IN this Forge harness, addressed by a path like
 *     `.claude/skills/load-bundle/SKILL.md` or `.claude/agents/code-reviewer.md`.
 *     We extract the artifact id from the path and look it up in the live
 *     registry (`forge registry ls`, surfaced read-only at /api/registry). A hit
 *     ⇒ "resolved"; a miss ⇒ "unresolved" (a real dangling reference the author
 *     should fix). This is the same id↔path mapping the registry itself uses
 *     (skill:<id> ⇒ skills/<id>/SKILL.md, agent:<id> ⇒ agents/<id>.md).
 *
 *   CORPUS pointers — `adrs[].id/.path`, `spec_sections[].path`, `br_ids[]`,
 *     `dod_ref`. These point at the TARGET PROJECT's corpus (its docs/adr,
 *     spec files, BR catalog), which is NOT part of the Forge repo — the bundle
 *     linter checks their SHAPE here and resolves them on-disk only in the target
 *     repo at bootstrap (see validate-bundles B-2). So we report their SHAPE
 *     validity ("well-formed" vs "malformed"), labelled EXTERNAL — never a false
 *     "unresolved", which would wrongly flag every correct bundle in this repo.
 *
 * Pure (no React, no IO): it takes an already-fetched registry index and returns
 * plain status records the form renders. The form fetches /api/registry once.
 */

import type { RegistryArtifact } from "@/lib/types";

// ──────────────────────────────────────────────────────────────────────────
// Registry index (built once from the read-only /api/registry payload)
// ──────────────────────────────────────────────────────────────────────────

/** A lightweight lookup over the registry, keyed by kind+id. */
export interface RegistryIndex {
  /** All skill ids present in the registry. */
  skills: Set<string>;
  /** All agent ids present in the registry. */
  agents: Set<string>;
}

/** Build a RegistryIndex from the `forge registry ls` artifact list. */
export function buildRegistryIndex(
  artifacts: RegistryArtifact[] | undefined,
): RegistryIndex {
  const skills = new Set<string>();
  const agents = new Set<string>();
  for (const a of artifacts ?? []) {
    if (a.kind === "skill") skills.add(a.id);
    else if (a.kind === "agent") agents.add(a.id);
  }
  return { skills, agents };
}

// ──────────────────────────────────────────────────────────────────────────
// Pointer id extraction
// ──────────────────────────────────────────────────────────────────────────

/**
 * Extract a SKILL id from a pointer path. The canonical form is
 * `.claude/skills/<id>/SKILL.md` (or any `.../skills/<id>/SKILL.md`); a bare id
 * is accepted as-is. Returns "" when no id can be read.
 */
export function skillIdFromPointer(pointer: string): string {
  if (!pointer) return "";
  const m = pointer.match(/skills\/([^/]+)\/SKILL\.md$/);
  if (m) return m[1];
  // A bare id (no path separators) is treated as the id directly.
  if (!pointer.includes("/")) return pointer.replace(/\.md$/, "");
  return "";
}

/**
 * Extract an AGENT id from a pointer path. Canonical form
 * `.claude/agents/<id>.md` (or any `.../agents/<id>.md`); a bare id is accepted.
 */
export function agentIdFromPointer(pointer: string): string {
  if (!pointer) return "";
  const m = pointer.match(/agents\/([^/]+)\.md$/);
  if (m) return m[1];
  if (!pointer.includes("/")) return pointer.replace(/\.md$/, "");
  return "";
}

// ──────────────────────────────────────────────────────────────────────────
// Resolve status
// ──────────────────────────────────────────────────────────────────────────

/**
 * - resolved   — a harness pointer that hit a live registry artifact.
 * - unresolved — a harness pointer that did NOT (a real dangling ref).
 * - external   — a corpus pointer whose shape is well-formed; resolution is the
 *                target repo's job (advisory, not an error here).
 * - malformed  — a corpus pointer whose SHAPE is wrong (e.g. an ADR id that
 *                isn't `ADR-<n>`, or an empty required pointer).
 * - empty      — the field is blank (optional pointer left unset).
 */
export type ResolveStatus =
  | "resolved"
  | "unresolved"
  | "external"
  | "malformed"
  | "empty";

export interface PointerStatus {
  status: ResolveStatus;
  /** Short human-readable note (e.g. the resolved id, or why it's malformed). */
  detail: string;
}

const ADR_ID = /^ADR-\d+$/;
const BR_ID = /^BR-[A-Z]+-\d+$/;

/** Resolve a harness SKILL pointer against the registry. */
export function resolveSkill(pointer: string, index: RegistryIndex): PointerStatus {
  if (!pointer || pointer.trim() === "") return { status: "empty", detail: "" };
  const id = skillIdFromPointer(pointer);
  if (!id) return { status: "malformed", detail: "not a skills/<id>/SKILL.md path" };
  return index.skills.has(id)
    ? { status: "resolved", detail: `skill:${id}` }
    : { status: "unresolved", detail: `no skill:${id} in registry` };
}

/** Resolve a harness AGENT pointer against the registry. */
export function resolveAgent(pointer: string, index: RegistryIndex): PointerStatus {
  if (!pointer || pointer.trim() === "") return { status: "empty", detail: "" };
  const id = agentIdFromPointer(pointer);
  if (!id) return { status: "malformed", detail: "not an agents/<id>.md path" };
  return index.agents.has(id)
    ? { status: "resolved", detail: `agent:${id}` }
    : { status: "unresolved", detail: `no agent:${id} in registry` };
}

/** Shape-check an ADR pointer (corpus — external resolution). */
export function resolveAdr(id: string, path: string): PointerStatus {
  if (!id && !path) return { status: "empty", detail: "" };
  if (!ADR_ID.test(id)) {
    return { status: "malformed", detail: `id must match ADR-<n> (got "${id}")` };
  }
  if (!path || path.trim() === "") {
    return { status: "malformed", detail: "path is required" };
  }
  return { status: "external", detail: `${id} → ${path} (target corpus)` };
}

/** Shape-check a spec-section pointer (corpus — external resolution). */
export function resolveSpecSection(path: string): PointerStatus {
  if (!path || path.trim() === "") {
    return { status: "malformed", detail: "path is required" };
  }
  return { status: "external", detail: `${path} (target corpus)` };
}

/** Shape-check a BR id (corpus — external resolution). */
export function resolveBrId(brId: string): PointerStatus {
  if (!brId || brId.trim() === "") return { status: "empty", detail: "" };
  return BR_ID.test(brId)
    ? { status: "external", detail: `${brId} (BR catalog)` }
    : { status: "malformed", detail: `must match BR-<AREA>-<n> (got "${brId}")` };
}

/** Shape-check the dod_ref (corpus — external resolution). */
export function resolveDodRef(dodRef: string): PointerStatus {
  if (!dodRef || dodRef.trim() === "") {
    return { status: "malformed", detail: "dod_ref is required" };
  }
  return { status: "external", detail: `${dodRef} (target corpus)` };
}
