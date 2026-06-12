/**
 * forge-bridge/composition — the per-project COMPOSITION (adopt) surface (ADR-0019).
 *
 * Wraps `forge compose <verb>` against the ACTIVE harness root (the bridge spawns
 * with cwd = getActiveRoot()). The COMPOSITION is the per-active-root set of
 * resources the project has ADOPTED from its catalog read-view (library-local ∪
 * subscribed slices, Slice 1). It is a SEPARATE, additive layer from the global
 * library: adopt != admit — adopt records a per-project selection in
 * .forge/composition.json and does NOT write the library or run the admission/T2
 * gate. An adopted entry is keyed by (uid, sourceId); sourceId===null means the
 * library-local copy. New resources are NOT adopted by default (opt-in).
 *
 *   - getComposition()             — `compose list` (read-only; entries joined to records).
 *   - compositionAdopt(uid, src?)  — `compose adopt <uid> [--source <src>] --apply` (idempotent add).
 *   - compositionRemove(uid, src?) — `compose remove <uid> [--source <src>] --apply` (idempotent remove).
 *
 * The mutating verbs PREVIEW by default in the CLI and only write under `--apply`.
 * These web wrappers are the APPLY path (the UI confirms before calling), so they
 * pass `--apply` — mirroring the slices subscribe/unsubscribe convention. Each
 * returns the raw parsed C3 envelope (fail-soft, never throws).
 *
 * NOTE: server-only module (runForge → node:child_process). Import from server
 * components and route handlers only — never from a "use client" boundary.
 */
import type { BridgeEnvelope, CompositionData } from "@/lib/types";

import { runForge } from "./run";

/** `forge compose list --json` — the adopted entries joined to records (read-only). */
export function getComposition(): Promise<BridgeEnvelope<CompositionData>> {
  return runForge<CompositionData>("compose", ["list"]);
}

/**
 * `forge compose adopt <uid> [--source <sourceId>] --apply` — record a per-project
 * adoption of a read-view resource (add { uid, sourceId } to .forge/composition.json).
 * Pass `sourceId` to adopt a specific source's copy; omit (or pass null) for the
 * library-local copy. Idempotent; additive; never touches the library.
 */
export function compositionAdopt(
  uid: string,
  sourceId?: string | null,
): Promise<BridgeEnvelope> {
  const args = ["adopt", uid];
  if (sourceId) args.push("--source", sourceId);
  args.push("--apply");
  return runForge("compose", args);
}

/**
 * `forge compose remove <uid> [--source <sourceId>] --apply` — remove the matching
 * adopted entry from .forge/composition.json. Pass `sourceId` to target a specific
 * source's copy; omit (or pass null) for the library-local copy. Idempotent
 * (absent = no-op).
 */
export function compositionRemove(
  uid: string,
  sourceId?: string | null,
): Promise<BridgeEnvelope> {
  const args = ["remove", uid];
  if (sourceId) args.push("--source", sourceId);
  args.push("--apply");
  return runForge("compose", args);
}
