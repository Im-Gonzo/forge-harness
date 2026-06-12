/**
 * forge-bridge/sources — the federated SOURCE-registry surface (ADR-0017).
 *
 * Wraps `forge source <verb>` against the ACTIVE harness root (the bridge spawns
 * with cwd = getActiveRoot()). The source registry is the manifest of external
 * Git/local repos the catalog can sync from (manifests/sources.json):
 *
 *   - getSources()           — `source list` (read-only).
 *   - sourceAdd(id,url,…)    — `source add <id> <url> [--ref <r>] [--kind <k>] --apply`.
 *   - sourceSync(id?)        — `source sync [id] --apply` (clone+read only; pins the lock).
 *   - sourceTrust(id)        — `source trust <id> --apply` (untrusted → reviewed).
 *   - sourceRemove(id)       — `source remove <id> --apply`.
 *
 * The mutating verbs PREVIEW by default in the CLI and only write under `--apply`.
 * These web wrappers are the APPLY path (the UI confirms before calling), so they
 * pass `--apply` — mirroring the existing memory `{ apply }` convention (append the
 * flag to args). Each returns the raw parsed C3 envelope (fail-soft, never throws).
 *
 * NOTE: server-only module (runForge → node:child_process). Import from server
 * components and route handlers only — never from a "use client" boundary.
 */
import type { BridgeEnvelope, SourceKind, SourceListData } from "@/lib/types";

import { runForge } from "./run";

/** `forge source list --json` — enumerate registered sources (read-only). */
export function getSources(): Promise<BridgeEnvelope<SourceListData>> {
  return runForge<SourceListData>("source", ["list"]);
}

/**
 * `forge source add <id> <url> [--ref <r>] [--kind <k>] --apply` — register a new
 * source. Defaults (CLI-side): ref "main", kind "git", trust "untrusted". A
 * duplicate id is skipped + WARN (additive, never clobber).
 */
export function sourceAdd(
  id: string,
  url: string,
  opts?: { ref?: string; kind?: SourceKind },
): Promise<BridgeEnvelope> {
  const args = ["add", id, url];
  if (opts?.ref) args.push("--ref", opts.ref);
  if (opts?.kind) args.push("--kind", opts.kind);
  args.push("--apply");
  return runForge("source", args);
}

/**
 * `forge source sync [id] --apply` — shallow-clone source(s) into the machine-local
 * cache and pin the resolved commit in .forge/sources.lock. Omit `id` to sync all.
 * Clone + read ONLY — never executes fetched code.
 */
export function sourceSync(id?: string): Promise<BridgeEnvelope> {
  const args = ["sync"];
  if (id) args.push(id);
  args.push("--apply");
  return runForge("source", args);
}

/**
 * `forge source trust <id> --apply` — flip a source untrusted → reviewed
 * (security-gated; trust gates admission of executable kinds).
 */
export function sourceTrust(id: string): Promise<BridgeEnvelope> {
  return runForge("source", ["trust", id, "--apply"]);
}

/** `forge source remove <id> --apply` — drop a source from the manifest. */
export function sourceRemove(id: string): Promise<BridgeEnvelope> {
  return runForge("source", ["remove", id, "--apply"]);
}
