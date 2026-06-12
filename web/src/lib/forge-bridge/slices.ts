/**
 * forge-bridge/slices — the per-project SLICE subscription surface (ADR-0018).
 *
 * Wraps `forge slice <verb>` against the ACTIVE harness root (the bridge spawns
 * with cwd = getActiveRoot()). A SLICE is a named group of ONE source's catalog
 * records, grouped by registry kind ("<sourceId>/<kind>"). SUBSCRIPTIONS are
 * per-active-root project state (.forge/subscriptions.json): which slice ids the
 * project opted into. New slices default UNSUBSCRIBED (opt-in). The catalog
 * read-view = library-local ∪ records whose slice is subscribed.
 *
 *   - getSlices()             — `slice list` (read-only; sources → slices + subscribed).
 *   - sliceSubscribe(id)      — `slice subscribe <sliceId> --apply` (idempotent add).
 *   - sliceUnsubscribe(id)    — `slice unsubscribe <sliceId> --apply` (idempotent remove).
 *
 * The mutating verbs PREVIEW by default in the CLI and only write under `--apply`.
 * These web wrappers are the APPLY path (the UI confirms before calling), so they
 * pass `--apply` — mirroring the existing source/memory `{ apply }` convention.
 * Each returns the raw parsed C3 envelope (fail-soft, never throws).
 *
 * NOTE: server-only module (runForge → node:child_process). Import from server
 * components and route handlers only — never from a "use client" boundary.
 */
import type { BridgeEnvelope, SliceListData } from "@/lib/types";

import { runForge } from "./run";

/** `forge slice list --json` — enumerate each source's slices (read-only). */
export function getSlices(): Promise<BridgeEnvelope<SliceListData>> {
  return runForge<SliceListData>("slice", ["list"]);
}

/**
 * `forge slice subscribe <sliceId> --apply` — opt the active project into a slice
 * (add the id to .forge/subscriptions.json#subscribed). Idempotent; additive.
 */
export function sliceSubscribe(sliceId: string): Promise<BridgeEnvelope> {
  return runForge("slice", ["subscribe", sliceId, "--apply"]);
}

/**
 * `forge slice unsubscribe <sliceId> --apply` — opt the active project out of a
 * slice (remove the id from .forge/subscriptions.json#subscribed). Idempotent.
 */
export function sliceUnsubscribe(sliceId: string): Promise<BridgeEnvelope> {
  return runForge("slice", ["unsubscribe", sliceId, "--apply"]);
}
