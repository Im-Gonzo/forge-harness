/**
 * forge-bridge/lock — the per-project LOCKFILE surface (ADR-0022).
 *
 * Wraps `forge lock <verb>` against the ACTIVE harness root (the bridge spawns with
 * cwd = getActiveRoot()). `forge.lock` is the RESOLVED per-project COMPOSITION
 * manifest — the project analogue of `package-lock.json`: it JOINs the adopted set
 * (composition, ADR-0019) with the tailoring overlays (ADR-0021), the adjudication
 * choices (ADR-0020), and each entry's pinned version/commit, plus a DETERMINISTIC
 * content hash over the resolved entries. It lives at the ACTIVE PROJECT ROOT
 * (<activeRoot>/forge.lock), is git-committable, and is DISTINCT from
 * .forge/sources.lock (which pins SOURCE commits and is machine-local).
 *
 *   - getLock()       — `lock show` (read-only; exists/committed/inSync + the lock contents).
 *   - lockWrite()     — `lock write --apply` (RESOLVE the composition + write forge.lock atomically).
 *   - getLockDiff()   — `lock diff` (read-only; +/~/- changes vs the freshly-resolved composition).
 *
 * MANIFEST-ONLY. `lock write` writes ONLY the forge.lock manifest — it NEVER
 * materializes/modifies any real .claude/ file, the library, or any resource
 * content (that is the bootstrap composer's job, out of scope). The CLI `write`
 * verb PREVIEWS by default and writes only under `--apply`; this web wrapper is the
 * APPLY path (the UI confirms before calling), so it passes `--apply` — mirroring
 * the Slice 2 composition / Slice 4 tailoring convention. Each returns the raw
 * parsed C3 envelope (fail-soft, never throws).
 *
 * NOTE: server-only module (runForge → node:child_process). Import from server
 * components and route handlers only — never from a "use client" boundary.
 */
import type {
  BridgeEnvelope,
  LockDiffData,
  LockShowData,
} from "@/lib/types";

import { runForge } from "./run";

/** `forge lock show --json` — exists/committed/inSync + the lock contents (read-only). */
export function getLock(): Promise<BridgeEnvelope<LockShowData>> {
  return runForge<LockShowData>("lock", ["show"]);
}

/**
 * `forge lock write --apply` — RESOLVE the composition (the adopted set JOINed with
 * tailoring overlays + adjudication choices + pinned version/commit), compute the
 * entries + deterministic hash, and write <activeRoot>/forge.lock atomically.
 * Idempotent (same composition → same hash). MANIFEST-ONLY — never touches .claude/,
 * the library, or the composition/adjudication/tailoring stores it reads.
 */
export function lockWrite(): Promise<BridgeEnvelope> {
  return runForge("lock", ["write", "--apply"]);
}

/**
 * `forge lock diff --json` — compare the CURRENT forge.lock against the
 * freshly-resolved composition and emit per-entry changes ("+" newly resolved, "-"
 * no longer resolved, "~" version/overlay/adjudication/commit changed). Read-only.
 */
export function getLockDiff(): Promise<BridgeEnvelope<LockDiffData>> {
  return runForge<LockDiffData>("lock", ["diff"]);
}
