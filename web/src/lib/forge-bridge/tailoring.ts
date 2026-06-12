/**
 * forge-bridge/tailoring — the per-project TAILORING + OVERLAYS surface (ADR-0021).
 *
 * Wraps `forge tailor <verb>` against the ACTIVE harness root (the bridge spawns
 * with cwd = getActiveRoot()). A TAILORING OVERLAY is a per-adopted-resource
 * modifier: only an ADOPTED resource (in .forge/composition.json) may be tailored.
 * Overlays are RECORDED INTENTIONS — they are NOT applied to real .claude/ files
 * here (that is Slice 5 compose --write territory). The CLI computes a deterministic
 * RESOLVED PREVIEW (a display-only VIEW) by folding overlays over the base catalog
 * record, never mutating the library or any file outside the tailoring store.
 * Tailoring lives in a SEPARATE additive store (.forge/tailoring.json,
 * "forge.tailoring.v1") — it never touches Slice 2's composition.json schema.
 *
 *   - getTailoring()                       — `tailor list` (read-only; entries joined to records + resolved).
 *   - tailorAdd(uid, type, detail, src?)   — `tailor add <uid> --type <t> --detail <s> [--source <s>] --apply`.
 *   - tailorRemove(uid, type, detail?, src?) — `tailor remove <uid> --type <t> [--detail <s>] [--source <s>] --apply`.
 *
 * The mutating verbs PREVIEW by default in the CLI and only write under `--apply`.
 * These web wrappers are the APPLY path (the UI confirms before calling), so they
 * pass `--apply` — mirroring the Slice 2 composition / Slice 3 conflicts convention.
 * Each returns the raw parsed C3 envelope (fail-soft, never throws).
 *
 * `add` validates the resource is ADOPTED and the type is valid, then records the
 * overlay (deduped per the rules: pin/override/disable/fork keep the latest detail
 * per type; layer/gate dedupe by (type, detail)). `detail` is optional for
 * fork/disable. `remove` removes matching overlay(s) (by type, optionally narrowed
 * by detail); idempotent.
 *
 * NOTE: server-only module (runForge → node:child_process). Import from server
 * components and route handlers only — never from a "use client" boundary.
 */
import type { BridgeEnvelope, TailoringData } from "@/lib/types";

import { runForge } from "./run";

/** `forge tailor list --json` — the tailored entries joined to records + resolved (read-only). */
export function getTailoring(): Promise<BridgeEnvelope<TailoringData>> {
  return runForge<TailoringData>("tailor", ["list"]);
}

/**
 * `forge tailor add <uid> --type <type> [--detail <detail>] [--source <sourceId>] --apply`
 * — record an overlay on an adopted resource. `type` is pin | override | layer |
 * gate | fork | disable; `detail` is the type-specific short string (optional for
 * fork/disable — pass an empty/undefined detail to omit the flag). Pass `sourceId`
 * to target a specific source's copy; omit (or pass null) for the library-local copy.
 * Idempotent per the dedup rules; additive; never touches the library or real files.
 */
export function tailorAdd(
  uid: string,
  type: string,
  detail?: string,
  sourceId?: string | null,
): Promise<BridgeEnvelope> {
  const args = ["add", uid, "--type", type];
  if (detail) args.push("--detail", detail);
  if (sourceId) args.push("--source", sourceId);
  args.push("--apply");
  return runForge("tailor", args);
}

/**
 * `forge tailor remove <uid> --type <type> [--detail <detail>] [--source <sourceId>] --apply`
 * — remove matching overlay(s) from an adopted resource: by `type`, optionally
 * narrowed by `detail` (omit detail to remove all overlays of that type). Pass
 * `sourceId` to target a specific source's copy; omit (or pass null) for the
 * library-local copy. Idempotent (absent = no-op).
 */
export function tailorRemove(
  uid: string,
  type: string,
  detail?: string,
  sourceId?: string | null,
): Promise<BridgeEnvelope> {
  const args = ["remove", uid, "--type", type];
  if (detail) args.push("--detail", detail);
  if (sourceId) args.push("--source", sourceId);
  args.push("--apply");
  return runForge("tailor", args);
}
