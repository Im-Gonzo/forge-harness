/**
 * forge-bridge/fleet-health — the L0 BIRDS-EYE data layer.
 *
 * A cross-project roll-up: for EVERY scanned harness (the filesystem `.claude/`
 * dirs `harness.scanProjects` finds — independent of the opt-in fleet INDEX),
 * compute the three headline health metrics by spawning the forge CLI scoped to
 * that project's root: registry size, validation status, and the always-on token
 * floor. This is the data behind the /fleet birds-eye overview.
 *
 * SCOPING: each metric runs `runForge(..., { cwd: harness.root })` — harness.root
 * is the project's `<project>/.claude` dir, so the CLI resolves its registry
 * against THAT project (not the active-cookie scope). This OVERRIDES runForge's
 * default active-root scoping precisely because the birds-eye assesses many
 * projects in one render, regardless of which one is "active".
 *
 * FAIL-SOFT: every metric degrades to `null` on any failure (a bridgeError
 * envelope, a non-ok run, or a missing field) and NEVER throws — one degraded
 * project must not blank the whole overview.
 *
 * COST NOTE: this is heavy — ~3 forge spawns × N projects per render, run in
 * parallel. Acceptable for a LOCAL birds-eye over ~15 projects; it could be
 * cached/lazied (per-project, keyed on harness.id) later if N grows.
 *
 * NOTE: server-only module (runForge → child_process). Import from server
 * components and route handlers only — never a "use client" boundary. Import
 * from THIS specific path, not the barrel (the barrel's `ProjectHealth` is the
 * unrelated fleet-marker type from ./fleet).
 */
import { scanProjects, type Harness } from "@/lib/harness";
import type { ArtifactKind, RegistryLsData } from "@/lib/types";

import { runForge } from "./run";
import type { AnalyzeData } from "@/app/budget/analyze-types";

// ──────────────────────────────────────────────────────────────────────────
// Type — the per-project birds-eye health row
// ──────────────────────────────────────────────────────────────────────────

/**
 * One project's birds-eye health: the harness it describes plus the three
 * headline metrics. Each metric is independently fail-soft — `null` means that
 * metric's forge call failed for this project (the row still renders).
 */
export interface ProjectHealth {
  /** The scanned harness this row describes. */
  harness: Harness;
  /** Total artifacts from `registry build`; null if that call failed. */
  artifactCount: number | null;
  /** Per-kind artifact counts from `registry build`; {} if that call failed. */
  byKind: Partial<Record<ArtifactKind, number>>;
  /** True when `validate` reported zero errors; null if that call failed. */
  validateOk: boolean | null;
  /** `validate` error count; null if that call failed. */
  errors: number | null;
  /** `validate` warning count; null if that call failed. */
  warnings: number | null;
  /** Always-on token floor from `analyze` (alwaysOnTotal); null if it failed. */
  alwaysOnTokens: number | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-project health — three forge spawns in parallel, each fail-soft
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute one project's birds-eye health. Runs `registry build`, `validate`, and
 * `analyze` IN PARALLEL, each spawned with `cwd = harness.root` so the CLI scopes
 * to THAT project. Each metric is fail-soft: a degraded envelope (bridgeError or
 * `ok:false`) yields `null` for that metric and never throws.
 */
export async function projectHealth(harness: Harness): Promise<ProjectHealth> {
  const cwd = harness.root;
  const [registryEnv, validateEnv, analyzeEnv] = await Promise.all([
    runForge<RegistryLsData>("registry", ["build"], { cwd }),
    runForge("validate", [], { cwd }),
    runForge<AnalyzeData>("analyze", [], { cwd }),
  ]);

  // Registry → artifactCount + byKind (null/empty when the build failed).
  let artifactCount: number | null = null;
  const byKind: Partial<Record<ArtifactKind, number>> = {};
  if (registryEnv.ok) {
    const artifacts = registryEnv.data.artifacts ?? [];
    artifactCount = artifacts.length;
    for (const a of artifacts) {
      byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    }
  }

  // Validate → ok / errors / warnings from the envelope summary.
  let validateOk: boolean | null = null;
  let errors: number | null = null;
  let warnings: number | null = null;
  if (validateEnv.ok) {
    errors = validateEnv.summary.errors;
    warnings = validateEnv.summary.warnings;
    validateOk = errors === 0;
  }

  // Analyze → the always-on token floor.
  const alwaysOnTokens = analyzeEnv.ok ? analyzeEnv.data.alwaysOnTotal : null;

  return {
    harness,
    artifactCount,
    byKind,
    validateOk,
    errors,
    warnings,
    alwaysOnTokens,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Fleet scan — health for every scanned project, in parallel
// ──────────────────────────────────────────────────────────────────────────

/**
 * Birds-eye over the whole fleet: scan `scanRoot` for project harnesses
 * (`harness.scanProjects`), then compute `projectHealth` for each IN PARALLEL.
 * Sorted by label (scanProjects already sorts; we re-sort defensively). Bounded
 * by N projects — Promise.all is fine for the ~15-project local case.
 *
 * COST: ~3 forge spawns × N projects per call (see module note). Could be
 * cached/lazied per project later.
 */
export async function scanFleet(scanRoot?: string): Promise<ProjectHealth[]> {
  const harnesses = await scanProjects(scanRoot);
  const rows = await Promise.all(harnesses.map((h) => projectHealth(h)));
  return rows.sort((a, b) => a.harness.label.localeCompare(b.harness.label));
}
