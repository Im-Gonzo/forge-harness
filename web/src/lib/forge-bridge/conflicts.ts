/**
 * forge-bridge/conflicts — the per-project CONFLICT + ADJUDICATION surface (ADR-0020).
 *
 * Wraps `forge conflict <verb>` against the ACTIVE harness root (the bridge spawns
 * with cwd = getActiveRoot()). A CONFLICT is exactly a uid that resolves to >= 2
 * DISTINCT candidate records in the project's catalog READ-VIEW (library-local ∪
 * subscribed slices) — i.e. the dedup `uid-collision` / `near-dup` classes. The
 * conflict set is DERIVED, never stored; the CLI deterministically COLLECTS it and
 * CONSUMES already-recorded judge verdicts (sidecar) + eval scores (never invoking
 * any model, never fabricating a score). ADJUDICATION POLICY is per-criticality
 * { normal, compliance, safety }, each "auto" | "block" (DEFAULT all-block),
 * persisted under the active root in .forge/adjudication.json.
 *
 *   - getConflicts()                  — `conflict list` (read-only; conflicts + counts + policy).
 *   - conflictResolve(uid, winner)    — `conflict resolve <uid> --winner <s|"library"> --apply`
 *                                       (human T2 pick; on --apply also updates the composition).
 *   - conflictSetPolicy(partial)      — `conflict policy [--set k=v ...] --apply` (set per-crit policy).
 *
 * The mutating verbs PREVIEW by default in the CLI and only write under `--apply`.
 * These web wrappers are the APPLY path (the UI confirms before calling), so they
 * pass `--apply` — mirroring the Slice 2 composition adopt/remove convention. Each
 * returns the raw parsed C3 envelope (fail-soft, never throws).
 *
 * RESPECT BR-CAT-003: a resolve that would REPLACE an already-admitted LIBRARY
 * resource is a T2 human action — the CLI records the human's explicit `--winner`
 * pick and never self-applies a library replace, even under policy "auto". This
 * wrapper only ever forwards the human's explicit winner; it never picks one.
 *
 * NOTE: server-only module (runForge → node:child_process). Import from server
 * components and route handlers only — never from a "use client" boundary.
 */
import type {
  AdjudicationPolicy,
  BridgeEnvelope,
  ConflictsData,
} from "@/lib/types";

import { runForge } from "./run";

/** `forge conflict list --json` — the read-view conflicts + counts + policy (read-only). */
export function getConflicts(): Promise<BridgeEnvelope<ConflictsData>> {
  return runForge<ConflictsData>("conflict", ["list"]);
}

/**
 * `forge conflict resolve <uid> --winner <sourceId|"library"> --apply` — record the
 * human's T2 pick of which candidate wins this conflict (BR-CAT-013). The `winner`
 * is a sourceId, OR the literal "library" for the library-local copy. On --apply the
 * CLI ALSO updates the composition (.forge/composition.json) so the winner's
 * (uid, sourceId) is adopted and the losing peers for that uid are removed. Idempotent.
 */
export function conflictResolve(
  uid: string,
  winner: string,
): Promise<BridgeEnvelope> {
  return runForge("conflict", ["resolve", uid, "--winner", winner, "--apply"]);
}

/**
 * `forge conflict policy [--set normal=…] [--set compliance=…] [--set safety=…] --apply`
 * — set the per-criticality adjudication policy (BR-CAT-012). Each provided key is
 * forwarded as a `--set <key>=<value>` flag; absent keys are left untouched. Values
 * are "auto" | "block". With no keys this is a no-op set (the CLI validates values).
 */
export function conflictSetPolicy(
  partial: Partial<AdjudicationPolicy>,
): Promise<BridgeEnvelope> {
  const args = ["policy"];
  for (const key of ["normal", "compliance", "safety"] as const) {
    const value = partial[key];
    if (value !== undefined) args.push("--set", `${key}=${value}`);
  }
  args.push("--apply");
  return runForge("conflict", args);
}
